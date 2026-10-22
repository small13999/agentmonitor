import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Project, Session, SessionRuntime, Task, TaskDetail, TaskNotes, TaskState, TaskSummary, Topic, TopicLink } from "../../shared/api.ts";

export type { Project, Session, SessionRuntime, Task, TaskDetail, TaskNotes, TaskState, TaskSummary, Topic, TopicLink };

/** TOPIC-2 and TASK-7: a status is a short current-state note, not a document. */
export const STATUS_MAX_LINES = 50;

/** An agent is the session whose socket it talks through. */
export type Principal = { kind: "human" } | { kind: "agent"; sessionId: string };

/** A refused store operation; `status` is the HTTP status the API answers with. */
export class StoreError extends Error {
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(status: number, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const TASK_STATES: readonly TaskState[] = ["open", "in_progress", "in_review", "done", "cancelled"];

function isTaskState(value: unknown): value is TaskState {
  return TASK_STATES.some((state) => state === value);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  repo_path TEXT,
  host_sessions INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT '',
  status_revision INTEGER NOT NULL DEFAULT 0,
  UNIQUE (project_id, name)
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,
  branch TEXT,
  base_ref TEXT,
  status TEXT NOT NULL DEFAULT '',
  status_revision INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  notes_revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS task_topics (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  topic_id TEXT NOT NULL REFERENCES topics(id),
  linked_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, topic_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  name TEXT NOT NULL,
  branch TEXT,
  base_ref TEXT,
  machine TEXT,
  runtime TEXT NOT NULL DEFAULT 'container',
  checkout INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
`;

type Row = Record<string, unknown>;

function project(row: Row): Project {
  return {
    id: String(row.id),
    name: String(row.name),
    repoPath: row.repo_path === null ? null : String(row.repo_path),
    hostSessions: Number(row.host_sessions) === 1,
    createdAt: Number(row.created_at),
  };
}

function topic(row: Row): Topic {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name),
    createdAt: Number(row.created_at),
    status: String(row.status),
    statusRevision: Number(row.status_revision),
  };
}

function task(row: Row): Task {
  if (!isTaskState(row.state)) throw new Error(`task ${String(row.id)} has unknown state ${String(row.state)}`);
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    title: String(row.title),
    description: String(row.description),
    state: row.state,
    branch: row.branch === null ? null : String(row.branch),
    baseRef: row.base_ref === null ? null : String(row.base_ref),
    status: String(row.status),
    statusRevision: Number(row.status_revision),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function session(row: Row): Session {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    taskId: String(row.task_id),
    name: String(row.name),
    branch: row.branch === null ? null : String(row.branch),
    baseRef: row.base_ref === null ? null : String(row.base_ref),
    machine: row.machine === null ? null : String(row.machine),
    runtime: row.runtime === "host" ? "host" : "container",
    checkout: Number(row.checkout) === 1,
    model: row.model === null ? null : String(row.model),
    startedAt: Number(row.started_at),
    endedAt: row.ended_at === null ? null : Number(row.ended_at),
  };
}

/** TOPIC-2/TASK-7: a status longer than the limit is refused with its length. */
function checkStatusLength(status: string): void {
  const lines = status.replace(/\n$/, "").split("\n").length;
  if (lines > STATUS_MAX_LINES) {
    throw new StoreError(400, `status has ${lines} lines; the limit is ${STATUS_MAX_LINES}`, { lines, limit: STATUS_MAX_LINES });
  }
}

/**
 * One store: a single SQLite file owned by one gateway process. Every read and
 * write takes the caller's principal; an agent sees only its session's
 * project, and records outside it answer 404 rather than revealing they exist.
 */
export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    this.migrateSessionsToTasks();
    // HOST-1: stores from before host sessions.
    this.addColumn("projects", "host_sessions", "INTEGER NOT NULL DEFAULT 0");
    this.addColumn("sessions", "runtime", "TEXT NOT NULL DEFAULT 'container'");
    this.addColumn("sessions", "checkout", "INTEGER NOT NULL DEFAULT 0");
  }

  private addColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((row) => String(row.name));
    if (!columns.includes(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  close(): void {
    this.db.close();
  }

  /**
   * TASK-10: a store from before tasks has sessions with their own topic links and notes.
   * Each such session becomes a task with its name, branch, topic links, and notes; the
   * session-level tables go away.
   */
  private migrateSessionsToTasks(): void {
    const columns = this.db.prepare("SELECT name FROM pragma_table_info('sessions')").all().map((row) => String(row.name));
    if (columns.includes("task_id")) return;
    const hasTable = (name: string) =>
      this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
    this.transaction(() => {
      this.db.exec("ALTER TABLE sessions ADD COLUMN task_id TEXT REFERENCES tasks(id)");
      const insert = this.db.prepare(
        "INSERT INTO tasks (id, project_id, title, state, branch, base_ref, notes, notes_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const notesOf = hasTable("session_notes") ? this.db.prepare("SELECT text, revision FROM session_notes WHERE session_id = ?") : null;
      for (const row of this.db.prepare("SELECT * FROM sessions ORDER BY started_at").all()) {
        const id = randomUUID();
        const notes = notesOf?.get(row.id);
        const startedAt = Number(row.started_at);
        insert.run(
          id,
          String(row.project_id),
          String(row.name),
          row.ended_at === null ? "in_progress" : "done",
          row.branch === null ? null : String(row.branch),
          row.base_ref === null ? null : String(row.base_ref),
          notes === undefined ? "" : String(notes.text),
          notes === undefined ? 0 : Number(notes.revision),
          startedAt,
          row.ended_at === null ? startedAt : Number(row.ended_at),
        );
        this.db.prepare("UPDATE sessions SET task_id = ? WHERE id = ?").run(id, String(row.id));
      }
      if (hasTable("session_topics")) {
        this.db.exec(
          "INSERT INTO task_topics (task_id, topic_id, linked_at) SELECT s.task_id, st.topic_id, st.linked_at FROM session_topics st JOIN sessions s ON s.id = st.session_id",
        );
        this.db.exec("DROP TABLE session_topics");
      }
      if (hasTable("session_notes")) this.db.exec("DROP TABLE session_notes");
    });
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** The project an agent principal is confined to; null for humans. */
  private scope(principal: Principal): string | null {
    if (principal.kind === "human") return null;
    const row = this.db.prepare("SELECT project_id FROM sessions WHERE id = ?").get(principal.sessionId);
    if (row === undefined) throw new StoreError(403, "session credential is no longer valid");
    return String(row.project_id);
  }

  private requireHuman(principal: Principal): void {
    if (principal.kind !== "human") throw new StoreError(403, "only a human can do this");
  }

  private visibleProject(principal: Principal, projectId: string): Project {
    const scope = this.scope(principal);
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
    if (row === undefined || (scope !== null && scope !== projectId)) {
      throw new StoreError(404, `project ${projectId} not found`);
    }
    return project(row);
  }

  private visibleTopic(principal: Principal, topicId: string): Topic {
    const row = this.db.prepare("SELECT * FROM topics WHERE id = ?").get(topicId);
    const scope = this.scope(principal);
    if (row === undefined || (scope !== null && scope !== row.project_id)) {
      throw new StoreError(404, `topic ${topicId} not found`);
    }
    return topic(row);
  }

  private visibleTask(principal: Principal, taskId: string): Task {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    const scope = this.scope(principal);
    if (row === undefined || (scope !== null && scope !== row.project_id)) {
      throw new StoreError(404, `task ${taskId} not found`);
    }
    return task(row);
  }

  private visibleSession(principal: Principal, sessionId: string): Session {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
    const scope = this.scope(principal);
    if (row === undefined || (scope !== null && scope !== row.project_id)) {
      throw new StoreError(404, `session ${sessionId} not found`);
    }
    return session(row);
  }

  private topicsOf(taskId: string): Topic[] {
    return this.db.prepare(
      "SELECT t.* FROM topics t JOIN task_topics tt ON tt.topic_id = t.id WHERE tt.task_id = ? ORDER BY tt.linked_at",
    ).all(taskId).map(topic);
  }

  private runningSessionOf(taskId: string): Session | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE task_id = ? AND ended_at IS NULL").get(taskId);
    return row === undefined ? null : session(row);
  }

  whoami(principal: Principal): { kind: "human" } | { kind: "agent"; project: Project; session: Session; task: Task } {
    if (principal.kind === "human") return { kind: "human" };
    const own = this.visibleSession(principal, principal.sessionId);
    return { kind: "agent", project: this.visibleProject(principal, own.projectId), session: own, task: this.visibleTask(principal, own.taskId) };
  }

  listProjects(principal: Principal): Project[] {
    const scope = this.scope(principal);
    const rows = scope === null
      ? this.db.prepare("SELECT * FROM projects ORDER BY name").all()
      : this.db.prepare("SELECT * FROM projects WHERE id = ?").all(scope);
    return rows.map(project);
  }

  getProject(principal: Principal, projectId: string): Project {
    return this.visibleProject(principal, projectId);
  }

  getSession(principal: Principal, sessionId: string): { session: Session; task: Task } {
    const found = this.visibleSession(principal, sessionId);
    return { session: found, task: this.visibleTask(principal, found.taskId) };
  }

  createProject(principal: Principal, input: { name: string; repoPath?: string; hostSessions?: boolean }): Project {
    this.requireHuman(principal);
    if (this.db.prepare("SELECT 1 FROM projects WHERE name = ?").get(input.name) !== undefined) {
      throw new StoreError(409, `project "${input.name}" already exists`);
    }
    const created: Project = {
      id: randomUUID(),
      name: input.name,
      repoPath: input.repoPath ?? null,
      hostSessions: input.hostSessions ?? false,
      createdAt: Date.now(),
    };
    this.db.prepare("INSERT INTO projects (id, name, repo_path, host_sessions, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(created.id, created.name, created.repoPath, created.hostSessions ? 1 : 0, created.createdAt);
    return created;
  }

  /** HOST-1: only a human allows or stops host sessions in a project. */
  updateProject(principal: Principal, projectId: string, input: { hostSessions: boolean }): Project {
    this.requireHuman(principal);
    this.visibleProject(principal, projectId);
    this.db.prepare("UPDATE projects SET host_sessions = ? WHERE id = ?").run(input.hostSessions ? 1 : 0, projectId);
    return this.visibleProject(principal, projectId);
  }

  listTopics(principal: Principal, projectId: string): Topic[] {
    this.visibleProject(principal, projectId);
    return this.db.prepare("SELECT * FROM topics WHERE project_id = ? ORDER BY name").all(projectId).map(topic);
  }

  createTopic(principal: Principal, projectId: string, name: string): Topic {
    this.visibleProject(principal, projectId);
    if (this.db.prepare("SELECT 1 FROM topics WHERE project_id = ? AND name = ?").get(projectId, name) !== undefined) {
      throw new StoreError(409, `topic "${name}" already exists in this project`);
    }
    const created: Topic = { id: randomUUID(), projectId, name, createdAt: Date.now(), status: "", statusRevision: 0 };
    this.db.prepare("INSERT INTO topics (id, project_id, name, created_at) VALUES (?, ?, ?, ?)")
      .run(created.id, projectId, name, created.createdAt);
    return created;
  }

  /** TOPIC-7: the topic and its linked tasks, in the order they were linked. */
  getTopic(principal: Principal, topicId: string): { topic: Topic; tasks: TopicLink[] } {
    const found = this.visibleTopic(principal, topicId);
    const links = this.db.prepare(
      "SELECT task_id, topic_id, linked_at FROM task_topics WHERE topic_id = ? ORDER BY linked_at",
    ).all(topicId).map((row) => ({
      taskId: String(row.task_id),
      topicId: String(row.topic_id),
      linkedAt: Number(row.linked_at),
    }));
    return { topic: found, tasks: links };
  }

  /** TOPIC-2/TOPIC-3: bounded length, optimistic concurrency on the revision. */
  writeTopicStatus(principal: Principal, topicId: string, status: string, baseRevision: number): Topic {
    return this.transaction(() => {
      const current = this.visibleTopic(principal, topicId);
      checkStatusLength(status);
      if (baseRevision !== current.statusRevision) {
        throw new StoreError(409, `status changed since revision ${baseRevision}; re-read and merge`, {
          currentRevision: current.statusRevision,
          status: current.status,
        });
      }
      const next = current.statusRevision + 1;
      this.db.prepare("UPDATE topics SET status = ?, status_revision = ? WHERE id = ?").run(status, next, topicId);
      return { ...current, status, statusRevision: next };
    });
  }

  /** Every task of a project with its topics and running session, oldest first. */
  listTasks(principal: Principal, projectId: string): TaskSummary[] {
    this.visibleProject(principal, projectId);
    return this.db.prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at").all(projectId).map((row) => {
      const found = task(row);
      return { task: found, topics: this.topicsOf(found.id), sessionId: this.runningSessionOf(found.id)?.id ?? null };
    });
  }

  getTask(principal: Principal, taskId: string): TaskDetail {
    const found = this.visibleTask(principal, taskId);
    const sessions = this.db.prepare("SELECT * FROM sessions WHERE task_id = ? ORDER BY started_at DESC").all(taskId).map(session);
    return { task: found, topics: this.topicsOf(taskId), sessions };
  }

  /** TASK-3: a task starts open, without a session. */
  createTask(principal: Principal, projectId: string, input: { title: string; description?: string }): Task {
    this.visibleProject(principal, projectId);
    const now = Date.now();
    const created: Task = {
      id: randomUUID(),
      projectId,
      title: input.title,
      description: input.description ?? "",
      state: "open",
      branch: null,
      baseRef: null,
      status: "",
      statusRevision: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare("INSERT INTO tasks (id, project_id, title, description, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(created.id, projectId, created.title, created.description, created.state, now, now);
    return created;
  }

  /** Title, description, and the unfinished states; finishing a task is the gateway's job (TASK-9). */
  updateTask(principal: Principal, taskId: string, input: { title?: string; description?: string; state?: TaskState }): Task {
    return this.transaction(() => {
      const current = this.visibleTask(principal, taskId);
      const next: Task = {
        ...current,
        title: input.title ?? current.title,
        description: input.description ?? current.description,
        state: input.state ?? current.state,
        updatedAt: Date.now(),
      };
      this.db.prepare("UPDATE tasks SET title = ?, description = ?, state = ?, updated_at = ? WHERE id = ?")
        .run(next.title, next.description, next.state, next.updatedAt, taskId);
      return next;
    });
  }

  /** TASK-4: the task's branch, recorded when its first session creates it. */
  setTaskBranch(taskId: string, branch: string, baseRef: string): void {
    this.db.prepare("UPDATE tasks SET branch = ?, base_ref = ?, updated_at = ? WHERE id = ?").run(branch, baseRef, Date.now(), taskId);
  }

  /** TASK-2 and STORE-2: a task links to any number of topics, but only within its own project. */
  linkTopic(principal: Principal, taskId: string, topicId: string): Topic[] {
    const { projectId } = this.visibleTask(principal, taskId);
    const target = this.visibleTopic(principal, topicId);
    if (target.projectId !== projectId) throw new StoreError(404, `topic ${topicId} not found`);
    this.db.prepare("INSERT OR IGNORE INTO task_topics (task_id, topic_id, linked_at) VALUES (?, ?, ?)")
      .run(taskId, topicId, Date.now());
    return this.topicsOf(taskId);
  }

  unlinkTopic(principal: Principal, taskId: string, topicId: string): Topic[] {
    this.visibleTask(principal, taskId);
    this.visibleTopic(principal, topicId);
    this.db.prepare("DELETE FROM task_topics WHERE task_id = ? AND topic_id = ?").run(taskId, topicId);
    return this.topicsOf(taskId);
  }

  /** TASK-7: as a topic status (TOPIC-2/TOPIC-3). */
  writeTaskStatus(principal: Principal, taskId: string, status: string, baseRevision: number): Task {
    return this.transaction(() => {
      const current = this.visibleTask(principal, taskId);
      checkStatusLength(status);
      if (baseRevision !== current.statusRevision) {
        throw new StoreError(409, `status changed since revision ${baseRevision}; re-read and merge`, {
          currentRevision: current.statusRevision,
          status: current.status,
        });
      }
      const next: Task = { ...current, status, statusRevision: current.statusRevision + 1, updatedAt: Date.now() };
      this.db.prepare("UPDATE tasks SET status = ?, status_revision = ?, updated_at = ? WHERE id = ?")
        .run(status, next.statusRevision, next.updatedAt, taskId);
      return next;
    });
  }

  /** TASK-8: a task's notes; empty at revision 0 until first written. */
  getNotes(principal: Principal, taskId: string): TaskNotes {
    this.visibleTask(principal, taskId);
    const row = this.db.prepare("SELECT notes, notes_revision FROM tasks WHERE id = ?").get(taskId);
    return { text: String(row?.notes ?? ""), revision: Number(row?.notes_revision ?? 0) };
  }

  /** TASK-8: as a topic status (TOPIC-3), a write based on a stale revision is refused with the current notes. */
  writeNotes(principal: Principal, taskId: string, text: string, baseRevision: number): TaskNotes {
    return this.transaction(() => {
      const current = this.getNotes(principal, taskId);
      if (baseRevision !== current.revision) {
        throw new StoreError(409, `notes changed since revision ${baseRevision}; re-read and merge`, {
          currentRevision: current.revision,
          text: current.text,
        });
      }
      const next: TaskNotes = { text, revision: current.revision + 1 };
      this.db.prepare("UPDATE tasks SET notes = ?, notes_revision = ? WHERE id = ?").run(next.text, next.revision, taskId);
      return next;
    });
  }

  /** The running sessions of a project, oldest first. */
  listSessions(principal: Principal, projectId: string): Session[] {
    this.visibleProject(principal, projectId);
    return this.db.prepare("SELECT * FROM sessions WHERE project_id = ? AND ended_at IS NULL ORDER BY started_at")
      .all(projectId)
      .map(session);
  }

  /**
   * Records a running session of the task (TASK-5: refused while it has one) and moves an
   * open task in progress. Its worktree and container are the caller's job. A checkout
   * session (HOST-6) is a host session, one per project, and works on no branch of the task.
   */
  createSession(principal: Principal, taskId: string, input: { machine?: string; model?: string; runtime: SessionRuntime; checkout?: boolean }): Session {
    this.requireHuman(principal);
    return this.transaction(() => {
      const owner = this.visibleTask(principal, taskId);
      if (owner.state === "done" || owner.state === "cancelled") {
        throw new StoreError(409, `task "${owner.title}" is ${owner.state}; reopen it first`);
      }
      const running = this.runningSessionOf(taskId);
      if (running !== null) throw new StoreError(409, `task "${owner.title}" already has a running session`, { sessionId: running.id });
      if (input.runtime === "host" && !this.visibleProject(principal, owner.projectId).hostSessions) {
        throw new StoreError(403, "this project does not allow host sessions");
      }
      const checkout = input.checkout === true;
      if (checkout && input.runtime !== "host") throw new StoreError(400, "only a host session can work in the main checkout");
      const inCheckout = this.db.prepare("SELECT name FROM sessions WHERE project_id = ? AND checkout = 1 AND ended_at IS NULL").get(owner.projectId);
      if (checkout && inCheckout !== undefined) {
        throw new StoreError(409, `session ${String(inCheckout.name)} already works in the main checkout`);
      }
      const created: Session = {
        id: randomUUID(),
        projectId: owner.projectId,
        taskId,
        name: owner.title,
        branch: checkout ? null : owner.branch,
        baseRef: checkout ? null : owner.baseRef,
        machine: input.machine ?? null,
        runtime: input.runtime,
        checkout,
        model: input.model ?? null,
        startedAt: Date.now(),
        endedAt: null,
      };
      this.db.prepare(
        "INSERT INTO sessions (id, project_id, task_id, name, branch, base_ref, machine, runtime, checkout, model, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(created.id, created.projectId, taskId, created.name, created.branch, created.baseRef, created.machine, created.runtime, checkout ? 1 : 0, created.model, created.startedAt);
      if (owner.state === "open") {
        this.db.prepare("UPDATE tasks SET state = 'in_progress', updated_at = ? WHERE id = ?").run(created.startedAt, taskId);
      }
      return created;
    });
  }

  /** The branch a session's workspace was given; set before its worktree exists. */
  setSessionBranch(sessionId: string, branch: string, baseRef: string): void {
    this.db.prepare("UPDATE sessions SET branch = ?, base_ref = ? WHERE id = ?").run(branch, baseRef, sessionId);
  }

  /** Removes a session whose launch failed. */
  discardSession(sessionId: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
  }

  /** SESSION-8: an ended session keeps its record; its workspace is the caller's job. */
  endSession(principal: Principal, sessionId: string): Session {
    this.requireHuman(principal);
    return this.transaction(() => {
      const found = this.visibleSession(principal, sessionId);
      if (found.endedAt !== null) throw new StoreError(409, `session ${found.name} has already ended`);
      const endedAt = Date.now();
      this.db.prepare("UPDATE sessions SET ended_at = ? WHERE id = ?").run(endedAt, sessionId);
      return { ...found, endedAt };
    });
  }

  /** TASK-9: records a finished task; its session and branch are the caller's job. */
  finishTask(principal: Principal, taskId: string, state: "done" | "cancelled"): Task {
    this.requireHuman(principal);
    return this.transaction(() => {
      const current = this.visibleTask(principal, taskId);
      const next: Task = { ...current, state, updatedAt: Date.now() };
      this.db.prepare("UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?").run(state, next.updatedAt, taskId);
      return next;
    });
  }

  /** Sessions whose agent socket must be listening. */
  runningSessionIds(): string[] {
    return this.db.prepare("SELECT id FROM sessions WHERE ended_at IS NULL").all().map((row) => String(row.id));
  }
}
