import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  Actor, Automation, AutomationDetail, AutomationSummary, Comment, EndMode, Firing, FiringOutcome, FiringVerdict, FolderFile, HistoryEntry, HistoryEvent, Person, Project, PullRequest,
  RunOutcome, Session, SessionRuntime, Task, TaskDetail, TaskState, TaskSummary, Topic, TopicLink, Trigger,
} from "../../shared/api.ts";
import type { CloudflareTokens } from "../cloudflare.ts";
import { historyEvent, matchPeople, type ProjectRecords } from "./bundle.ts";

export type {
  Actor, Automation, AutomationDetail, AutomationSummary, Comment, EndMode, Firing, FiringOutcome, FiringVerdict, FolderFile, HistoryEntry, HistoryEvent, Person, Project,
  RunOutcome, Session, SessionRuntime, Task, TaskDetail, TaskState, TaskSummary, Topic, TopicLink, Trigger,
};

/** TOPIC-2 and TASK-7: a status is a short current-state note, not a document. */
export const STATUS_MAX_LINES = 50;

/** A person (PERSON-1; until login every human request is the store's owner), or the agent of a session. */
export type Principal = { kind: "human"; personId: string } | { kind: "agent"; sessionId: string };

/** UI-4 and PERSON-1: colours handed out in turn to topics and people. */
const PALETTE = ["#e5484d", "#f76b15", "#d6a000", "#46a758", "#12a594", "#0090ff", "#6e56cf", "#d6409f", "#ab4aba", "#978365"];

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

/**
 * SESSION-5: a session belongs to one task or one automation; AUTO-9: a session of an automation
 * is one of its runs (`is_run`), or a session on the automation that is none (AUTO-11).
 */
function sessionsTable(name: string): string {
  return `CREATE TABLE ${name} (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT REFERENCES tasks(id),
  automation_id TEXT REFERENCES automations(id),
  name TEXT NOT NULL,
  branch TEXT,
  base_ref TEXT,
  machine TEXT,
  runtime TEXT NOT NULL DEFAULT 'container',
  checkout INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  run_started_by_kind TEXT,
  run_started_by_id TEXT,
  run_trigger_context TEXT,
  run_outcome TEXT,
  run_ended_by_kind TEXT,
  run_ended_by_id TEXT,
  run_reason TEXT,
  is_run INTEGER NOT NULL DEFAULT 0,
  CHECK ((task_id IS NULL) != (automation_id IS NULL))
);`;
}

