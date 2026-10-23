import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as forward, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import type { Comment, FolderFile, HistoryEntry, Person, Project, Session, Task, TaskDetail, TaskSummary, Topic, TopicLink } from "../shared/api.ts";
import { buildApp, Gateway, type AmResult } from "./harness.ts";
import { spec } from "./spec.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "access-token-for-the-hub";

let source: Gateway;
let target: Gateway;
let edge: { url: string; server: Server };
let chrome: Browser;
let scratch: string;

/**
 * Cloudflare's edge in front of the target: it lets a request through only with the hub's
 * Access token in `cf-access-token`, and sends anyone else to Access's login.
 */
async function edgeOf(upstream: string): Promise<{ url: string; server: Server }> {
  const server = createServer((request, response) => {
    if (request.headers["cf-access-token"] !== TOKEN) {
      response.writeHead(302, { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" }).end();
      return;
    }
    const headers: IncomingHttpHeaders = Object.fromEntries(Object.entries(request.headers).filter(([name]) => name !== "cf-access-token"));
    request.pipe(forward(`${upstream}${request.url}`, { method: request.method, headers }, (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    }));
  });
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => resolve());
  await promise;
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the edge has no port");
  return { url: `http://127.0.0.1:${address.port}`, server };
}

before(async () => {
  buildApp();
  [source, target, chrome] = await Promise.all([Gateway.start(), Gateway.start(), chromium.launch()]);
  edge = await edgeOf(target.url);
  scratch = mkdtempSync(join(tmpdir(), "am-move-test-"));
});
after(async () => {
  edge?.server.close();
  await chrome?.close();
  await Promise.all([source?.stop(), target?.stop()]);
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

/** The move script, as the user runs it; asynchronous, since the edge answers from this process. */
async function moveProject(...args: string[]): Promise<AmResult> {
  const child = spawn(process.execPath, [join(root, "scripts", "move-project.ts"), ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const { promise, resolve } = Promise.withResolvers<number>();
  child.once("close", (code) => resolve(code ?? -1));
  return { code: await promise, stdout, stderr };
}

/** Everything a store shows of the project: its records, its people's ids where the records name them, and its files' bytes. */
async function everything(store: Gateway, project: Project): Promise<unknown> {
  const tasks = await store.data<TaskSummary[]>("GET", `/projects/${project.id}/tasks`);
  const topics = await store.data<Topic[]>("GET", `/projects/${project.id}/topics`);
  return {
    project: (await store.data<Project[]>("GET", "/projects")).find((found) => found.id === project.id),
    topics: await Promise.all(topics.map((topic) => store.data<{ topic: Topic; tasks: TopicLink[] }>("GET", `/topics/${topic.id}`))),
    tasks: await Promise.all(tasks.map(async ({ task }) => {
      const folder = await store.data<FolderFile[]>("GET", `/tasks/${task.id}/folder`);
      return {
        detail: await store.data<TaskDetail>("GET", `/tasks/${task.id}`),
        comments: await store.data<Comment[]>("GET", `/tasks/${task.id}/comments`),
        history: await store.data<HistoryEntry[]>("GET", `/tasks/${task.id}/history`),
        folder,
        bytes: await Promise.all(folder.map(async (file) => (await fetch(`${store.url}/api/store/tasks/${task.id}/folder/${file.path}`)).text())),
      };
    })),
  };
}

spec("STORE-6", "a project moves to another store with its topics, tasks, comments, folders, chats, and who did what, and then lives only there", async () => {
  // The source store: people, topics, tasks in several states, comments and files by the owner and an agent.
  const project = await source.data<Project>("POST", "/projects", { name: "draftcoach" });
  const sourceOwner = (await source.data<{ person: Person }>("GET", "/me")).person;
  const sam = await source.data<Person>("POST", "/people", { name: "Sam Lee" });
  const kim = await source.data<Person>("POST", "/people", { name: "Kim Park" });
  const patchNotes = await source.data<Topic>("POST", `/projects/${project.id}/topics`, { name: "Patch notes" });
  const worlds = await source.data<Topic>("POST", `/projects/${project.id}/topics`, { name: "Worlds" });
  await source.data("PUT", `/topics/${patchNotes.id}/status`, { status: "26.21 drafted in JP and EN\n", baseRevision: 0 });
  const task = (title: string) => source.data<Task>("POST", `/projects/${project.id}/tasks`, { title, description: `${title}, described` });
  const notes = await task("Patch notes 26.21");
  const bracket = await task("Worlds bracket");
  const recap = await task("Season recap");
  const idea = await task("Old idea");
  await source.data("PUT", `/tasks/${notes.id}/topics/${patchNotes.id}`);
  await source.data("PUT", `/tasks/${bracket.id}/topics/${worlds.id}`);
  await source.data("PUT", `/tasks/${recap.id}/topics/${patchNotes.id}`);
  await source.data("PATCH", `/tasks/${notes.id}`, { assigneeId: sam.id });
  await source.data("PATCH", `/tasks/${bracket.id}`, { assigneeId: kim.id });
  await source.data("POST", `/tasks/${notes.id}/comments`, { body: "Ship **after** QA" });
  const brief = await fetch(`${source.url}/api/store/tasks/${notes.id}/folder/brief.md`, { method: "PUT", body: "# Brief\n\nJP first.\n" });
  assert.equal(brief.status, 200);
  const session = await source.data<Session>("POST", `/tasks/${notes.id}/sessions`, {});
  assert.equal(source.am(session.id, ["comment"], "Drafted JP and EN").code, 0);
  writeFileSync(join(scratch, "jp.md"), "# JP\n\nドラフト\n");
  assert.equal(source.am(session.id, ["folder", "add", join(scratch, "jp.md"), "drafts/jp.md"]).code, 0);
  await source.data("PATCH", `/tasks/${notes.id}`, { state: "in_review" });
  await source.data("POST", `/tasks/${recap.id}/finish`, { state: "done" });
  await source.data("POST", `/tasks/${idea.id}/finish`, { state: "cancelled" });
  await target.data("PATCH", `/people/${(await target.data<{ person: Person }>("GET", "/me")).person.id}`, { name: "Hub owner" });
  const targetSam = await target.data<Person>("POST", "/people", { name: "Sam Lee" });
  const targetMove = ["--target-token-command", `echo ${TOKEN}`];

  // A running session does not move, and nothing else does then.
  const running = await moveProject(source.url, "draftcoach", edge.url, ...targetMove);
  assert.notEqual(running.code, 0);
  assert.match(running.stderr, new RegExp(`Patch notes 26\\.21 \\(${session.id}\\)`));
  assert.deepEqual(await target.data<Project[]>("GET", "/projects"), []);

  // The session ends; omp left a chat with a subagent's and an image blob in its home.
  await source.data("POST", `/sessions/${session.id}/end`);
  const agentDir = (store: Gateway) => join(store.stateDir, "sessions", session.id, "omp-home", "agent");
  const chats = {
    "sessions/--workspace-draftcoach--/2026-10-23T08-00-00-000Z_01a07095-08ce-7288-ba4d-a7d50d51ce2e.jsonl": `{"type":"session","cwd":"/workspace/draftcoach"}\n{"type":"message","message":{"role":"user","content":"Draft 26.21"}}\n`,
    "sessions/--workspace-draftcoach--/2026-10-23T08-00-00-000Z_01a07095-08ce-7288-ba4d-a7d50d51ce2e/0-Explore.jsonl": `{"type":"session","cwd":"/workspace/draftcoach"}\n`,
    "blobs/777f7df5f82557123cf68dad25a6ab1b1e66d31f6750b63a7e877c7e7a82b642.png": "not really a png",
  };
  for (const [path, content] of Object.entries(chats)) {
    mkdirSync(dirname(join(agentDir(source), path)), { recursive: true });
    writeFileSync(join(agentDir(source), path), content);
  }

  // Without the hub's Access token the target is out of reach, and the project stays where it is.
  const denied = await moveProject(source.url, "draftcoach", edge.url, "--target-token-command", "echo expired");
  assert.notEqual(denied.code, 0);
  assert.match(denied.stderr, /not the store API/);
  const before = await everything(source, project);

  const moved = await moveProject(source.url, "draftcoach", edge.url, ...targetMove);
  assert.equal(moved.code, 0, moved.stderr);

  // On the target: every record and file, with the same ids and history, and the same people:
  // the source's owner is the target's, Sam the target's Sam, and Kim, whom it lacked, added.
  const people = await target.data<Person[]>("GET", "/people");
  const targetOwner = people.find((person) => person.owner);
  const targetKim = people.find((person) => person.name === "Kim Park");
  assert.ok(targetOwner !== undefined && targetKim !== undefined, JSON.stringify(people));
  assert.deepEqual(people.map((person) => person.name).sort(), ["Hub owner", "Kim Park", "Sam Lee"]);
  const here = new Map([[sourceOwner.id, targetOwner.id], [sam.id, targetSam.id], [kim.id, targetKim.id]]);
  const expected: unknown = JSON.parse([...here].reduce((text, [from, to]) => text.replaceAll(from, to), JSON.stringify(before)));
  assert.deepEqual(await everything(target, project), expected);
  const comments = await target.data<Comment[]>("GET", `/tasks/${notes.id}/comments`);
  assert.deepEqual(comments.map((comment) => comment.author), [{ kind: "person", personId: targetOwner.id }, { kind: "agent", sessionId: session.id }]);
  for (const [path, content] of Object.entries(chats)) assert.equal(readFileSync(join(agentDir(target), path), "utf8"), content, path);

  // The target's board shows it.
  const page = await chrome.newPage();
  page.setDefaultTimeout(10_000);
  await page.goto(`${target.url}/#/`);
  await page.getByRole("region", { name: "In review" }).getByRole("article", { name: "Patch notes 26.21" }).waitFor();
  await page.getByRole("region", { name: "Open" }).getByRole("article", { name: "Worlds bracket" }).waitFor();
  await page.close();

  // On the source it is gone, with its folders and chats.
  assert.deepEqual(await source.data<Project[]>("GET", "/projects"), []);
  assert.equal((await source.api("GET", `/tasks/${notes.id}`)).status, 404);
  assert.ok(!existsSync(join(source.stateDir, "folders", notes.id)), "the task's folder is gone");
  assert.ok(!existsSync(join(source.stateDir, "sessions", session.id)), "the session's chats are gone");
});
