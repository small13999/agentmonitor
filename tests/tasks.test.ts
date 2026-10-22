import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before } from "node:test";
import { Gateway } from "./harness.ts";
import { spec } from "./spec.ts";

interface Project { id: string; name: string }
interface Topic { id: string; name: string }
interface Task { id: string; title: string; description: string; state: string; branch: string | null; status: string; statusRevision: number }
interface TaskSummary { task: Task; topics: Topic[]; sessionId: string | null }
interface Session { id: string; taskId: string; name: string; endedAt: number | null }

let gateway: Gateway;
let project: Project;

before(async () => {
  gateway = await Gateway.start();
  project = await gateway.data<Project>("POST", "/projects", { name: "draftcoach" });
});
after(async () => {
  await gateway?.stop();
});

function createTask(title: string, description?: string): Promise<Task> {
  return gateway.data<Task>("POST", `/projects/${project.id}/tasks`, { title, ...(description === undefined ? {} : { description }) });
}

async function summaryOf(taskId: string): Promise<TaskSummary> {
  const found = (await gateway.data<TaskSummary[]>("GET", `/projects/${project.id}/tasks`)).find((summary) => summary.task.id === taskId);
  assert.ok(found, `task ${taskId} is listed`);
  return found;
}

spec("TASK-1", "a task has a title, a description, and one of five states", async () => {
  const task = await createTask("Patch notes 26.21", "Translate the JP notes and publish them.");
  assert.equal(task.title, "Patch notes 26.21");
  assert.equal(task.description, "Translate the JP notes and publish them.");
  assert.equal(task.state, "open");

  const moved = await gateway.data<Task>("PATCH", `/tasks/${task.id}`, { state: "in_review" });
  assert.equal(moved.state, "in_review");
  assert.equal((await gateway.api("PATCH", `/tasks/${task.id}`, { state: "blocked" })).status, 400, "an unknown state is refused");

  const finished = await gateway.data<Task>("POST", `/tasks/${task.id}/finish`, { state: "cancelled" });
  assert.equal(finished.state, "cancelled");
  assert.equal((await summaryOf(task.id)).task.state, "cancelled");
});

spec("TASK-3", "creating a task starts no session; starting one is separate", async () => {
  const task = await createTask("Leaderboard filters");
  assert.equal((await summaryOf(task.id)).sessionId, null);
  const running = await gateway.data<Session[]>("GET", `/projects/${project.id}/sessions`);
  assert.ok(!running.some((session) => session.taskId === task.id), "no session runs for a new task");

  const started = await gateway.data<Session>("POST", `/tasks/${task.id}/sessions`, {});
  assert.equal(started.taskId, task.id);
  const summary = await summaryOf(task.id);
  assert.equal(summary.sessionId, started.id);
  assert.equal(summary.task.state, "in_progress", "starting work moves an open task in progress");
});

spec("TASK-5", "a task has at most one running session", async () => {
  const task = await createTask("Single runner");
  const first = await gateway.data<Session>("POST", `/tasks/${task.id}/sessions`, {});
  const second = await gateway.api("POST", `/tasks/${task.id}/sessions`, {});
  assert.equal(second.status, 409);

  await gateway.data("POST", `/sessions/${first.id}/end`, {});
  const next = await gateway.data<Session>("POST", `/tasks/${task.id}/sessions`, {});
  assert.notEqual(next.id, first.id);
  const detail = await gateway.data<{ sessions: Session[] }>("GET", `/tasks/${task.id}`);
  assert.deepEqual(detail.sessions.map((session) => session.id), [next.id, first.id], "the task keeps every session, newest first");
});

spec("TASK-7", "agents keep a task's status, at most 50 lines, refused when stale", async () => {
  const task = await createTask("Status keeper");
  const session = await gateway.data<Session>("POST", `/tasks/${task.id}/sessions`, {});

  const tooLong = Array.from({ length: 51 }, (_, i) => `line ${i + 1}`).join("\n");
  const refused = gateway.am(session.id, ["task", "set-status", "--base", "0"], tooLong);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /51 lines; the limit is 50/);

  assert.equal(gateway.am(session.id, ["task", "set-status", "--base", "0"], "Done: JP\nNext: EN\n").code, 0);
  const stale = gateway.am(session.id, ["task", "set-status", "--base", "0"], "Done: nothing\n");
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /current revision 1/);
  assert.equal(gateway.am(session.id, ["task", "status"]).stdout, "# revision 1\nDone: JP\nNext: EN\n");
  assert.equal((await summaryOf(task.id)).task.status, "Done: JP\nNext: EN\n");
});

/** The store's schema before tasks existed: sessions with their own topic links and notes. */
const SESSIONS_ONLY_SCHEMA = `
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, repo_path TEXT, created_at INTEGER NOT NULL);
CREATE TABLE topics (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL, created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT '', status_revision INTEGER NOT NULL DEFAULT 0, UNIQUE (project_id, name)
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL, branch TEXT, base_ref TEXT,
  machine TEXT, model TEXT, started_at INTEGER NOT NULL, ended_at INTEGER
);
CREATE TABLE session_topics (
  session_id TEXT NOT NULL REFERENCES sessions(id), topic_id TEXT NOT NULL REFERENCES topics(id), linked_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, topic_id)
);
CREATE TABLE session_notes (session_id TEXT PRIMARY KEY REFERENCES sessions(id), text TEXT NOT NULL, revision INTEGER NOT NULL);
`;

spec("TASK-10", "sessions from before tasks become tasks with their name, branch, topic links, and notes", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "am-gw-"));
  const old = new DatabaseSync(join(stateDir, "store.sqlite"));
  old.exec(SESSIONS_ONLY_SCHEMA);
  old.exec(`
    INSERT INTO projects VALUES ('00000000-0000-4000-8000-000000000001', 'draftcoach', NULL, 1);
    INSERT INTO topics (id, project_id, name, created_at) VALUES ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000001', 'Ads', 1);
    INSERT INTO sessions VALUES ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001', 'jogi', 'am/jogi-1a2b', 'origin/main', 'pc', NULL, 10, NULL);
    INSERT INTO sessions VALUES ('00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000001', 'test', 'am/test-3c4d', 'origin/main', 'pc', NULL, 20, 30);
    INSERT INTO session_topics VALUES ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-0000000000a1', 15);
    INSERT INTO session_notes VALUES ('00000000-0000-4000-8000-000000000011', 'Ship after QA', 3);
  `);
  old.close();

  const migrated = await Gateway.start({ runtime: "none", stateDir });
  try {
    const tasks = await migrated.data<TaskSummary[]>("GET", "/projects/00000000-0000-4000-8000-000000000001/tasks");
    assert.deepEqual(
      tasks.map(({ task, topics, sessionId }) => [task.title, task.branch, task.state, topics.map((topic) => topic.name), sessionId]),
      [
        ["jogi", "am/jogi-1a2b", "in_progress", ["Ads"], "00000000-0000-4000-8000-000000000011"],
        ["test", "am/test-3c4d", "done", [], null],
      ],
    );
    const jogi = tasks[0].task.id;
    assert.deepEqual(await migrated.data("GET", `/tasks/${jogi}/notes`), { text: "Ship after QA", revision: 3 });
    const { session } = await migrated.data<{ session: Session }>("GET", "/sessions/00000000-0000-4000-8000-000000000011");
    assert.equal(session.taskId, jogi);
    // The running session's agent works on the task now.
    assert.match(migrated.am(session.id, ["whoami"]).stdout, /^task {4}jogi \(/m);
  } finally {
    await migrated.stop();
  }
});
