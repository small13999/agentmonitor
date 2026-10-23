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
import { AUDIENCE, FakeAccess } from "./fake-access.ts";
import { buildApp, Gateway, type AmResult } from "./harness.ts";
import { spec } from "./spec.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** The hub's owner, as Cloudflare Access names them. */
const OWNER = "armin@example.com";

let source: Gateway;
let target: Gateway;
let access: FakeAccess;
let edge: { url: string; hub: string | null; server: Server };
let chrome: Browser;
let scratch: string;
/** Cloudflare's API as the target's broker reaches it: each request's method, path and token. */
let cloudflareApi: Server;
const cloudflareSeen: Array<{ method: string; path: string; authorization: string }> = [];

/** A store as the test reaches it: the source directly, the hub through its edge with an Access token. */
interface Reach {
  url: string;
  headers: Record<string, string>;
}
let onSource: Reach;
let onHub: Reach;

/**
 * Cloudflare's edge in front of the hub, at the hub's public origin (`am.localhost:<port>`): it
 * turns `cf-access-token` into the `Cf-Access-Jwt-Assertion` the hub checks and passes the public
 * Host on. The hub starts after it, knowing its origin, and is set as `hub`.
 */
async function startEdge(): Promise<{ url: string; hub: string | null; server: Server }> {
  const server = createServer((request, response) => {
    const headers: IncomingHttpHeaders = Object.fromEntries(Object.entries(request.headers).filter(([name]) => name !== "cf-access-token"));
    headers["cf-access-jwt-assertion"] = request.headers["cf-access-token"];
    assert.ok(started.hub !== null);
    request.pipe(forward(new URL(request.url ?? "/", started.hub), { method: request.method, headers }, (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    }));
  });
  const { promise, resolve } = Promise.withResolvers<void>();
  // am.localhost resolves to ::1 or 127.0.0.1; both reach a dual-stack socket.
  server.listen(0, "::", () => resolve());
  await promise;
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the edge has no port");
  const started: { url: string; hub: string | null; server: Server } = { url: `http://am.localhost:${address.port}`, hub: null, server };
  return started;
}

