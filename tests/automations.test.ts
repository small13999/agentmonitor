import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before } from "node:test";
import type { Automation, AutomationDetail, AutomationSummary, FolderFile, Person, Session, Task, TaskDetail, Trigger } from "../shared/api.ts";
import { Gateway } from "./harness.ts";
import { spec } from "./spec.ts";

let gateway: Gateway;
let projectId: string;
let owner: Person;
let scratch: string;

before(async () => {
  gateway = await Gateway.start();
  projectId = (await gateway.data<{ id: string }>("POST", "/projects", { name: "draftcoach" })).id;
  owner = (await gateway.data<{ person: Person }>("GET", "/me")).person;
  scratch = mkdtempSync(join(tmpdir(), "am-automations-test-"));
});

after(async () => {
  await gateway?.stop();
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

/** A task with a session of records only: its agent's am reaches the store through the session's socket. */
async function agentSession(title: string): Promise<Session> {
  const task = await gateway.data<Task>("POST", `/projects/${projectId}/tasks`, { title });
  return gateway.data<Session>("POST", `/tasks/${task.id}/sessions`, {});
}

spec("AUTO-1", "an automation has a name, instructions, a model, triggers, an end mode, a time limit, a folder, and an on/off switch; one that is off starts no runs", async () => {
  const created = await gateway.data<Automation>("POST", `/projects/${projectId}/automations`, { name: "Patch review", instructions: "Review the new patch notes." });
  // An automation starts on, ends its runs with Finish after at most 120 minutes, on omp's default model.
  assert.deepEqual(
    [created.name, created.instructions, created.model, created.endMode, created.timeLimitMinutes, created.enabled, created.slug],
    ["Patch review", "Review the new patch notes.", null, "finish", 120, true, "patch-review"],
  );
  const changed = await gateway.data<Automation>("PATCH", `/automations/${created.id}`, { model: "fake/scripted", endMode: "review", timeLimitMinutes: 45 });
  assert.deepEqual([changed.model, changed.endMode, changed.timeLimitMinutes, changed.instructions], ["fake/scripted", "review", 45, "Review the new patch notes."]);
  assert.equal((await gateway.api("PATCH", `/automations/${created.id}`, { endMode: "deploy" })).status, 400);
  assert.equal((await gateway.api("POST", `/projects/${projectId}/automations`, { name: "Patch review" })).status, 409);

  // Triggers: a cron schedule in Europe/Budapest unless another timezone is given, with a guard and a check in the folder.
  const weekday = await gateway.data<Trigger>("POST", `/automations/${created.id}/triggers`, { cron: "0 9 * * 1-5", guardPath: "guard.sh" });
  assert.deepEqual([weekday.cron, weekday.timezone, weekday.guardPath, weekday.checkPath], ["0 9 * * 1-5", "Europe/Budapest", "guard.sh", null]);
  const nightly = await gateway.data<Trigger>("POST", `/automations/${created.id}/triggers`, { cron: "30 2 * * *", timezone: "Asia/Tokyo", checkPath: "check.md" });
  assert.equal((await gateway.api("POST", `/automations/${created.id}/triggers`, { cron: "every morning" })).status, 400);
  assert.equal((await gateway.api("POST", `/automations/${created.id}/triggers`, { cron: "0 9 * * *", timezone: "Mars/Olympus" })).status, 400);
  assert.equal((await gateway.api("POST", `/automations/${created.id}/triggers`, { cron: "0 9 * * *", guardPath: "../guard.sh" })).status, 400);
  const unchecked = await gateway.data<Trigger>("PATCH", `/triggers/${nightly.id}`, { checkPath: null });
  assert.equal(unchecked.checkPath, null);

  // The folder, shared by all its runs, holds what people and agents put there.
  assert.equal((await fetch(`${gateway.url}/api/store/automations/${created.id}/folder/memory.md`, { method: "PUT", body: "Reviewed up to 26.20\n" })).status, 200);
  const memory = await fetch(`${gateway.url}/api/store/automations/${created.id}/folder/memory.md`);
  assert.equal(await memory.text(), "Reviewed up to 26.20\n");

  // Off, it starts no runs.
  await gateway.data("PATCH", `/automations/${created.id}`, { enabled: false });
  const refused = await gateway.api("POST", `/automations/${created.id}/runs`, {});
  assert.equal(refused.status, 409);
  assert.match(String(refused.body.error), /is off/);
  assert.deepEqual((await gateway.data<AutomationDetail>("GET", `/automations/${created.id}`)).runs, []);

  // On, "run now" starts a run: a session of the automation and of no task, started by the person.
  await gateway.data("PATCH", `/automations/${created.id}`, { enabled: true });
  const run = await gateway.data<Session>("POST", `/automations/${created.id}/runs`, {});
  assert.deepEqual([run.taskId, run.automationId, run.model, run.run], [null, created.id, "fake/scripted", {
    startedBy: { kind: "person", personId: owner.id },
    triggerContext: "",
    outcome: null,
    reason: null,
    endedBy: null,
  }]);
  assert.equal((await gateway.api("POST", `/automations/${created.id}/runs`, {})).status, 409, "one run at a time");
  // Its agent writes its outputs into the automation's folder.
  writeFileSync(join(scratch, "review.md"), "# 26.21\n\nFine.\n");
  const added = gateway.am(run.id, ["folder", "add", join(scratch, "review.md"), `runs/${run.id.slice(0, 8)}/review.md`]);
  assert.equal(added.code, 0, added.stderr);
  const files = await gateway.data<FolderFile[]>("GET", `/automations/${created.id}/folder`);
  assert.deepEqual(files.map((file) => [file.path, file.addedBy]), [
    ["memory.md", { kind: "person", personId: owner.id }],
    [`runs/${run.id.slice(0, 8)}/review.md`, { kind: "agent", sessionId: run.id }],
  ]);

  await gateway.data("POST", `/sessions/${run.id}/end`);
  const [summary] = (await gateway.data<AutomationSummary[]>("GET", `/projects/${projectId}/automations`)).filter((found) => found.automation.id === created.id);
  assert.deepEqual([summary.triggers.map((found) => found.id), summary.sessionId], [[weekday.id, nightly.id], null]);
  const detail = await gateway.data<AutomationDetail>("GET", `/automations/${created.id}`);
  assert.deepEqual(detail.runs.map((found) => [found.id, found.run?.outcome, found.run?.endedBy]), [[run.id, "ended", { kind: "person", personId: owner.id }]]);
});

spec("AUTO-15", "an agent creates and changes an automation with am automation, and people see it as the agent set it up", async () => {
  const agent = await agentSession("Set up the weekly digest");
  const am = (args: string[], stdin = "") => {
    const result = gateway.am(agent.id, args, stdin);
    assert.equal(result.code, 0, `am ${args.join(" ")}: ${result.stderr}`);
    return result.stdout;
  };
  assert.match(am(["automation", "create", "Weekly digest", "--model", "fake/scripted", "--end-mode", "review", "--time-limit", "30", "--off"], "Write the weekly digest.\n"), /^created automation "Weekly digest"/);
  am(["automation", "set", "Weekly digest", "--name", "Weekly recap", "--slug", "recap", "--instructions"], "Write the weekly recap from memory.md.\n");
  am(["automation", "trigger", "add", "Weekly recap", "--cron", "0 8 * * 1", "--timezone", "UTC", "--check", "check.md"]);
  writeFileSync(join(scratch, "memory.md"), "Last recap: week 42\n");
  am(["automation", "folder", "Weekly recap", "add", join(scratch, "memory.md")]);

  // People see the automation as the agent set it up, and who put the file into its folder.
  const [summary] = (await gateway.data<AutomationSummary[]>("GET", `/projects/${projectId}/automations`)).filter((found) => found.automation.name === "Weekly recap");
  assert.ok(summary !== undefined, "the person's list holds the automation");
  const { automation, triggers } = summary;
  assert.deepEqual(
    [automation.instructions, automation.model, automation.endMode, automation.timeLimitMinutes, automation.enabled, automation.slug],
    ["Write the weekly recap from memory.md.\n", "fake/scripted", "review", 30, false, "recap"],
  );
  assert.deepEqual(triggers.map((found) => [found.cron, found.timezone, found.guardPath, found.checkPath]), [["0 8 * * 1", "UTC", null, "check.md"]]);
  const files = await gateway.data<FolderFile[]>("GET", `/automations/${automation.id}/folder`);
  assert.deepEqual(files.map((file) => [file.path, file.addedBy]), [["memory.md", { kind: "agent", sessionId: agent.id }]]);

  // The agent changes the trigger, which it names by id, and runs the automation once it is on.
  const [trigger] = triggers;
  am(["automation", "trigger", "set", "Weekly recap", trigger.id, "--guard", "guard.sh", "--check", "none"]);
  assert.deepEqual((await gateway.data<AutomationDetail>("GET", `/automations/${automation.id}`)).triggers.map((found) => [found.guardPath, found.checkPath]), [["guard.sh", null]]);
  const off = gateway.am(agent.id, ["automation", "run", "Weekly recap"]);
  assert.equal(off.code, 1);
  assert.match(off.stderr, /is off/);
  am(["automation", "set", "recap", "--on"]);
  assert.match(am(["automation", "run", "Weekly recap"]), /^started run [0-9a-f]{8} of "Weekly recap"/);
  const shown = am(["automation", "show", "Weekly recap"]);
  assert.match(shown, /^state {6}on$/m);
  assert.match(shown, /Write the weekly recap from memory\.md\./);
  const { runs } = await gateway.data<AutomationDetail>("GET", `/automations/${automation.id}`);
  assert.deepEqual(runs.map((found) => [found.automationId, found.run?.startedBy, found.endedAt]), [[automation.id, { kind: "agent", sessionId: agent.id }, null]]);

  // The run's own agent sees which automation it serves; a task command needs a task named.
  assert.match(gateway.am(runs[0].id, ["whoami"]).stdout, new RegExp(`^automation Weekly recap \\(${automation.id}\\), run ${runs[0].id.slice(0, 8)}$`, "m"));
  assert.match(gateway.am(runs[0].id, ["automation", "show"]).stdout, new RegExp(`^automation Weekly recap \\(${automation.id}\\)$`, "m"));
  const taskless = gateway.am(runs[0].id, ["task", "show"]);
  assert.equal(taskless.code, 1);
  assert.match(taskless.stderr, /belongs to no task: name one with --task ID/);
  await gateway.data("POST", `/sessions/${runs[0].id}/end`);

  am(["automation", "trigger", "remove", "Weekly recap", trigger.id]);
  assert.deepEqual((await gateway.data<AutomationDetail>("GET", `/automations/${automation.id}`)).triggers, []);
});

/** A store from before automations (SESSION-5): sessions belonged to tasks only. */
const TASK_SESSIONS_SCHEMA = `
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, repo_path TEXT, host_sessions INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT, color TEXT NOT NULL, owner INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL, assignee_id TEXT REFERENCES people(id), branch TEXT, base_ref TEXT, status TEXT NOT NULL DEFAULT '',
  status_revision INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT NOT NULL REFERENCES tasks(id), name TEXT NOT NULL,
  branch TEXT, base_ref TEXT, machine TEXT, runtime TEXT NOT NULL DEFAULT 'container', checkout INTEGER NOT NULL DEFAULT 0, model TEXT,
  started_at INTEGER NOT NULL, ended_at INTEGER
);
CREATE TABLE task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), at INTEGER NOT NULL, actor_kind TEXT, actor_id TEXT, data TEXT NOT NULL
);
`;

spec("SESSION-5", "sessions from before automations stay their tasks', and the store takes runs of automations beside them", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "am-gw-"));
  const old = new DatabaseSync(join(stateDir, "store.sqlite"));
  old.exec(TASK_SESSIONS_SCHEMA);
  old.exec(`
    INSERT INTO projects (id, name, created_at) VALUES ('00000000-0000-4000-8000-000000000001', 'draftcoach', 1);
    INSERT INTO tasks (id, project_id, title, state, branch, base_ref, created_at, updated_at)
      VALUES ('00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000001', 'Patch notes', 'in_progress', 'am/patch-notes-1a2b', 'main', 2, 2);
    INSERT INTO sessions (id, project_id, task_id, name, branch, base_ref, machine, runtime, checkout, model, started_at, ended_at)
      VALUES ('00000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000021', 'Patch notes',
              'am/patch-notes-1a2b', 'main', 'pc', 'container', 0, 'fake/scripted', 3, 4),
             ('00000000-0000-4000-8000-000000000032', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000021', 'Patch notes',
              'am/patch-notes-1a2b', 'main', 'pc', 'host', 0, NULL, 5, NULL);
  `);
  old.close();

  const migrated = await Gateway.start({ runtime: "none", stateDir });
  try {
    const { sessions } = await migrated.data<TaskDetail>("GET", "/tasks/00000000-0000-4000-8000-000000000021");
    const kept = { projectId: "00000000-0000-4000-8000-000000000001", taskId: "00000000-0000-4000-8000-000000000021", automationId: null, name: "Patch notes", branch: "am/patch-notes-1a2b", baseRef: "main", machine: "pc", checkout: false, previewPort: null, run: null };
    assert.deepEqual(sessions, [
      { ...kept, id: "00000000-0000-4000-8000-000000000032", runtime: "host", model: null, startedAt: 5, endedAt: null },
      { ...kept, id: "00000000-0000-4000-8000-000000000031", runtime: "container", model: "fake/scripted", startedAt: 3, endedAt: 4 },
    ]);
    // The running session's agent still works on its task.
    assert.match(migrated.am("00000000-0000-4000-8000-000000000032", ["whoami"]).stdout, /^task {4}Patch notes \(00000000-0000-4000-8000-000000000021, in_progress\)$/m);

    // A run belongs to its automation and to no task; the task keeps its own sessions.
    const automation = await migrated.data<Automation>("POST", "/projects/00000000-0000-4000-8000-000000000001/automations", { name: "Patch review" });
    const run = await migrated.data<Session>("POST", `/automations/${automation.id}/runs`, {});
    const shown = await migrated.data<{ session: Session; task: Task | null; automation: Automation | null }>("GET", `/sessions/${run.id}`);
    assert.deepEqual([shown.session.taskId, shown.task, shown.automation?.id], [null, null, automation.id]);
    assert.equal((await migrated.data<TaskDetail>("GET", "/tasks/00000000-0000-4000-8000-000000000021")).sessions.length, 2);
    assert.deepEqual(
      (await migrated.data<Session[]>("GET", "/projects/00000000-0000-4000-8000-000000000001/sessions")).map((found) => [found.id, found.taskId, found.automationId]),
      [["00000000-0000-4000-8000-000000000032", "00000000-0000-4000-8000-000000000021", null], [run.id, null, automation.id]],
    );
  } finally {
    await migrated.stop();
  }
});