/** The columns every store's sessions had before automations (SESSION-5), which the migration copies. */
const TASK_SESSION_COLUMNS = "id, project_id, task_id, name, branch, base_ref, machine, runtime, checkout, model, started_at, ended_at";

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
  color TEXT NOT NULL DEFAULT '',
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
  assignee_id TEXT REFERENCES people(id),
  branch TEXT,
  base_ref TEXT,
  status TEXT NOT NULL DEFAULT '',
  status_revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS task_topics (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  topic_id TEXT NOT NULL REFERENCES topics(id),
  linked_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, topic_id)
);
${sessionsTable("IF NOT EXISTS sessions")}
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  owner INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  email TEXT
);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  author_kind TEXT NOT NULL,
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at INTEGER
);
CREATE INDEX IF NOT EXISTS comments_task ON comments (task_id, created_at);
CREATE TABLE IF NOT EXISTS folder_files (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  added_by_kind TEXT,
  added_by_id TEXT,
  added_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, path)
);
-- CLOUDFLARE-3: a project's Cloudflare tokens, which the gateway's broker uses for its sessions' agents (CLOUDFLARE-1/2).
CREATE TABLE IF NOT EXISTS cloudflare_tokens (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  read_token TEXT NOT NULL,
  write_token TEXT,
  updated_at INTEGER NOT NULL
);
-- AUTO-1: a project's automations; \`slug\` names their runs' branches (AUTO-9).
CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  model TEXT,
  end_mode TEXT NOT NULL DEFAULT 'finish',
  time_limit_minutes INTEGER NOT NULL DEFAULT 120,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (project_id, name),
  UNIQUE (project_id, slug)
);
-- AUTO-2, AUTO-8: an automation's schedules, each with an optional guard and check in its folder.
CREATE TABLE IF NOT EXISTS automation_triggers (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id),
  cron TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Europe/Budapest',
  guard_path TEXT,
  check_path TEXT,
  created_at INTEGER NOT NULL
);
-- AUTO-2, AUTO-8: each scheduled time of a trigger, once; a firing outlives its trigger, so no reference to it.
CREATE TABLE IF NOT EXISTS automation_firings (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id),
  trigger_id TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  fired_at INTEGER NOT NULL,
  caught_up INTEGER NOT NULL DEFAULT 0,
  guard_verdict TEXT,
  check_verdict TEXT,
  outcome TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(id),
  error TEXT,
  UNIQUE (trigger_id, scheduled_at)
);
CREATE INDEX IF NOT EXISTS automation_firings_automation ON automation_firings (automation_id, scheduled_at);
-- AUTO-1: an automation's folder, kept as a task's (folder_files).
CREATE TABLE IF NOT EXISTS automation_files (
  automation_id TEXT NOT NULL REFERENCES automations(id),
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  added_by_kind TEXT,
  added_by_id TEXT,
  added_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (automation_id, path)
);
`;

/** TASK-14: what happened to a task, appended as it happens; created on its own so old stores can be backfilled. */
const EVENTS_SCHEMA = `
CREATE TABLE task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  at INTEGER NOT NULL,
  actor_kind TEXT,
  actor_id TEXT,
  data TEXT NOT NULL
);
CREATE INDEX task_events_task ON task_events (task_id, at);
`;

type Row = Record<string, unknown>;

/** FOLDER-1: a file as its folder holds it now; `modifiedAt` is its modification time. */
export interface FolderEntry {
  path: string;
  size: number;
  contentType: string;
  modifiedAt: number;
}

/** FOLDER-1, AUTO-1: whose folder: a task's, or an automation's (shared by all its runs). */
export interface FolderOwner {
  kind: "task" | "automation";
  id: string;
}

/** SESSION-5: the folder a session works with: its task's, or its automation's for a run. */
export function folderOwnerOf(found: Session): FolderOwner {
  if (found.taskId !== null) return { kind: "task", id: found.taskId };
  if (found.automationId !== null) return { kind: "automation", id: found.automationId };
  throw new Error(`session ${found.id} belongs to no task and no automation`);
}

/** The table that records an owner's folder files, and its column naming the owner. */
function folderTable(owner: FolderOwner): { table: string; column: string } {
  return owner.kind === "task" ? { table: "folder_files", column: "task_id" } : { table: "automation_files", column: "automation_id" };
}

/** AUTO-1, AUTO-15: an automation's fields as people and agents set them; an absent one keeps its value, or its default. */
export interface AutomationInput {
  slug?: string;
  instructions?: string;
  model?: string | null;
  endMode?: EndMode;
  timeLimitMinutes?: number;
  enabled?: boolean;
}

/** AUTO-8: a trigger's fields besides its cron; a null guard or check path is none. */
export interface TriggerInput {
  timezone?: string;
  guardPath?: string | null;
  checkPath?: string | null;
}

function folderFile(row: Row): FolderFile {
  return {
    path: String(row.path),
    size: Number(row.size),
    contentType: String(row.content_type),
    addedBy: actorOfRow(row.added_by_kind, row.added_by_id),
    addedAt: Number(row.added_at),
    updatedAt: Number(row.updated_at),
  };
}

/** Project rows with whether the project has Cloudflare tokens (CLOUDFLARE-3), never the tokens. */
const PROJECT_ROWS = `SELECT p.*, c.project_id IS NOT NULL AS cloudflare_read, c.write_token IS NOT NULL AS cloudflare_write
  FROM projects p LEFT JOIN cloudflare_tokens c ON c.project_id = p.id`;

function project(row: Row): Project {
  return {
    id: String(row.id),
    name: String(row.name),
    repoPath: row.repo_path === null ? null : String(row.repo_path),
    hostSessions: Number(row.host_sessions) === 1,
    cloudflare: { read: Number(row.cloudflare_read) === 1, write: Number(row.cloudflare_write) === 1 },
    createdAt: Number(row.created_at),
  };
}

function topic(row: Row): Topic {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name),
    color: String(row.color),
    createdAt: Number(row.created_at),
    status: String(row.status),
    statusRevision: Number(row.status_revision),
  };
}

function person(row: Row): Person {
  return {
    id: String(row.id),
    name: String(row.name),
    email: row.email === null ? null : String(row.email),
    color: String(row.color),
    owner: Number(row.owner) === 1,
    createdAt: Number(row.created_at),
  };
}

/** An actor as the `*_kind` and `*_id` columns of a record keep it. */
function actorColumns(actor: Actor | null): [string | null, string | null] {
  if (actor === null) return [null, null];
  return [actor.kind, actor.kind === "person" ? actor.personId : actor.sessionId];
}

function actorOf(principal: Principal): Actor {
  return principal.kind === "human" ? { kind: "person", personId: principal.personId } : { kind: "agent", sessionId: principal.sessionId };
}

function actorOfRow(kind: unknown, id: unknown): Actor | null {
  if (kind === "person") return { kind: "person", personId: String(id) };
  if (kind === "agent") return { kind: "agent", sessionId: String(id) };
  return null;
}

function comment(row: Row): Comment {
  const author = actorOfRow(row.author_kind, row.author_id);
  if (author === null) throw new Error(`comment ${String(row.id)} has unknown author kind ${String(row.author_kind)}`);
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    author,
    body: String(row.body),
    createdAt: Number(row.created_at),
    editedAt: row.edited_at === null ? null : Number(row.edited_at),
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
    assigneeId: row.assignee_id === null ? null : String(row.assignee_id),
    branch: row.branch === null ? null : String(row.branch),
    baseRef: row.base_ref === null ? null : String(row.base_ref),
    status: String(row.status),
    statusRevision: Number(row.status_revision),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function sessionEvent(found: Session, event: "started" | "ended"): HistoryEvent {
  return { kind: "session", sessionId: found.id, event, machine: found.machine, runtime: found.runtime };
}

const RUN_OUTCOMES: readonly RunOutcome[] = ["finished", "nothing_to_deploy", "review", "timed_out", "failed", "ended"];

function session(row: Row): Session {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    taskId: row.task_id === null ? null : String(row.task_id),
    automationId: row.automation_id === null ? null : String(row.automation_id),
    name: String(row.name),
    branch: row.branch === null ? null : String(row.branch),
    baseRef: row.base_ref === null ? null : String(row.base_ref),
    machine: row.machine === null ? null : String(row.machine),
    runtime: row.runtime === "host" ? "host" : "container",
    checkout: Number(row.checkout) === 1,
    model: row.model === null ? null : String(row.model),
    startedAt: Number(row.started_at),
    endedAt: row.ended_at === null ? null : Number(row.ended_at),
    run: Number(row.is_run) !== 1 ? null : {
      startedBy: actorOfRow(row.run_started_by_kind, row.run_started_by_id),
      triggerContext: row.run_trigger_context === null ? "" : String(row.run_trigger_context),
      outcome: RUN_OUTCOMES.find((outcome) => outcome === row.run_outcome) ?? null,
      reason: row.run_reason === null ? null : String(row.run_reason),
      endedBy: actorOfRow(row.run_ended_by_kind, row.run_ended_by_id),
    },
  };
}

function automation(row: Row): Automation {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name),
    slug: String(row.slug),
    instructions: String(row.instructions),
    model: row.model === null ? null : String(row.model),
    endMode: row.end_mode === "review" ? "review" : "finish",
    timeLimitMinutes: Number(row.time_limit_minutes),
    enabled: Number(row.enabled) === 1,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function trigger(row: Row): Trigger {
  return {
    id: String(row.id),
    automationId: String(row.automation_id),
    cron: String(row.cron),
    timezone: String(row.timezone),
    guardPath: row.guard_path === null ? null : String(row.guard_path),
    checkPath: row.check_path === null ? null : String(row.check_path),
    createdAt: Number(row.created_at),
  };
}

const FIRING_OUTCOMES: readonly FiringOutcome[] = ["pending", "started", "off", "running", "guard", "check", "failed"];

function verdictOf(value: unknown): FiringVerdict | null {
  if (value === null) return null;
  const parsed: unknown = JSON.parse(String(value));
  if (typeof parsed !== "object" || parsed === null || !("passed" in parsed) || !("output" in parsed)) return null;
  return { passed: parsed.passed === true, output: String(parsed.output) };
}

function firing(row: Row): Firing {
  const outcome = FIRING_OUTCOMES.find((known) => known === row.outcome);
  if (outcome === undefined) throw new Error(`firing ${String(row.id)} has unknown outcome ${String(row.outcome)}`);
  return {
    id: String(row.id),
    automationId: String(row.automation_id),
    triggerId: String(row.trigger_id),
    scheduledAt: Number(row.scheduled_at),
    firedAt: Number(row.fired_at),
    caughtUp: Number(row.caught_up) === 1,
    guard: verdictOf(row.guard_verdict),
    check: verdictOf(row.check_verdict),
    outcome,
    sessionId: row.session_id === null ? null : String(row.session_id),
    error: row.error === null ? null : String(row.error),
  };
}

/** AUTO-9: the part of a run's branch, `am/<automation slug>-<run>`, that names the run: the start of its session's id. */
export function runShortId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

/** AUTO-1: a slug for branch names from an automation's name. */
export function slugOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 40).replace(/[-.]+$/, "") || "automation";
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

  constructor(path: string, ownerName: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    this.migrateSessionsToTasks();
    // HOST-1: stores from before host sessions.
    this.addColumn("projects", "host_sessions", "INTEGER NOT NULL DEFAULT 0");
    this.addColumn("sessions", "runtime", "TEXT NOT NULL DEFAULT 'container'");
    this.addColumn("sessions", "checkout", "INTEGER NOT NULL DEFAULT 0");
    this.migrateSessionOwners();
    // AUTO-2: stores from before scheduling: firings say whether they caught up, and why they failed.
    this.addColumn("automation_firings", "caught_up", "INTEGER NOT NULL DEFAULT 0");
    this.addColumn("automation_firings", "error", "TEXT");
    // AUTO-10: stores from before runs ended said why they failed; AUTO-11: every session of an
    // automation from before sessions on automations is a run.
    this.addColumn("sessions", "run_reason", "TEXT");
    if (!this.columns("sessions").includes("is_run")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN is_run INTEGER NOT NULL DEFAULT 0");
      this.db.exec("UPDATE sessions SET is_run = 1 WHERE automation_id IS NOT NULL");
    }
    // PERSON-1: every store has its owner; TASK-13 and UI-4 on stores from before people.
    if (this.db.prepare("SELECT 1 FROM people WHERE owner = 1").get() === undefined) {
      this.db.prepare("INSERT INTO people (id, name, color, owner, created_at) VALUES (?, ?, ?, 1, ?)").run(randomUUID(), ownerName, PALETTE[5], Date.now());
    }
    this.addColumn("tasks", "assignee_id", "TEXT REFERENCES people(id)");
    // AUTH-2: people log in with their email, lower-cased, so unique regardless of case.
    this.addColumn("people", "email", "TEXT");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS people_email ON people (email)");
    this.addColumn("topics", "color", "TEXT NOT NULL DEFAULT ''");
    for (const [index, row] of this.db.prepare("SELECT id FROM topics WHERE color = '' ORDER BY created_at").all().entries()) {
      this.db.prepare("UPDATE topics SET color = ? WHERE id = ?").run(PALETTE[index % PALETTE.length], String(row.id));
    }
    this.migrateHistory();
    this.migrateNotes();
  }

  /**
   * TASK-15: notes are gone; each task's notes became a comment by the store's owner, dated
   * when the task was last updated, the closest the store knows to when they were written.
   */
  private migrateNotes(): void {
    const columns = this.db.prepare("SELECT name FROM pragma_table_info('tasks')").all().map((row) => String(row.name));
    if (!columns.includes("notes")) return;
    this.transaction(() => {
      const owner = this.ownerPrincipal();
      for (const row of this.db.prepare("SELECT id, notes, updated_at FROM tasks WHERE trim(notes) != '' ORDER BY created_at").all()) {
        this.insertComment(String(row.id), owner, String(row.notes), Number(row.updated_at));
      }
      this.db.exec("ALTER TABLE tasks DROP COLUMN notes");
      if (columns.includes("notes_revision")) this.db.exec("ALTER TABLE tasks DROP COLUMN notes_revision");
    });
  }

  /**
   * TASK-14: a store from before history gets what its records still tell: each task's
   * creation and its sessions' starts and ends, by the owner.
   */
  private migrateHistory(): void {
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_events'").get() !== undefined) return;
    this.transaction(() => {
      this.db.exec(EVENTS_SCHEMA);
      const owner = this.ownerPrincipal();
      for (const row of this.db.prepare("SELECT id, created_at FROM tasks").all()) {
        this.recordTaskEvent(String(row.id), owner, { kind: "created" }, Number(row.created_at));
      }
      for (const found of this.db.prepare("SELECT * FROM sessions").all().map(session)) {
        const { taskId } = found;
        if (taskId === null) continue;
        this.recordTaskEvent(taskId, owner, sessionEvent(found, "started"), found.startedAt);
        if (found.endedAt !== null) this.recordTaskEvent(taskId, owner, sessionEvent(found, "ended"), found.endedAt);
      }
    });
  }

  private columns(table: string): string[] {
    return this.db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((row) => String(row.name));
  }

  private addColumn(table: string, column: string, definition: string): void {
    if (!this.columns(table).includes(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  close(): void {
    this.db.close();
  }

  /**
   * TASK-10: a store from before tasks has sessions with their own topic links and notes.
   * Each such session becomes a task with its name, branch, topic links, and notes (which
   * then become a comment, TASK-15); the session-level tables go away.
   */
  private migrateSessionsToTasks(): void {
    const columns = this.db.prepare("SELECT name FROM pragma_table_info('sessions')").all().map((row) => String(row.name));
    if (columns.includes("task_id")) return;
    const hasTable = (name: string) =>
      this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
    this.transaction(() => {
      this.db.exec("ALTER TABLE sessions ADD COLUMN task_id TEXT REFERENCES tasks(id)");
      this.addColumn("tasks", "notes", "TEXT NOT NULL DEFAULT ''");
      const insert = this.db.prepare(
        "INSERT INTO tasks (id, project_id, title, state, branch, base_ref, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const notesOf = hasTable("session_notes") ? this.db.prepare("SELECT text FROM session_notes WHERE session_id = ?") : null;
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

  /**
   * SESSION-5: a store from before automations has sessions that must have a task. Their table
   * is rebuilt so a session belongs to a task or an automation, with a run's fields (AUTO-9);
   * every session keeps its row. SQLite changes a column's constraints only by a rebuild, and
   * foreign keys are checked once it is done.
   */
  private migrateSessionOwners(): void {
    const columns = this.db.prepare("SELECT name FROM pragma_table_info('sessions')").all().map((row) => String(row.name));
    if (columns.includes("automation_id")) return;
    this.db.exec("PRAGMA foreign_keys = OFF");
    try {
      this.transaction(() => {
        this.db.exec(sessionsTable("sessions_owned"));
        this.db.exec(`INSERT INTO sessions_owned (${TASK_SESSION_COLUMNS}) SELECT ${TASK_SESSION_COLUMNS} FROM sessions`);
        this.db.exec("DROP TABLE sessions");
        this.db.exec("ALTER TABLE sessions_owned RENAME TO sessions");
        const broken = this.db.prepare("PRAGMA foreign_key_check").all();
        if (broken.length > 0) throw new Error(`the sessions migration breaks references: ${JSON.stringify(broken)}`);
      });
    } finally {
      this.db.exec("PRAGMA foreign_keys = ON");
    }
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

  /** The store's owner; every human request in local mode. */
  ownerPrincipal(): Principal {
    const row = this.db.prepare("SELECT id FROM people WHERE owner = 1").get();
    if (row === undefined) throw new Error("the store has no owner");
    return { kind: "human", personId: String(row.id) };
  }

  /** AUTH-2: the owner's email, from the gateway's configuration; no other person may have it. */
  setOwnerEmail(email: string): void {
    const taken = this.db.prepare("SELECT name FROM people WHERE email = ? AND owner = 0").get(email);
    if (taken !== undefined) throw new Error(`the owner's email ${email} is already ${String(taken.name)}'s`);
    this.db.prepare("UPDATE people SET email = ? WHERE owner = 1").run(email);
  }

  /** AUTH-2: the person who logs in with this email (lower-cased, as the store keeps them); null for anyone else. */
  personByEmail(email: string): Principal | null {
    const row = this.db.prepare("SELECT id FROM people WHERE email = ?").get(email.toLowerCase());
    return row === undefined ? null : { kind: "human", personId: String(row.id) };
  }

  /** TASK-14: appends what happened to a task, by whom (null: no one, as a pull request seen on GitHub). */
  recordTaskEvent(taskId: string, principal: Principal | null, event: HistoryEvent, at = Date.now()): void {
    const actor = principal === null ? null : actorOf(principal);
    this.db.prepare("INSERT INTO task_events (task_id, at, actor_kind, actor_id, data) VALUES (?, ?, ?, ?, ?)").run(
      taskId,
      at,
      actor?.kind ?? null,
      actor === null ? null : actor.kind === "person" ? actor.personId : actor.sessionId,
      JSON.stringify(event),
    );
  }

  /** TASK-14: what happened to the task, oldest first. */
  taskHistory(principal: Principal, taskId: string): HistoryEntry[] {
    this.visibleTask(principal, taskId);
    return this.db.prepare("SELECT * FROM task_events WHERE task_id = ? ORDER BY at, id").all(taskId).map((row) => ({
      ...historyEvent.parse(JSON.parse(String(row.data))),
      at: Number(row.at),
      actor: actorOfRow(row.actor_kind, row.actor_id),
    }));
  }

  /** TASK-14: a pull request of the task's branch, recorded once, by no one, at the time it was opened. */
  recordPullRequest(taskId: string, pr: PullRequest, openedAt: number): void {
    const seen = this.db.prepare(
      "SELECT 1 FROM task_events WHERE task_id = ? AND json_extract(data, '$.kind') = 'pull_request' AND json_extract(data, '$.number') = ?",
    ).get(taskId, pr.number);
    if (seen === undefined) this.recordTaskEvent(taskId, null, { kind: "pull_request", number: pr.number, title: pr.title, url: pr.url }, openedAt);
  }

  /** PERSON-1: everyone who uses the store, the owner first. */
  listPeople(principal: Principal): Person[] {
    this.scope(principal);
    return this.db.prepare("SELECT * FROM people ORDER BY owner DESC, created_at").all().map(person);
  }

  /** PERSON-1, AUTH-3: only the owner adds people, each with the email they log in with. */
  createPerson(principal: Principal, input: { name: string; email: string }): Person {
    this.requireOwner(principal);
    if (this.db.prepare("SELECT 1 FROM people WHERE email = ?").get(input.email) !== undefined) {
      throw new StoreError(409, `${input.email} is already a person of this store`);
    }
    const count = Number(this.db.prepare("SELECT count(*) AS n FROM people").get()?.n ?? 0);
    const created: Person = { id: randomUUID(), name: input.name, email: input.email, color: PALETTE[(5 + count) % PALETTE.length], owner: false, createdAt: Date.now() };
    this.db.prepare("INSERT INTO people (id, name, email, color, owner, created_at) VALUES (?, ?, ?, ?, 0, ?)")
      .run(created.id, created.name, created.email, created.color, created.createdAt);
    return created;
  }

  /** A person renames themselves; the owner renames anyone. */
  updatePerson(principal: Principal, personId: string, input: { name: string }): Person {
    if (principal.kind !== "human" || (principal.personId !== personId && !this.isOwner(principal))) {
      throw new StoreError(403, "only the person or the store's owner can do this");
    }
    const row = this.db.prepare("SELECT * FROM people WHERE id = ?").get(personId);
    if (row === undefined) throw new StoreError(404, `person ${personId} not found`);
    this.db.prepare("UPDATE people SET name = ? WHERE id = ?").run(input.name, personId);
    return { ...person(row), name: input.name };
  }

  private isOwner(principal: Principal): boolean {
    if (principal.kind !== "human") return false;
    return this.db.prepare("SELECT 1 FROM people WHERE id = ? AND owner = 1").get(principal.personId) !== undefined;
  }

  /** AUTH-3, STORE-6: what only the store's owner does. */
  requireOwner(principal: Principal): void {
    if (!this.isOwner(principal)) throw new StoreError(403, "only the store's owner can do this");
  }

  private visibleProject(principal: Principal, projectId: string): Project {
    const scope = this.scope(principal);
    const row = this.db.prepare(`${PROJECT_ROWS} WHERE p.id = ?`).get(projectId);
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

  private visibleAutomation(principal: Principal, automationId: string): Automation {
    const row = this.db.prepare("SELECT * FROM automations WHERE id = ?").get(automationId);
    const scope = this.scope(principal);
    if (row === undefined || (scope !== null && scope !== row.project_id)) {
      throw new StoreError(404, `automation ${automationId} not found`);
    }
    return automation(row);
  }

  private visibleTrigger(principal: Principal, triggerId: string): { trigger: Trigger; automation: Automation } {
    const row = this.db.prepare("SELECT * FROM automation_triggers WHERE id = ?").get(triggerId);
    if (row === undefined) throw new StoreError(404, `trigger ${triggerId} not found`);
    const found = trigger(row);
    try {
      return { trigger: found, automation: this.visibleAutomation(principal, found.automationId) };
    } catch {
      throw new StoreError(404, `trigger ${triggerId} not found`);
    }
  }

  /** SESSION-5: the task or the automation a session belongs to; the other is null. */
  private ownerOf(principal: Principal, found: Session): { task: Task | null; automation: Automation | null } {
    return {
      task: found.taskId === null ? null : this.visibleTask(principal, found.taskId),
      automation: found.automationId === null ? null : this.visibleAutomation(principal, found.automationId),
    };
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

  whoami(principal: Principal):
    | { kind: "human"; person: Person }
    | { kind: "agent"; project: Project; session: Session; task: Task | null; automation: Automation | null } {
    if (principal.kind === "human") {
      const row = this.db.prepare("SELECT * FROM people WHERE id = ?").get(principal.personId);
      if (row === undefined) throw new StoreError(403, "this person no longer exists");
      return { kind: "human", person: person(row) };
    }
    const own = this.visibleSession(principal, principal.sessionId);
    return { kind: "agent", project: this.visibleProject(principal, own.projectId), session: own, ...this.ownerOf(principal, own) };
  }

  listProjects(principal: Principal): Project[] {
    const scope = this.scope(principal);
    const rows = scope === null
      ? this.db.prepare(`${PROJECT_ROWS} ORDER BY p.name`).all()
      : this.db.prepare(`${PROJECT_ROWS} WHERE p.id = ?`).all(scope);
    return rows.map(project);
  }

  getProject(principal: Principal, projectId: string): Project {
    return this.visibleProject(principal, projectId);
  }

  /** A session with the task or the automation it belongs to (SESSION-5). */
  getSession(principal: Principal, sessionId: string): { session: Session; task: Task | null; automation: Automation | null } {
    const found = this.visibleSession(principal, sessionId);
    return { session: found, ...this.ownerOf(principal, found) };
  }

  createProject(principal: Principal, input: { name: string; repoPath?: string; hostSessions?: boolean }): Project {
    this.requireHuman(principal);
    if (input.hostSessions === true) this.requireHostSessionsSwitch(principal);
    if (this.db.prepare("SELECT 1 FROM projects WHERE name = ?").get(input.name) !== undefined) {
      throw new StoreError(409, `project "${input.name}" already exists`);
    }
    const created: Project = {
      id: randomUUID(),
      name: input.name,
      repoPath: input.repoPath ?? null,
      hostSessions: input.hostSessions ?? false,
      cloudflare: { read: false, write: false },
      createdAt: Date.now(),
    };
    this.db.prepare("INSERT INTO projects (id, name, repo_path, host_sessions, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(created.id, created.name, created.repoPath, created.hostSessions ? 1 : 0, created.createdAt);
    return created;
  }

  /**
   * The project settings page: its name, its repository, and whether it allows host sessions.
   * A running session works in a worktree of the repository, so the repository changes only
   * while none runs.
   */
  updateProject(principal: Principal, projectId: string, input: { name?: string; repoPath?: string | null; hostSessions?: boolean }): Project {
    this.requireHuman(principal);
    return this.transaction(() => {
      const current = this.visibleProject(principal, projectId);
      if (input.hostSessions !== undefined && input.hostSessions !== current.hostSessions) this.requireHostSessionsSwitch(principal);
      const name = input.name ?? current.name;
      if (name !== current.name && this.db.prepare("SELECT 1 FROM projects WHERE name = ?").get(name) !== undefined) {
        throw new StoreError(409, `project "${name}" already exists`);
      }
      const repoPath = input.repoPath === undefined ? current.repoPath : input.repoPath;
      if (repoPath !== current.repoPath) {
        const running = this.listSessions(principal, projectId).length;
        if (running > 0) throw new StoreError(409, `end the project's ${running} running session(s) before changing its repository`);
      }
      const hostSessions = input.hostSessions ?? current.hostSessions;
      this.db.prepare("UPDATE projects SET name = ?, repo_path = ?, host_sessions = ? WHERE id = ?").run(name, repoPath, hostSessions ? 1 : 0, projectId);
      return { ...current, name, repoPath, hostSessions };
    });
  }

  /** HOST-1: only the store's owner allows or stops host sessions in a project; the one place that says who may. */
  private requireHostSessionsSwitch(principal: Principal): void {
    if (!this.isOwner(principal)) throw new StoreError(403, "only the store's owner allows or stops host sessions");
  }

  /**
   * CLOUDFLARE-3: the store's owner sets the project's Cloudflare tokens, both at once: a read
   * token, and a write token or none (its agents only read). The answer says which are set.
   */
  setCloudflareTokens(principal: Principal, projectId: string, tokens: CloudflareTokens): Project {
    this.requireOwner(principal);
    return this.transaction(() => {
      this.visibleProject(principal, projectId);
      this.db.prepare(
        "INSERT INTO cloudflare_tokens (project_id, read_token, write_token, updated_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT (project_id) DO UPDATE SET read_token = excluded.read_token, write_token = excluded.write_token, updated_at = excluded.updated_at",
      ).run(projectId, tokens.read, tokens.write, Date.now());
      return this.visibleProject(principal, projectId);
    });
  }

  /** CLOUDFLARE-3: the store's owner removes the project's Cloudflare tokens; its agents lose Cloudflare access. */
  removeCloudflareTokens(principal: Principal, projectId: string): Project {
    this.requireOwner(principal);
    return this.transaction(() => {
      this.visibleProject(principal, projectId);
      this.db.prepare("DELETE FROM cloudflare_tokens WHERE project_id = ?").run(projectId);
      return this.visibleProject(principal, projectId);
    });
  }

  /** CLOUDFLARE-1/2: the project's tokens, for the gateway's broker only: no route answers with them. Null: it has none. */
  cloudflareTokens(projectId: string): CloudflareTokens | null {
    const row = this.db.prepare("SELECT read_token, write_token FROM cloudflare_tokens WHERE project_id = ?").get(projectId);
    return row === undefined ? null : { read: String(row.read_token), write: row.write_token === null ? null : String(row.write_token) };
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
    const count = Number(this.db.prepare("SELECT count(*) AS n FROM topics WHERE project_id = ?").get(projectId)?.n ?? 0);
    const created: Topic = { id: randomUUID(), projectId, name, color: PALETTE[count % PALETTE.length], createdAt: Date.now(), status: "", statusRevision: 0 };
    this.db.prepare("INSERT INTO topics (id, project_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(created.id, projectId, name, created.color, created.createdAt);
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

  /**
   * Every task of a project with its topics and running session, oldest first. BOARD-3: with
   * `search`, only the tasks whose title, description, or comments hold each of its words,
   * ignoring case.
   */
  listTasks(principal: Principal, projectId: string, search = ""): TaskSummary[] {
    this.visibleProject(principal, projectId);
    const words = search.toLowerCase().split(/\s+/).filter(Boolean);
    const commentsOf = this.db.prepare("SELECT body FROM comments WHERE task_id = ?");
    return this.db.prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at").all(projectId).flatMap((row) => {
      const found = task(row);
      if (words.length > 0) {
        const text = [found.title, found.description, ...commentsOf.all(found.id).map((comment) => String(comment.body))].join("\n").toLowerCase();
        if (!words.every((word) => text.includes(word))) return [];
      }
      return [{ task: found, topics: this.topicsOf(found.id), sessionId: this.runningSessionOf(found.id)?.id ?? null }];
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
      assigneeId: null,
      branch: null,
      baseRef: null,
      status: "",
      statusRevision: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.transaction(() => {
      this.db.prepare("INSERT INTO tasks (id, project_id, title, description, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(created.id, projectId, created.title, created.description, created.state, now, now);
      this.recordTaskEvent(created.id, principal, { kind: "created" }, now);
    });
    return created;
  }

  /**
   * Title, description, assignee (TASK-13), and the unfinished states; finishing a task is the
   * gateway's job (TASK-9). State and assignee changes go into its history (TASK-14).
   */
  updateTask(
    principal: Principal,
    taskId: string,
    input: { title?: string; description?: string; state?: TaskState; assigneeId?: string | null },
  ): Task {
    return this.transaction(() => {
      const current = this.visibleTask(principal, taskId);
      if (input.assigneeId != null && this.db.prepare("SELECT 1 FROM people WHERE id = ?").get(input.assigneeId) === undefined) {
        throw new StoreError(404, `person ${input.assigneeId} not found`);
      }
      const next: Task = {
        ...current,
        title: input.title ?? current.title,
        description: input.description ?? current.description,
        state: input.state ?? current.state,
        assigneeId: input.assigneeId === undefined ? current.assigneeId : input.assigneeId,
        updatedAt: Date.now(),
      };
      this.db.prepare("UPDATE tasks SET title = ?, description = ?, state = ?, assignee_id = ?, updated_at = ? WHERE id = ?")
        .run(next.title, next.description, next.state, next.assigneeId, next.updatedAt, taskId);
      if (next.state !== current.state) this.recordTaskEvent(taskId, principal, { kind: "state", from: current.state, to: next.state }, next.updatedAt);
      if (next.assigneeId !== current.assigneeId) this.recordTaskEvent(taskId, principal, { kind: "assignee", personId: next.assigneeId }, next.updatedAt);
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
    const linked = this.db.prepare("INSERT OR IGNORE INTO task_topics (task_id, topic_id, linked_at) VALUES (?, ?, ?)")
      .run(taskId, topicId, Date.now());
    if (Number(linked.changes) > 0) this.recordTaskEvent(taskId, principal, { kind: "topic", topicId, name: target.name, linked: true });
    return this.topicsOf(taskId);
  }

  unlinkTopic(principal: Principal, taskId: string, topicId: string): Topic[] {
    this.visibleTask(principal, taskId);
    const target = this.visibleTopic(principal, topicId);
    const unlinked = this.db.prepare("DELETE FROM task_topics WHERE task_id = ? AND topic_id = ?").run(taskId, topicId);
    if (Number(unlinked.changes) > 0) this.recordTaskEvent(taskId, principal, { kind: "topic", topicId, name: target.name, linked: false });
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

  /** COMMENT-1: a task's comments, oldest first. */
  listComments(principal: Principal, taskId: string): Comment[] {
    this.visibleTask(principal, taskId);
    return this.db.prepare("SELECT * FROM comments WHERE task_id = ? ORDER BY created_at, rowid").all(taskId).map(comment);
  }

  /** COMMENT-1: a person or an agent comments on a task; its history records who (TASK-14). */
  createComment(principal: Principal, taskId: string, body: string): Comment {
    return this.transaction(() => {
      this.visibleTask(principal, taskId);
      return this.insertComment(taskId, principal, body, Date.now());
    });
  }

  private insertComment(taskId: string, principal: Principal, body: string, at: number): Comment {
    const author = actorOf(principal);
    const created: Comment = { id: randomUUID(), taskId, author, body, createdAt: at, editedAt: null };
    this.db.prepare("INSERT INTO comments (id, task_id, author_kind, author_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(created.id, taskId, author.kind, author.kind === "person" ? author.personId : author.sessionId, body, at);
    this.recordTaskEvent(taskId, principal, { kind: "comment", commentId: created.id }, at);
    return created;
  }

  /** COMMENT-2: the comment, when the principal wrote it; anyone else is refused. */
  private ownComment(principal: Principal, commentId: string): Comment {
    const row = this.db.prepare("SELECT c.*, t.project_id FROM comments c JOIN tasks t ON t.id = c.task_id WHERE c.id = ?").get(commentId);
    const scope = this.scope(principal);
    if (row === undefined || (scope !== null && scope !== row.project_id)) throw new StoreError(404, `comment ${commentId} not found`);
    const found = comment(row);
    const me = actorOf(principal);
    const mine = me.kind === "person"
      ? found.author.kind === "person" && found.author.personId === me.personId
      : found.author.kind === "agent" && found.author.sessionId === me.sessionId;
    if (!mine) throw new StoreError(403, "only a comment's author can edit or delete it");
    return found;
  }

  /** COMMENT-2: its author edits a comment, which then says when. */
  updateComment(principal: Principal, commentId: string, body: string): Comment {
    return this.transaction(() => {
      const found = this.ownComment(principal, commentId);
      const editedAt = Date.now();
      this.db.prepare("UPDATE comments SET body = ?, edited_at = ? WHERE id = ?").run(body, editedAt, commentId);
      return { ...found, body, editedAt };
    });
  }

  /** COMMENT-2: its author deletes a comment; the history keeps that it was written. */
  deleteComment(principal: Principal, commentId: string): Comment {
    return this.transaction(() => {
      const found = this.ownComment(principal, commentId);
      this.db.prepare("DELETE FROM comments WHERE id = ?").run(commentId);
      return found;
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
    // AUTH-3: only the owner starts host sessions.
    if (input.runtime === "host") this.requireOwner(principal);
    else this.requireHuman(principal);
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
        automationId: null,
        name: owner.title,
        branch: checkout ? null : owner.branch,
        baseRef: checkout ? null : owner.baseRef,
        machine: input.machine ?? null,
        runtime: input.runtime,
        checkout,
        model: input.model ?? null,
        startedAt: Date.now(),
        endedAt: null,
        run: null,
      };
      this.db.prepare(
        "INSERT INTO sessions (id, project_id, task_id, name, branch, base_ref, machine, runtime, checkout, model, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(created.id, created.projectId, taskId, created.name, created.branch, created.baseRef, created.machine, created.runtime, checkout ? 1 : 0, created.model, created.startedAt);
      this.recordTaskEvent(taskId, principal, sessionEvent(created, "started"), created.startedAt);
      if (owner.state === "open") {
        this.db.prepare("UPDATE tasks SET state = 'in_progress', updated_at = ? WHERE id = ?").run(created.startedAt, taskId);
        this.recordTaskEvent(taskId, principal, { kind: "state", from: "open", to: "in_progress" }, created.startedAt);
      }
      return created;
    });
  }

  /** The branch a session's workspace was given; set before its worktree exists. */
  setSessionBranch(sessionId: string, branch: string, baseRef: string): void {
    this.db.prepare("UPDATE sessions SET branch = ?, base_ref = ? WHERE id = ?").run(branch, baseRef, sessionId);
  }

  /** Removes a session whose launch failed, and its start from its task's history. */
  discardSession(sessionId: string): void {
    this.db.prepare("DELETE FROM task_events WHERE json_extract(data, '$.sessionId') = ?").run(sessionId);
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
  }

  /**
   * SESSION-8: an ended session keeps its record; its workspace is the caller's job. Its task's
   * history records who ended it (TASK-14); a run records them as who ended it, and as its
   * outcome that it was ended unless it already had one (PERSON-1).
   */
  endSession(principal: Principal, sessionId: string): Session {
    this.requireHuman(principal);
    return this.transaction(() => this.closeSession(principal, this.visibleSession(principal, sessionId)));
  }

  /**
   * AUTO-10, AUTO-14: a run that ends without a person: its agent said how it went (`endedBy`
   * that agent), or its time limit stopped it (`endedBy` null), which says so as its outcome
   * unless it already had one.
   */
  endRun(endedBy: Principal | null, sessionId: string, outcome: RunOutcome): Session {
    return this.transaction(() => {
      const found = this.visibleSession(this.ownerPrincipal(), sessionId);
      if (found.run === null) throw new StoreError(404, `session ${found.name} is no run`);
      if (found.run.outcome === null) this.db.prepare("UPDATE sessions SET run_outcome = ? WHERE id = ?").run(outcome, sessionId);
      return this.closeSession(endedBy, { ...found, run: { ...found.run, outcome: found.run.outcome ?? outcome } });
    });
  }

  private closeSession(principal: Principal | null, found: Session): Session {
    if (found.endedAt !== null) throw new StoreError(409, `session ${found.name} has already ended`);
    const endedAt = Date.now();
    this.db.prepare("UPDATE sessions SET ended_at = ? WHERE id = ?").run(endedAt, found.id);
    if (found.taskId !== null) this.recordTaskEvent(found.taskId, principal, sessionEvent(found, "ended"), endedAt);
    if (found.run === null) return { ...found, endedAt };
    const endedBy = principal === null ? null : actorOf(principal);
    const outcome = found.run.outcome ?? "ended";
    const [kind, id] = actorColumns(endedBy);
    this.db.prepare("UPDATE sessions SET run_outcome = ?, run_ended_by_kind = ?, run_ended_by_id = ? WHERE id = ?").run(outcome, kind, id, found.id);
    return { ...found, endedAt, run: { ...found.run, outcome, endedBy } };
  }

  /** TASK-9: records a finished task; its session and branch are the caller's job. */
  finishTask(principal: Principal, taskId: string, state: "done" | "cancelled"): Task {
    this.requireHuman(principal);
    return this.transaction(() => {
      const current = this.visibleTask(principal, taskId);
      const next: Task = { ...current, state, updatedAt: Date.now() };
      this.db.prepare("UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?").run(state, next.updatedAt, taskId);
      if (current.state !== state) this.recordTaskEvent(taskId, principal, { kind: "state", from: current.state, to: state }, next.updatedAt);
      return next;
    });
  }

  /**
   * FOLDER-1, FOLDER-3: brings an owner's recorded files in line with what its folder's
   * directory holds, `entries`. A file that appeared there was written by the agent of the
   * task's running session, or of the automation's running session (its run, or the newest
   * session on it, AUTO-11), the only ones with the directory; with none running, by no one
   * known. New files of a task go into its history (TASK-14) as added when they were written.
   */
  syncFolder(owner: FolderOwner, entries: FolderEntry[]): FolderFile[] {
    const { table, column } = folderTable(owner);
    return this.transaction(() => {
      const recorded = new Map(this.db.prepare(`SELECT * FROM ${table} WHERE ${column} = ?`).all(owner.id).map((row) => [String(row.path), folderFile(row)]));
      const running = owner.kind === "task"
        ? this.runningSessionOf(owner.id)
        : this.db.prepare("SELECT id FROM sessions WHERE automation_id = ? AND ended_at IS NULL ORDER BY started_at DESC").get(owner.id) ?? null;
      const writer: Principal | null = running === null ? null : { kind: "agent", sessionId: String(running.id) };
      for (const entry of entries) {
        const known = recorded.get(entry.path);
        recorded.delete(entry.path);
        if (known === undefined) {
          this.insertFolderFile(owner, entry, writer, entry.modifiedAt);
        } else if (known.size !== entry.size || known.updatedAt !== entry.modifiedAt || known.contentType !== entry.contentType) {
          this.db.prepare(`UPDATE ${table} SET size = ?, content_type = ?, updated_at = ? WHERE ${column} = ? AND path = ?`)
            .run(entry.size, entry.contentType, entry.modifiedAt, owner.id, entry.path);
        }
      }
      for (const gone of recorded.keys()) this.db.prepare(`DELETE FROM ${table} WHERE ${column} = ? AND path = ?`).run(owner.id, gone);
      return this.db.prepare(`SELECT * FROM ${table} WHERE ${column} = ? ORDER BY path`).all(owner.id).map(folderFile);
    });
  }

  /**
   * FOLDER-1, AUTO-1: the name of a task's or an automation's folder (its title or name), when
   * the principal may see it; a folder of another project is not found.
   */
  folderName(principal: Principal, owner: FolderOwner): string {
    return owner.kind === "task" ? this.visibleTask(principal, owner.id).title : this.visibleAutomation(principal, owner.id).name;
  }

  /** FOLDER-1: a file someone put into a folder, replacing any of the same path; added now, by them. */
  addFolderFile(principal: Principal, owner: FolderOwner, entry: FolderEntry): FolderFile {
    const { table, column } = folderTable(owner);
    return this.transaction(() => {
      this.folderName(principal, owner);
      this.db.prepare(`DELETE FROM ${table} WHERE ${column} = ? AND path = ?`).run(owner.id, entry.path);
      return this.insertFolderFile(owner, entry, principal, Date.now());
    });
  }

  private insertFolderFile(owner: FolderOwner, entry: FolderEntry, principal: Principal | null, addedAt: number): FolderFile {
    const { table, column } = folderTable(owner);
    const addedBy = principal === null ? null : actorOf(principal);
    const [kind, id] = actorColumns(addedBy);
    this.db.prepare(
      `INSERT INTO ${table} (${column}, path, size, content_type, added_by_kind, added_by_id, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(owner.id, entry.path, entry.size, entry.contentType, kind, id, addedAt, entry.modifiedAt);
    if (owner.kind === "task") this.recordTaskEvent(owner.id, principal, { kind: "file", path: entry.path }, addedAt);
    return { path: entry.path, size: entry.size, contentType: entry.contentType, addedBy, addedAt, updatedAt: entry.modifiedAt };
  }

  /** FOLDER-1: forgets a file deleted from a folder. */
  removeFolderFile(owner: FolderOwner, path: string): void {
    const { table, column } = folderTable(owner);
    this.db.prepare(`DELETE FROM ${table} WHERE ${column} = ? AND path = ?`).run(owner.id, path);
  }

  /** AUTO-9: the automation's run that is still going, if any; a session on it that is no run does not count. */
  private runningRunOf(automationId: string): Session | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE automation_id = ? AND is_run = 1 AND ended_at IS NULL").get(automationId);
    return row === undefined ? null : session(row);
  }

  private triggersOf(automationId: string): Trigger[] {
    return this.db.prepare("SELECT * FROM automation_triggers WHERE automation_id = ? ORDER BY created_at, id").all(automationId).map(trigger);
  }

  /** AUTO-1: a project's automations, by name, each with its triggers and its running run. */
  listAutomations(principal: Principal, projectId: string): AutomationSummary[] {
    this.visibleProject(principal, projectId);
    return this.db.prepare("SELECT * FROM automations WHERE project_id = ? ORDER BY name").all(projectId).map((row) => {
      const found = automation(row);
      return { automation: found, triggers: this.triggersOf(found.id), sessionId: this.runningRunOf(found.id)?.id ?? null };
    });
  }

  /** AUTO-1, AUTO-7: an automation with its triggers and its runs, newest first. */
  getAutomation(principal: Principal, automationId: string): AutomationDetail {
    const found = this.visibleAutomation(principal, automationId);
    return { automation: found, triggers: this.triggersOf(automationId), runs: this.listRuns(principal, automationId) };
  }

  /** AUTO-1, AUTO-15: names and slugs are unique in a project; a slug is the name's unless given. */
  private checkAutomationNames(projectId: string, name: string, slug: string, except: string | null): void {
    const taken = (column: string, value: string) =>
      this.db.prepare(`SELECT 1 FROM automations WHERE project_id = ? AND ${column} = ? AND id IS NOT ?`).get(projectId, value, except) !== undefined;
    if (taken("name", name)) throw new StoreError(409, `automation "${name}" already exists in this project`);
    if (taken("slug", slug)) throw new StoreError(409, `another automation of this project names its branches am/${slug}-…; give this one another slug`);
  }

  /** AUTO-1, AUTO-15: people and agents create automations; one starts on, ending its runs with `finish`, in 120 minutes. */
  createAutomation(principal: Principal, projectId: string, input: AutomationInput & { name: string }): Automation {
    return this.transaction(() => {
      this.visibleProject(principal, projectId);
      const now = Date.now();
      const created: Automation = {
        id: randomUUID(),
        projectId,
        name: input.name,
        slug: input.slug ?? slugOf(input.name),
        instructions: input.instructions ?? "",
        model: input.model ?? null,
        endMode: input.endMode ?? "finish",
        timeLimitMinutes: input.timeLimitMinutes ?? 120,
        enabled: input.enabled ?? true,
        createdAt: now,
        updatedAt: now,
      };
      this.checkAutomationNames(projectId, created.name, created.slug, null);
      this.db.prepare(
        "INSERT INTO automations (id, project_id, name, slug, instructions, model, end_mode, time_limit_minutes, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        created.id, projectId, created.name, created.slug, created.instructions, created.model, created.endMode, created.timeLimitMinutes,
        created.enabled ? 1 : 0, now, now,
      );
      return created;
    });
  }

  /** AUTO-1, AUTO-15: any of an automation's fields; a null model is omp's default. */
  updateAutomation(principal: Principal, automationId: string, input: AutomationInput & { name?: string }): Automation {
    return this.transaction(() => {
      const current = this.visibleAutomation(principal, automationId);
      const next: Automation = {
        ...current,
        name: input.name ?? current.name,
        slug: input.slug ?? current.slug,
        instructions: input.instructions ?? current.instructions,
        model: input.model === undefined ? current.model : input.model,
        endMode: input.endMode ?? current.endMode,
        timeLimitMinutes: input.timeLimitMinutes ?? current.timeLimitMinutes,
        enabled: input.enabled ?? current.enabled,
        updatedAt: Date.now(),
      };
      this.checkAutomationNames(current.projectId, next.name, next.slug, automationId);
      this.db.prepare(
        "UPDATE automations SET name = ?, slug = ?, instructions = ?, model = ?, end_mode = ?, time_limit_minutes = ?, enabled = ?, updated_at = ? WHERE id = ?",
      ).run(next.name, next.slug, next.instructions, next.model, next.endMode, next.timeLimitMinutes, next.enabled ? 1 : 0, next.updatedAt, automationId);
      return next;
    });
  }

  /**
   * Deletes an automation with its triggers, firings, folder records, and runs; refused while a
   * run goes. People only. The ids of its runs are returned, whose chats and workspaces, and
   * the folder's directory, are the caller's to remove.
   */
  deleteAutomation(principal: Principal, automationId: string): { automation: Automation; runIds: string[] } {
    this.requireHuman(principal);
    return this.transaction(() => {
      const found = this.visibleAutomation(principal, automationId);
      const running = this.runningRunOf(automationId);
      if (running !== null) throw new StoreError(409, `automation "${found.name}" has a run going; end it first`, { sessionId: running.id });
      const runIds = this.db.prepare("SELECT id FROM sessions WHERE automation_id = ?").all(automationId).map((row) => String(row.id));
      for (const table of ["automation_firings", "automation_triggers", "automation_files", "sessions"]) {
        this.db.prepare(`DELETE FROM ${table} WHERE automation_id = ?`).run(automationId);
      }
      this.db.prepare("DELETE FROM automations WHERE id = ?").run(automationId);
      return { automation: found, runIds };
    });
  }

  /** AUTO-8: a trigger of the automation; its schedule's timezone is Europe/Budapest unless given. */
  addTrigger(principal: Principal, automationId: string, input: TriggerInput & { cron: string }): Trigger {
    return this.transaction(() => {
      this.visibleAutomation(principal, automationId);
      const created: Trigger = {
        id: randomUUID(),
        automationId,
        cron: input.cron,
        timezone: input.timezone ?? "Europe/Budapest",
        guardPath: input.guardPath ?? null,
        checkPath: input.checkPath ?? null,
        createdAt: Date.now(),
      };
      this.db.prepare("INSERT INTO automation_triggers (id, automation_id, cron, timezone, guard_path, check_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(created.id, automationId, created.cron, created.timezone, created.guardPath, created.checkPath, created.createdAt);
      return created;
    });
  }

  /** AUTO-8: changes a trigger; a null guard or check path removes it. */
  updateTrigger(principal: Principal, triggerId: string, input: TriggerInput & { cron?: string }): Trigger {
    return this.transaction(() => {
      const current = this.visibleTrigger(principal, triggerId).trigger;
      const next: Trigger = {
        ...current,
        cron: input.cron ?? current.cron,
        timezone: input.timezone ?? current.timezone,
        guardPath: input.guardPath === undefined ? current.guardPath : input.guardPath,
        checkPath: input.checkPath === undefined ? current.checkPath : input.checkPath,
      };
      this.db.prepare("UPDATE automation_triggers SET cron = ?, timezone = ?, guard_path = ?, check_path = ? WHERE id = ?")
        .run(next.cron, next.timezone, next.guardPath, next.checkPath, triggerId);
      return next;
    });
  }

  /** AUTO-8: removes a trigger; its firings stay in the automation's log. */
  removeTrigger(principal: Principal, triggerId: string): Trigger {
    return this.transaction(() => {
      const { trigger: found } = this.visibleTrigger(principal, triggerId);
      this.db.prepare("DELETE FROM automation_triggers WHERE id = ?").run(triggerId);
      return found;
    });
  }

  /** AUTO-7, AUTO-9, AUTO-11: the automation's runs, and the sessions on it that are none (`run` null), newest first. */
  listRuns(principal: Principal, automationId: string): Session[] {
    this.visibleAutomation(principal, automationId);
    return this.db.prepare("SELECT * FROM sessions WHERE automation_id = ? ORDER BY started_at DESC").all(automationId).map(session);
  }

  /** AUTO-7, AUTO-8: the automation's firings, newest first. */
  listFirings(principal: Principal, automationId: string): Firing[] {
    this.visibleAutomation(principal, automationId);
    return this.db.prepare("SELECT * FROM automation_firings WHERE automation_id = ? ORDER BY scheduled_at DESC, fired_at DESC").all(automationId).map(firing);
  }

  /**
   * AUTO-2, AUTO-8: records a trigger's scheduled time as it fires, or what became of it; the
   * store's own doing, so no principal. Each scheduled time of a trigger is recorded once: a
   * second is refused (409).
   */
  recordFiring(input: Omit<Firing, "id" | "automationId">): Firing {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT automation_id FROM automation_triggers WHERE id = ?").get(input.triggerId);
      if (row === undefined) throw new StoreError(404, `trigger ${input.triggerId} not found`);
      const created: Firing = { ...input, id: randomUUID(), automationId: String(row.automation_id) };
      try {
        this.db.prepare(
          "INSERT INTO automation_firings (id, automation_id, trigger_id, scheduled_at, fired_at, caught_up, guard_verdict, check_verdict, outcome, session_id, error) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          created.id, created.automationId, created.triggerId, created.scheduledAt, created.firedAt, created.caughtUp ? 1 : 0,
          created.guard === null ? null : JSON.stringify(created.guard), created.check === null ? null : JSON.stringify(created.check),
          created.outcome, created.sessionId, created.error,
        );
      } catch (cause) {
        if (cause instanceof Error && /UNIQUE constraint failed/.test(cause.message)) {
          throw new StoreError(409, `trigger ${input.triggerId} already fired for ${new Date(input.scheduledAt).toISOString()}`);
        }
        throw cause;
      }
      return created;
    });
  }

  /** AUTO-8: what became of a pending firing: what its guard and check said, and its outcome. A settled firing stays as it is. */
  settleFiring(firingId: string, result: Pick<Firing, "guard" | "check" | "outcome" | "sessionId" | "error">): void {
    this.db.prepare("UPDATE automation_firings SET guard_verdict = ?, check_verdict = ?, outcome = ?, session_id = ?, error = ? WHERE id = ? AND outcome = 'pending'").run(
      result.guard === null ? null : JSON.stringify(result.guard), result.check === null ? null : JSON.stringify(result.check),
      result.outcome, result.sessionId, result.error, firingId,
    );
  }

  /** AUTO-8: firings still pending when the gateway that fired them stopped fail, with `error`; returns how many. */
  failPendingFirings(error: string): number {
    return Number(this.db.prepare("UPDATE automation_firings SET outcome = 'failed', error = ? WHERE outcome = 'pending'").run(error).changes);
  }

  /**
   * AUTO-1, AUTO-9: records a run of the automation, a session that belongs to it and to no
   * task. Refused while the automation is off or a run of it goes. `principal` is who started
   * it ("run now"); null when one of its triggers did. A host run follows HOST-1 and AUTH-3 as a
   * task's host session does: only the owner starts one, in a project that allows them. Its
   * worktree and container are the caller's job.
   */
  createRun(
    principal: Principal | null,
    automationId: string,
    input: { machine?: string; runtime: SessionRuntime; triggerContext?: string },
  ): Session {
    const system = this.ownerPrincipal();
    if (input.runtime === "host" && (principal === null || !this.isOwner(principal))) throw new StoreError(403, "only the store's owner starts host runs");
    return this.transaction(() => {
      const owner = this.visibleAutomation(principal ?? system, automationId);
      if (!owner.enabled) throw new StoreError(409, `automation "${owner.name}" is off; it starts no runs`);
      const running = this.runningRunOf(automationId);
      if (running !== null) throw new StoreError(409, `automation "${owner.name}" has a run going`, { sessionId: running.id });
      if (input.runtime === "host" && !this.visibleProject(system, owner.projectId).hostSessions) {
        throw new StoreError(403, "this project does not allow host sessions");
      }
      const startedBy = principal === null ? null : actorOf(principal);
      const created: Session = {
        id: randomUUID(),
        projectId: owner.projectId,
        taskId: null,
        automationId,
        name: owner.name,
        branch: null,
        baseRef: null,
        machine: input.machine ?? null,
        runtime: input.runtime,
        checkout: false,
        model: owner.model,
        startedAt: Date.now(),
        endedAt: null,
        run: { startedBy, triggerContext: input.triggerContext ?? "", outcome: null, reason: null, endedBy: null },
      };
      const [kind, id] = actorColumns(startedBy);
      this.db.prepare(
        "INSERT INTO sessions (id, project_id, automation_id, name, machine, runtime, checkout, model, started_at, run_started_by_kind, run_started_by_id, run_trigger_context, is_run) " +
          "VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 1)",
      ).run(created.id, created.projectId, automationId, created.name, created.machine, created.runtime, created.model, created.startedAt, kind, id, created.run?.triggerContext ?? "");
      return created;
    });
  }

  /** AUTO-10: how a run ended, or waits for review, and why; it ends separately (endRun). */
  setRunOutcome(sessionId: string, outcome: RunOutcome, reason: string | null): void {
    this.db.prepare("UPDATE sessions SET run_outcome = ?, run_reason = ? WHERE id = ? AND is_run = 1").run(outcome, reason, sessionId);
  }

  /**
   * AUTO-11: a session on the automation that is no run: a person works on it with its agent,
   * on a branch of its own or a run's. Like a task's session (TASK-3), people start it; host
   * ones only the owner, where the project allows them (HOST-1). Its worktree and container are
   * the caller's job.
   */
  createAutomationSession(principal: Principal, automationId: string, input: { machine?: string; model?: string; runtime: SessionRuntime }): Session {
    if (input.runtime === "host") this.requireOwner(principal);
    else this.requireHuman(principal);
    return this.transaction(() => {
      const owner = this.visibleAutomation(principal, automationId);
      if (input.runtime === "host" && !this.visibleProject(principal, owner.projectId).hostSessions) {
        throw new StoreError(403, "this project does not allow host sessions");
      }
      const created: Session = {
        id: randomUUID(),
        projectId: owner.projectId,
        taskId: null,
        automationId,
        name: owner.name,
        branch: null,
        baseRef: null,
        machine: input.machine ?? null,
        runtime: input.runtime,
        checkout: false,
        model: input.model ?? owner.model,
        startedAt: Date.now(),
        endedAt: null,
        run: null,
      };
      this.db.prepare("INSERT INTO sessions (id, project_id, automation_id, name, machine, runtime, checkout, model, started_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)")
        .run(created.id, created.projectId, automationId, created.name, created.machine, created.runtime, created.model, created.startedAt);
      return created;
    });
  }

  /**
   * STORE-6: every record of the project, in the order the store wrote them, with the store's
   * owner, the people the records name, and the project's Cloudflare tokens (CLOUDFLARE-3).
   */
  projectRecords(principal: Principal, projectId: string): ProjectRecords {
    this.requireOwner(principal);
    const found = this.visibleProject(principal, projectId);
    const ofProject = (sql: string) => this.db.prepare(sql).all(projectId);
    const ofTasks = (table: string, order: string) =>
      ofProject(`SELECT r.* FROM ${table} r JOIN tasks t ON t.id = r.task_id WHERE t.project_id = ? ORDER BY ${order}`);
    const ofAutomations = (table: string, order: string) =>
      ofProject(`SELECT r.* FROM ${table} r JOIN automations a ON a.id = r.automation_id WHERE a.project_id = ? ORDER BY ${order}`);
    const tasks = ofProject("SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at, id").map(task);
    const sessions = ofProject("SELECT * FROM sessions WHERE project_id = ? ORDER BY started_at, id").map(session);
    const comments = ofTasks("comments", "r.rowid").map(comment);
    const folderFiles = ofTasks("folder_files", "r.task_id, r.path").map((row) => ({ taskId: String(row.task_id), ...folderFile(row) }));
    const automationFiles = ofAutomations("automation_files", "r.automation_id, r.path").map((row) => ({ automationId: String(row.automation_id), ...folderFile(row) }));
    const events = ofTasks("task_events", "r.id").map((row) => ({
      taskId: String(row.task_id),
      at: Number(row.at),
      actor: actorOfRow(row.actor_kind, row.actor_id),
      event: historyEvent.parse(JSON.parse(String(row.data))),
    }));
    const named = new Set<string>();
    for (const who of [
      ...comments.map((found) => found.author),
      ...folderFiles.map((file) => file.addedBy),
      ...automationFiles.map((file) => file.addedBy),
      ...events.map((entry) => entry.actor),
      ...sessions.flatMap((found) => (found.run === null ? [] : [found.run.startedBy, found.run.endedBy])),
    ]) {
      if (who?.kind === "person") named.add(who.personId);
    }
    for (const id of [...tasks.map((found) => found.assigneeId), ...events.map(({ event }) => (event.kind === "assignee" ? event.personId : null))]) {
      if (id !== null) named.add(id);
    }
    return {
      version: 3,
      project: found,
      people: this.db.prepare("SELECT * FROM people ORDER BY owner DESC, created_at, id").all().map(person).filter((found) => found.owner || named.has(found.id)),
      topics: ofProject("SELECT * FROM topics WHERE project_id = ? ORDER BY created_at, id").map(topic),
      tasks,
      topicLinks: ofTasks("task_topics", "r.rowid").map((row) => ({ taskId: String(row.task_id), topicId: String(row.topic_id), linkedAt: Number(row.linked_at) })),
      automations: ofProject("SELECT * FROM automations WHERE project_id = ? ORDER BY created_at, id").map(automation),
      triggers: ofAutomations("automation_triggers", "r.created_at, r.id").map(trigger),
      sessions,
      firings: ofAutomations("automation_firings", "r.scheduled_at, r.id").map(firing),
      comments,
      folderFiles,
      automationFiles,
      events,
      cloudflareTokens: this.cloudflareTokens(projectId),
    };
  }

  /**
   * STORE-6: a project moved here from another store, with the ids it had there so its links
   * and branches stay valid; refused when this store has any of them already. Whoever its
   * records name is this store's person (matchPeople); anyone this store lacks is added with
   * their id. `repoPath` is the project's main checkout on this machine; host sessions stay off
   * until this store's owner allows them (HOST-1). Its Cloudflare tokens come along (CLOUDFLARE-3).
   */
  importProject(principal: Principal, records: ProjectRecords, repoPath: string | null): { project: Project; added: Person[] } {
    this.requireOwner(principal);
    return this.transaction(() => {
      const moved = records.project;
      if (this.db.prepare("SELECT 1 FROM projects WHERE id = ? OR name = ?").get(moved.id, moved.name) !== undefined) {
        throw new StoreError(409, `this store already has a project ${moved.name} or ${moved.id}`);
      }
      for (const [table, ids] of Object.entries({
        topics: records.topics.map((found) => found.id),
        tasks: records.tasks.map((found) => found.id),
        automations: records.automations.map((found) => found.id),
        automation_triggers: records.triggers.map((found) => found.id),
        automation_firings: records.firings.map((found) => found.id),
        sessions: records.sessions.map((found) => found.id),
        comments: records.comments.map((found) => found.id),
      })) {
        const taken = ids.find((id) => this.db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== undefined);
        if (taken !== undefined) throw new StoreError(409, `this store already has a record ${taken} of ${table}`);
      }
      const match = matchPeople(records.people, this.db.prepare("SELECT * FROM people").all().map(person));
      const added: Person[] = [];
      for (const moved of records.people.filter((candidate) => match.get(candidate.id) === null)) {
        const created: Person = { id: moved.id, name: moved.name, email: moved.email?.toLowerCase() ?? null, color: moved.color, owner: false, createdAt: Date.now() };
        this.db.prepare("INSERT INTO people (id, name, email, color, owner, created_at) VALUES (?, ?, ?, ?, 0, ?)")
          .run(created.id, created.name, created.email, created.color, created.createdAt);
        match.set(moved.id, moved.id);
        added.push(created);
      }
      const here = (personId: string) => {
        const found = match.get(personId);
        if (found == null) throw new Error(`person ${personId} is not in the bundle`);
        return found;
      };
      const actorHere = (who: Actor | null): Actor | null => (who?.kind === "person" ? { kind: "person", personId: here(who.personId) } : who);
      this.db.prepare("INSERT INTO projects (id, name, repo_path, host_sessions, created_at) VALUES (?, ?, ?, 0, ?)").run(moved.id, moved.name, repoPath, moved.createdAt);
      if (records.cloudflareTokens !== null) {
        this.db.prepare("INSERT INTO cloudflare_tokens (project_id, read_token, write_token, updated_at) VALUES (?, ?, ?, ?)")
          .run(moved.id, records.cloudflareTokens.read, records.cloudflareTokens.write, Date.now());
      }
      for (const found of records.topics) {
        this.db.prepare("INSERT INTO topics (id, project_id, name, color, created_at, status, status_revision) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(found.id, moved.id, found.name, found.color, found.createdAt, found.status, found.statusRevision);
      }
      for (const found of records.tasks) {
        this.db.prepare(
          "INSERT INTO tasks (id, project_id, title, description, state, assignee_id, branch, base_ref, status, status_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          found.id, moved.id, found.title, found.description, found.state, found.assigneeId === null ? null : here(found.assigneeId),
          found.branch, found.baseRef, found.status, found.statusRevision, found.createdAt, found.updatedAt,
        );
      }
      for (const link of records.topicLinks) {
        this.db.prepare("INSERT INTO task_topics (task_id, topic_id, linked_at) VALUES (?, ?, ?)").run(link.taskId, link.topicId, link.linkedAt);
      }
      for (const found of records.automations) {
        this.db.prepare(
          "INSERT INTO automations (id, project_id, name, slug, instructions, model, end_mode, time_limit_minutes, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          found.id, moved.id, found.name, found.slug, found.instructions, found.model, found.endMode, found.timeLimitMinutes, found.enabled ? 1 : 0,
          found.createdAt, found.updatedAt,
        );
      }
      for (const found of records.triggers) {
        this.db.prepare("INSERT INTO automation_triggers (id, automation_id, cron, timezone, guard_path, check_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(found.id, found.automationId, found.cron, found.timezone, found.guardPath, found.checkPath, found.createdAt);
      }
      for (const found of records.sessions) {
        const [startedKind, startedId] = actorColumns(actorHere(found.run?.startedBy ?? null));
        const [endedKind, endedId] = actorColumns(actorHere(found.run?.endedBy ?? null));
        this.db.prepare(
          "INSERT INTO sessions (id, project_id, task_id, automation_id, name, branch, base_ref, machine, runtime, checkout, model, started_at, ended_at, " +
            "run_started_by_kind, run_started_by_id, run_trigger_context, run_outcome, run_ended_by_kind, run_ended_by_id, run_reason, is_run) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          found.id, moved.id, found.taskId, found.automationId, found.name, found.branch, found.baseRef, found.machine, found.runtime, found.checkout ? 1 : 0,
          found.model, found.startedAt, found.endedAt, startedKind, startedId, found.run?.triggerContext ?? null, found.run?.outcome ?? null, endedKind, endedId,
          found.run?.reason ?? null, found.run === null ? 0 : 1,
        );
      }
      for (const found of records.firings) {
        this.db.prepare(
          "INSERT INTO automation_firings (id, automation_id, trigger_id, scheduled_at, fired_at, caught_up, guard_verdict, check_verdict, outcome, session_id, error) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          found.id, found.automationId, found.triggerId, found.scheduledAt, found.firedAt, found.caughtUp ? 1 : 0, found.guard === null ? null : JSON.stringify(found.guard),
          found.check === null ? null : JSON.stringify(found.check), found.outcome, found.sessionId, found.error,
        );
      }
      for (const found of records.comments) {
        const [kind, id] = actorColumns(actorHere(found.author));
        this.db.prepare("INSERT INTO comments (id, task_id, author_kind, author_id, body, created_at, edited_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(found.id, found.taskId, kind, id, found.body, found.createdAt, found.editedAt);
      }
      for (const file of records.folderFiles) {
        const [kind, id] = actorColumns(actorHere(file.addedBy));
        this.db.prepare(
          "INSERT INTO folder_files (task_id, path, size, content_type, added_by_kind, added_by_id, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(file.taskId, file.path, file.size, file.contentType, kind, id, file.addedAt, file.updatedAt);
      }
      for (const file of records.automationFiles) {
        const [kind, id] = actorColumns(actorHere(file.addedBy));
        this.db.prepare(
          "INSERT INTO automation_files (automation_id, path, size, content_type, added_by_kind, added_by_id, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(file.automationId, file.path, file.size, file.contentType, kind, id, file.addedAt, file.updatedAt);
      }
      for (const entry of records.events) {
        const [kind, id] = actorColumns(actorHere(entry.actor));
        const event = entry.event.kind === "assignee" && entry.event.personId !== null ? { ...entry.event, personId: here(entry.event.personId) } : entry.event;
        this.db.prepare("INSERT INTO task_events (task_id, at, actor_kind, actor_id, data) VALUES (?, ?, ?, ?, ?)").run(entry.taskId, entry.at, kind, id, JSON.stringify(event));
      }
      return { project: this.visibleProject(principal, moved.id), added };
    });
  }

  /** STORE-6: forgets a project that moved to another store, with every record of it; people stay. */
  deleteProject(principal: Principal, projectId: string): void {
    this.requireOwner(principal);
    this.transaction(() => {
      this.visibleProject(principal, projectId);
      for (const table of ["task_events", "comments", "folder_files", "task_topics"]) {
        this.db.prepare(`DELETE FROM ${table} WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)`).run(projectId);
      }
      for (const table of ["automation_firings", "automation_triggers", "automation_files"]) {
        this.db.prepare(`DELETE FROM ${table} WHERE automation_id IN (SELECT id FROM automations WHERE project_id = ?)`).run(projectId);
      }
      for (const table of ["sessions", "tasks", "automations", "topics", "cloudflare_tokens"]) this.db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(projectId);
      this.db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    });
  }

  /** Sessions whose agent socket must be listening. */
  runningSessionIds(): string[] {
    return this.db.prepare("SELECT id FROM sessions WHERE ended_at IS NULL").all().map((row) => String(row.id));
  }
}