before(async () => {
  await buildApp();
  cloudflareApi = createServer((request, response) => {
    cloudflareSeen.push({ method: request.method ?? "", path: request.url ?? "", authorization: request.headers.authorization ?? "" });
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ success: true, errors: [], messages: [], result: [] }));
  });
  const listening = Promise.withResolvers<void>();
  cloudflareApi.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const address = cloudflareApi.address();
  assert.ok(address !== null && typeof address === "object");
  [source, access, chrome, edge] = await Promise.all([Gateway.start(), FakeAccess.start(), chromium.launch(), startEdge()]);
  target = await Gateway.start({
    runtime: "none",
    env: {
      AGENTMONITOR_AUTH_MODE: "access",
      AGENTMONITOR_ACCESS_TEAM_DOMAIN: access.url,
      AGENTMONITOR_ACCESS_AUD: AUDIENCE,
      AGENTMONITOR_OWNER_EMAIL: OWNER,
      AGENTMONITOR_PUBLIC_ORIGIN: edge.url,
      AGENTMONITOR_CLOUDFLARE_API: `http://127.0.0.1:${address.port}`,
    },
  });
  edge.hub = target.url;
  onSource = { url: source.url, headers: {} };
  onHub = { url: edge.url, headers: { "cf-access-token": access.token(OWNER) } };
  scratch = mkdtempSync(join(tmpdir(), "am-move-test-"));
});
after(async () => {
  edge?.server.close();
  cloudflareApi?.close();
  edge?.server.closeAllConnections();
  await chrome?.close();
  await Promise.all([source?.stop(), target?.stop(), access?.stop()]);
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

/** A store API request that must succeed; its data. */
async function call<T>(store: Reach, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${store.url}/api/store${path}`, {
    method,
    headers: body === undefined ? store.headers : { ...store.headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const answer: { ok: boolean; data: T; error?: string } = await response.json();
  if (!answer.ok) throw new Error(`${method} ${path} -> ${response.status} ${answer.error}`);
  return answer.data;
}

/** Everything a store shows of the project: its records, its people's ids where the records name them, and its files' bytes. */
async function everything(store: Reach, project: Project): Promise<unknown> {
  const tasks = await call<TaskSummary[]>(store, "GET", `/projects/${project.id}/tasks`);
  const topics = await call<Topic[]>(store, "GET", `/projects/${project.id}/topics`);
  return {
    project: (await call<Project[]>(store, "GET", "/projects")).find((found) => found.id === project.id),
    topics: await Promise.all(topics.map((topic) => call<{ topic: Topic; tasks: TopicLink[] }>(store, "GET", `/topics/${topic.id}`))),
    tasks: await Promise.all(tasks.map(async ({ task }) => {
      const folder = await call<FolderFile[]>(store, "GET", `/tasks/${task.id}/folder`);
      return {
        detail: await call<TaskDetail>(store, "GET", `/tasks/${task.id}`),
        comments: await call<Comment[]>(store, "GET", `/tasks/${task.id}/comments`),
        history: await call<HistoryEntry[]>(store, "GET", `/tasks/${task.id}/history`),
        folder,
        bytes: await Promise.all(folder.map(async (file) => (await fetch(`${store.url}/api/store/tasks/${task.id}/folder/${file.path}`, { headers: store.headers })).text())),
      };
    })),
  };
}

spec("STORE-6", "a project moves to another store with its topics, tasks, comments, folders, chats, and who did what, and then lives only there", async () => {
  // The source store: people, topics, tasks in several states, comments and files by the owner and an agent.
  const project = await source.data<Project>("POST", "/projects", { name: "draftcoach" });
  const sourceOwner = (await source.data<{ person: Person }>("GET", "/me")).person;
  const sam = await source.data<Person>("POST", "/people", { name: "Sam Lee", email: "sam@example.com" });
  const kim = await source.data<Person>("POST", "/people", { name: "Kim Park", email: "kim@example.com" });
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
  await call(onHub, "PATCH", `/people/${(await call<{ person: Person }>(onHub, "GET", "/me")).person.id}`, { name: "Hub owner" });
  // The hub knows Sam by his email under another name, and another Kim Park by hers.
  const targetSam = await call<Person>(onHub, "POST", "/people", { name: "Samuel Lee", email: "sam@example.com" });
  const otherKim = await call<Person>(onHub, "POST", "/people", { name: "Kim Park", email: "kim.park@example.org" });
  const targetMove = ["--target-token-command", `echo ${access.token(OWNER)}`];

  // A running session does not move, and nothing else does then.
  const running = await moveProject(source.url, "draftcoach", edge.url, ...targetMove);
  assert.notEqual(running.code, 0);
  assert.match(running.stderr, new RegExp(`Patch notes 26\\.21 \\(${session.id}\\)`));
  assert.deepEqual(await call<Project[]>(onHub, "GET", "/projects"), []);

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

  // Only the hub's owner moves a project there; Sam's token reaches the hub, and the project stays where it is.
  const denied = await moveProject(source.url, "draftcoach", edge.url, "--target-token-command", `echo ${access.token("sam@example.com")}`);
  assert.notEqual(denied.code, 0);
  assert.match(denied.stderr, /only the store's owner moves projects/);
  const before = await everything(onSource, project);

  const moved = await moveProject(source.url, "draftcoach", edge.url, ...targetMove);
  assert.equal(moved.code, 0, moved.stderr);

  // On the target: every record and file, with the same ids and history, and the same people:
  // the source's owner is the hub's, Sam the hub's person with his email, and Kim, whose email
  // it lacked, added with it beside the other Kim Park.
  const people = await call<Person[]>(onHub, "GET", "/people");
  const targetOwner = people.find((person) => person.owner);
  const targetKim = people.find((person) => person.email === "kim@example.com");
  assert.ok(targetOwner !== undefined && targetKim !== undefined, JSON.stringify(people));
  assert.deepEqual(
    people.map((person) => `${person.name} <${person.email}>`).sort(),
    ["Hub owner <armin@example.com>", "Kim Park <kim.park@example.org>", "Kim Park <kim@example.com>", "Samuel Lee <sam@example.com>"].sort(),
  );
  assert.notEqual(targetKim.id, otherKim.id);
  const here = new Map([[sourceOwner.id, targetOwner.id], [sam.id, targetSam.id], [kim.id, targetKim.id]]);
  const expected: unknown = JSON.parse([...here].reduce((text, [from, to]) => text.replaceAll(from, to), JSON.stringify(before)));
  assert.deepEqual(await everything(onHub, project), expected);
  const comments = await call<Comment[]>(onHub, "GET", `/tasks/${notes.id}/comments`);
  assert.deepEqual(comments.map((comment) => comment.author), [{ kind: "person", personId: targetOwner.id }, { kind: "agent", sessionId: session.id }]);
  for (const [path, content] of Object.entries(chats)) assert.equal(readFileSync(join(agentDir(target), path), "utf8"), content, path);

  // The target's board shows it.
  const page = await chrome.newPage({ extraHTTPHeaders: onHub.headers });
  page.setDefaultTimeout(10_000);
  await page.goto(`${edge.url}/#/`);
  await page.getByRole("region", { name: "In review" }).getByRole("article", { name: "Patch notes 26.21" }).waitFor();
  await page.getByRole("region", { name: "Open" }).getByRole("article", { name: "Worlds bracket" }).waitFor();
  await page.close();

  // On the source it is gone, with its folders and chats.
  assert.deepEqual(await source.data<Project[]>("GET", "/projects"), []);
  assert.equal((await source.api("GET", `/tasks/${notes.id}`)).status, 404);
  assert.ok(!existsSync(join(source.stateDir, "folders", notes.id)), "the task's folder is gone");
  assert.ok(!existsSync(join(source.stateDir, "sessions", session.id)), "the session's chats are gone");
});

/** A Cloudflare API request of a session's agent on the hub, as Wrangler sends it to the session's socket; its status. */
function agentCloudflare(session: Session, method: string, path: string): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const sent = forward({ socketPath: join(target.stateDir, "sessions", session.id, "run", "am.sock"), method, path, headers: { authorization: "Bearer agent-monitor" } }, (response) => {
    response.resume();
    resolve(response.statusCode ?? 0);
  });
  sent.on("error", reject);
  sent.end(method === "GET" ? undefined : "{}");
  return promise;
}

