import assert from "node:assert/strict";
import { after, before } from "node:test";
import { Gateway } from "./harness.ts";
import { spec } from "./spec.ts";

interface Project { id: string; name: string }
interface Topic { id: string; name: string; status: string; statusRevision: number }
interface Task { id: string; title: string }
interface Session { id: string; taskId: string; endedAt: number | null }

let gateway: Gateway;
let project: Project;

before(async () => {
  gateway = await Gateway.start();
  project = await gateway.data<Project>("POST", "/projects", { name: "draftcoach" });
});
after(async () => {
  await gateway?.stop();
});

/** A task with a running session, whose agent socket `am` talks through. */
async function session(title: string, projectId = project.id): Promise<Session> {
  const task = await gateway.data<Task>("POST", `/projects/${projectId}/tasks`, { title });
  return gateway.data<Session>("POST", `/tasks/${task.id}/sessions`, {});
}

async function taskTopics(taskId: string): Promise<string[]> {
  const detail = await gateway.data<{ topics: Topic[] }>("GET", `/tasks/${taskId}`);
  return detail.topics.map((topic) => topic.name).sort();
}

spec("TOPIC-1", "topics are flat and belong to one project", async () => {
  const other = await gateway.data<Project>("POST", "/projects", { name: "personal" });
  const ws = await session("26.21");
  const otherWs = await session("dotfiles", other.id);

  assert.equal(gateway.am(ws.id, ["topic", "create", "Patch notes"]).code, 0);
  const parent = (await gateway.data<Topic[]>("GET", `/projects/${project.id}/topics`)).find((t) => t.name === "Patch notes");
  assert.ok(parent);

  const nested = await gateway.api("POST", `/projects/${project.id}/topics`, { name: "JP", parent: parent.id });
  assert.equal(nested.status, 400, "a topic cannot have a parent");

  assert.deepEqual(await gateway.data<Topic[]>("GET", `/projects/${other.id}/topics`), []);
  const elsewhere = gateway.am(otherWs.id, ["topic", "show", "Patch notes"]);
  assert.equal(elsewhere.code, 1);
  assert.match(elsewhere.stderr, /no topic "Patch notes" in personal/);
});

spec("TOPIC-2", "status is capped at 50 lines", async () => {
  const ws = await session("status-cap");
  assert.equal(gateway.am(ws.id, ["topic", "create", "Nightly pipeline"]).code, 0);

  const tooLong = Array.from({ length: 51 }, (_, i) => `line ${i + 1}`).join("\n");
  const refused = gateway.am(ws.id, ["topic", "set-status", "Nightly pipeline", "--base", "0"], tooLong);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /51 lines; the limit is 50/);

  const atLimit = `${Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
  assert.equal(gateway.am(ws.id, ["topic", "set-status", "Nightly pipeline", "--base", "0"], atLimit).code, 0);
  const read = gateway.am(ws.id, ["topic", "status", "Nightly pipeline"]);
  assert.equal(read.stdout, `# revision 1\n${atLimit}`);
});

spec("TOPIC-3", "a status write based on a stale revision is refused", async () => {
  const a = await session("writer-a");
  const b = await session("writer-b");
  assert.equal(gateway.am(a.id, ["topic", "create", "Client"]).code, 0);
  assert.match(gateway.am(b.id, ["topic", "status", "Client"]).stdout, /^# revision 0/);

  assert.equal(gateway.am(a.id, ["topic", "set-status", "Client", "--base", "0"], "Done: login fix\n").code, 0);
  const stale = gateway.am(b.id, ["topic", "set-status", "Client", "--base", "0"], "Now: settings page\n");
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /current revision 1/);
  assert.equal(gateway.am(b.id, ["topic", "status", "Client"]).stdout, "# revision 1\nDone: login fix\n");

  assert.equal(gateway.am(b.id, ["topic", "set-status", "Client", "--base", "1"], "Done: login fix\nNow: settings page\n").code, 0);
});

spec("TASK-2", "a task links to many topics, changed by the UI and by agents, and keeps them after its session ends", async () => {
  const ws = await session("multi-topic");
  for (const name of ["Alpha", "Beta", "Gamma"]) {
    await gateway.data("POST", `/projects/${project.id}/topics`, { name });
  }
  const topics = await gateway.data<Topic[]>("GET", `/projects/${project.id}/topics`);
  const gamma = topics.find((t) => t.name === "Gamma");
  const alpha = topics.find((t) => t.name === "Alpha");
  assert.ok(gamma && alpha);

  assert.equal(gateway.am(ws.id, ["topic", "link", "Alpha", "Beta"]).code, 0);
  await gateway.data("PUT", `/tasks/${ws.taskId}/topics/${gamma.id}`);
  assert.deepEqual(await taskTopics(ws.taskId), ["Alpha", "Beta", "Gamma"]);

  await gateway.data("DELETE", `/tasks/${ws.taskId}/topics/${alpha.id}`);
  assert.equal(gateway.am(ws.id, ["topic", "unlink", "Beta"]).code, 0);
  assert.deepEqual(await taskTopics(ws.taskId), ["Gamma"]);
  assert.match(gateway.am(ws.id, ["task", "show"]).stdout, /^topics Gamma$/m);

  await gateway.data("POST", `/sessions/${ws.id}/end`, {});
  assert.deepEqual(await taskTopics(ws.taskId), ["Gamma"]);
  const history = await gateway.data<{ tasks: Array<{ taskId: string }> }>("GET", `/topics/${gamma.id}`);
  assert.deepEqual(history.tasks.map((link) => link.taskId), [ws.taskId]);
  // The ended session's agent socket is gone with its workspace.
  assert.equal(gateway.am(ws.id, ["whoami"]).code, 1);
});

spec("STORE-2", "a task cannot link a topic from another store", async () => {
  const otherStore = await Gateway.start();
  try {
    const otherProject = await otherStore.data<Project>("POST", "/projects", { name: "draftcoach" });
    const foreign = await otherStore.data<Topic>("POST", `/projects/${otherProject.id}/topics`, { name: "Patch notes" });

    const ws = await session("cross-store");
    const linked = await gateway.api("PUT", `/tasks/${ws.taskId}/topics/${foreign.id}`);
    assert.equal(linked.status, 404);
    assert.deepEqual(await taskTopics(ws.taskId), []);
  } finally {
    await otherStore.stop();
  }
});