spec("CLOUDFLARE-3", "a project's Cloudflare tokens move with it: its sessions on the other store reach Cloudflare with them", async () => {
  const project = await source.data<Project>("POST", "/projects", { name: "bracket-site" });
  await source.data("PUT", `/projects/${project.id}/cloudflare`, { read: "cf-read-bracket", write: "cf-write-bracket" });
  const task = await source.data<Task>("POST", `/projects/${project.id}/tasks`, { title: "Worlds bracket page" });

  const moved = await moveProject(source.url, "bracket-site", edge.url, "--target-token-command", `echo ${access.token(OWNER)}`);
  assert.equal(moved.code, 0, moved.stderr);
  assert.equal((await source.api("GET", `/tasks/${task.id}`)).status, 404);
  const onTarget = (await call<Project[]>(onHub, "GET", "/projects")).find((found) => found.id === project.id);
  assert.deepEqual(onTarget?.cloudflare, { read: true, write: true });

  // A session of the moved project reads with the moved read token, and writes, once the hub's owner allows it, with the write token.
  const session = await call<Session>(onHub, "POST", `/tasks/${task.id}/sessions`, {});
  assert.equal(await agentCloudflare(session, "GET", "/client/v4/accounts"), 200);
  assert.deepEqual(cloudflareSeen.at(-1), { method: "GET", path: "/client/v4/accounts", authorization: "Bearer cf-read-bracket" });
  await call(onHub, "POST", `/sessions/${session.id}/cloudflare-writes`);
  assert.equal(await agentCloudflare(session, "POST", "/client/v4/accounts/bracket/workers/scripts"), 200);
  assert.deepEqual(cloudflareSeen.at(-1), { method: "POST", path: "/client/v4/accounts/bracket/workers/scripts", authorization: "Bearer cf-write-bracket" });
  await call(onHub, "POST", `/sessions/${session.id}/end`, {});
});
