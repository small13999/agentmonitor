import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { get, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { after, afterEach, before } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { z } from "zod";
import { FakeModel } from "./fake-model.ts";
import { buildApp, Gateway, type OmpChannel } from "./harness.ts";
import { spec } from "./spec.ts";

// Every claim in this file runs against one gateway and one host session, in order. The
// gateway runs with a fixture home: the session's agent gets the user's credentials from it,
// and HOST-5 checks nothing in it changed.
interface Session { id: string; taskId: string; name: string; branch: string; runtime: string }
interface Task { id: string; title: string }
interface Project { id: string; hostSessions: boolean }
interface Card { session: Session; turn: string; lastUserMessage: string | null; lastReply: string | null }

const REPO_RULE = "Fixture rule 5d21: host sessions run the fixture linter too.";
const TASK = { title: "Host fixes", description: "Fix the host fixture 8b3e." };
/** The user's configuration a host session must leave alone (HOST-5), relative to the home. */
const USER_CONFIG = [".ssh", ".gitconfig", ".config/gh", ".config/tern", ".omp/agent"];

let scratch: string;
let repo: string;
let home: string;
/** The user's omp agent directory, AGENTMONITOR_OMP_AGENT_DIR: credentials, providers, and chats. */
let agentDir: string;
let fake: FakeModel;
let gateway: Gateway;
let project: Project;
let task: Task;
let host: Session;
let channel: OmpChannel;
let configBefore: Map<string, string>;

/** Every file under the user's configuration with its content hash. */
function userConfig(): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of USER_CONFIG) {
    const path = join(home, entry);
    const paths = statSync(path).isDirectory()
      ? readdirSync(path, { recursive: true, withFileTypes: true }).filter((found) => found.isFile()).map((found) => join(found.parentPath, found.name))
      : [path];
    for (const file of paths) files.set(file, createHash("sha256").update(readFileSync(file)).digest("hex"));
  }
  return files;
}

before(async () => {
  buildApp();
  scratch = mkdtempSync(join(tmpdir(), "am-host-"));
  repo = join(scratch, "fixture");
  mkdirSync(repo);
  writeFileSync(join(repo, "AGENTS.md"), `# Fixture\n\n${REPO_RULE}\n`);
  for (const args of [["init", "-q", "-b", "main"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]]) {
    execFileSync("git", args, { cwd: repo });
  }
  fake = await FakeModel.start();
  agentDir = join(scratch, "omp-agent");
  mkdirSync(agentDir);
  // A host session reaches the model the way the gateway does.
  fake.writeAgentDir(agentDir, "127.0.0.1");

  // The user's home: credentials, and omp and Tern settings of their own.
  home = join(scratch, "home");
  mkdirSync(join(home, ".ssh"), { recursive: true, mode: 0o700 });
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "fixture", "-f", join(home, ".ssh", "id_ed25519")]);
  writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Fixture User\n\temail = fixture@example.com\n");
  mkdirSync(join(home, ".config", "gh"), { recursive: true });
  writeFileSync(join(home, ".config", "gh", "hosts.yml"), "github.com:\n    user: fixture-user\n    oauth_token: gho_fixture\n    git_protocol: ssh\n");
  mkdirSync(join(home, ".config", "tern"), { recursive: true });
  writeFileSync(join(home, ".config", "tern", "settings.json"), JSON.stringify({ theme: "Light" }));
  mkdirSync(join(home, ".omp", "agent"), { recursive: true });
  writeFileSync(join(home, ".omp", "agent", "config.yml"), "setupVersion: 2\n");
  writeFileSync(join(home, ".omp", "agent", "AGENTS.md"), "# The user's own omp context\n");
  // gh rewrites a login of an older format on first use; that is gh's doing, not the session's.
  execFileSync("gh", ["auth", "token"], { env: { ...process.env, HOME: home }, stdio: "ignore" });
  configBefore = userConfig();

  gateway = await Gateway.start({ runtime: "podman", env: { HOME: home, AGENTMONITOR_OMP_AGENT_DIR: agentDir } });
  project = await gateway.data<Project>("POST", "/projects", { name: "fixture", repoPath: repo });
  task = await gateway.data<Task>("POST", `/projects/${project.id}/tasks`, TASK);
}, { timeout: 60_000 });

after(async () => {
  await chrome?.close();
  channel?.close();
  await gateway?.stop();
  await fake?.stop();
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

function dirs(target: Session): { run: string; worktree: string; ompHome: string } {
  const root = join(gateway.stateDir, "sessions", target.id);
  return { run: join(root, "run"), worktree: join(root, "worktree"), ompHome: join(root, "omp-home") };
}

/** Processes started for the session, by the marker every one of them carries. */
function sessionProcesses(target: Session): Array<{ pid: number; cmdline: string }> {
  const found: Array<{ pid: number; cmdline: string }> = [];
  for (const entry of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    try {
      if (!readFileSync(`/proc/${entry}/environ`, "latin1").split("\0").includes(`AGENTMONITOR_SESSION=${target.id}`)) continue;
      found.push({ pid: Number(entry), cmdline: readFileSync(`/proc/${entry}/cmdline`, "latin1").split("\0").join(" ").trim() });
    } catch {
      // Exited while listed.
    }
  }
  return found;
}

async function card(target: Session): Promise<Card> {
  const found = (await gateway.data<Card[]>("GET", `/projects/${project.id}/cards`)).find((candidate) => candidate.session.id === target.id);
  assert.ok(found, `no card for ${target.name}`);
  return found;
}

/** Types a prompt into the session's chat in Tern, as the user would, and waits for its turn to finish. */
async function prompt(target: Session, text: string): Promise<Card> {
  const done = channel.event((event) => event.type === "turn" && event.turn === "done");
  const env = { ...process.env, TERN_DAEMON_SOCKET: join(dirs(target).run, "tern-daemon.sock"), TERN_CONFIG_DIR: join(dirs(target).run, "tern-config") };
  execFileSync("tern", ["send", "workspace/@focused", "text", text], { env });
  execFileSync("tern", ["send", "workspace/@focused", "keys", "Enter"], { env });
  await done;
  return card(target);
}

let chrome: Browser | undefined;
let page: Page | undefined;
afterEach(async () => {
  await page?.close();
  page = undefined;
});

async function openPage(hash: string): Promise<Page> {
  chrome ??= await chromium.launch({
    args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--enable-features=Vulkan,VulkanFromANGLE", "--use-vulkan=native", "--use-angle=vulkan"],
  });
  page = await chrome.newPage();
  page.setDefaultTimeout(15_000);
  await page.goto(`${gateway.url}/${hash}`);
  return page;
}

/** Sends a request on the session's own store socket, as its agent would. */
async function asAgent(target: Session, method: string, path: string, body: unknown): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const sent = request({ socketPath: join(dirs(target).run, "am.sock"), method, path: `/api/store${path}`, headers: { "content-type": "application/json" } }, (response) => {
    response.resume();
    resolve(response.statusCode ?? 0);
  });
  sent.on("error", reject);
  sent.end(JSON.stringify(body));
  return promise;
}

/** Asks the gateway for the session's Tern page, as the session's frame does: the response's status. */
async function ternPage(sessionId: string): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  get({ host: "127.0.0.1", port: new URL(gateway.url).port, path: "/", headers: { host: `tern-${sessionId}.localhost` } }, (response) => {
    response.resume();
    resolve(response.statusCode ?? 0);
  }).on("error", reject);
  return promise;
}

spec("HOST-1", "a session runs on the host only where a human allowed host sessions for its project", async () => {
  const refused = await gateway.api("POST", `/tasks/${task.id}/sessions`, { runtime: "host", model: "fake/scripted" });
  assert.equal(refused.status, 403);
  assert.deepEqual((await gateway.data<{ sessions: Session[] }>("GET", `/tasks/${task.id}`)).sessions, []);

  assert.equal((await gateway.data<Project>("PATCH", `/projects/${project.id}`, { hostSessions: true })).hostSessions, true);
  const starting = gateway.data<Session>("POST", `/tasks/${task.id}/sessions`, { runtime: "host", model: "fake/scripted" });
  // The task list shows the session while it starts, and its page asks for Tern again until it
  // answers: asked once the worktree exists, that waits for the start, which ends once Tern
  // answers, instead of starting the session a second time.
  let listed: Session[] = [];
  while (listed.length === 0 || !existsSync(dirs(listed[0]).worktree)) {
    listed = (await gateway.data<{ sessions: Session[] }>("GET", `/tasks/${task.id}`)).sessions;
  }
  const opened = ternPage(listed[0].id);
  host = await starting;
  assert.equal(await opened, 200);
  assert.equal(host.runtime, "host");
  channel = await gateway.omp(host.id);
  assert.equal(readFileSync(join(dirs(host).run, "host.log"), "utf8").match(/starting host session/g)?.length, 1, "one start");
  const entry: unknown = JSON.parse(readFileSync(join(dirs(host).run, "host.json"), "utf8")).pid;
  assert.ok(sessionProcesses(host).some((found) => found.pid === entry && found.cmdline.includes("host-entry.ts")), "the recorded entry runs");
  assert.equal(spawnSync("podman", ["container", "exists", `am-${host.id}`]).status, 1, "a host session has no container");

  // Its agent cannot allow or forbid host sessions.
  assert.equal(await asAgent(host, "PATCH", `/projects/${project.id}`, { hostSessions: false }), 403);
  assert.equal((await gateway.data<Project[]>("GET", "/projects"))[0].hostSessions, true);
});

spec("HOST-4", "a host session's chat, task context, am, and card work as a container session's do", async () => {
  const { systemPrompt } = await channel.request("system_prompt");
  for (const part of [REPO_RULE, "# Agent Monitor session", `"${TASK.title}"`, TASK.description]) {
    assert.ok(String(systemPrompt).includes(part), `the context holds ${part}`);
  }
  const shown = await prompt(host, "bash:am whoami");
  assert.equal(shown.lastUserMessage, "bash:am whoami");
  assert.equal(shown.lastReply, `answered: ${gateway.am(host.id, ["whoami"]).stdout.split("\n")[0]}`);
  assert.equal(shown.turn, "done");

  // The session page opens its chat in Tern.
  const opened = await openPage(`#/t/${task.id}/chat`);
  await opened.frameLocator("iframe.session-frame.current").getByRole("group", { name: /^Model: Scripted/ }).waitFor();
});

spec("HOST-4", "a stopped host session starts again on its last chat when its page opens", async () => {
  for (const { pid } of sessionProcesses(host)) process.kill(pid, "SIGKILL");
  assert.equal((await card(host)).turn, "stopped");
  channel.close();

  const opened = await openPage(`#/t/${task.id}/chat`);
  const frame = opened.frameLocator("iframe.session-frame.current");
  await frame.getByRole("group", { name: /^Model: Scripted/ }).waitFor({ timeout: 60_000 });
  await frame.getByText("bash:am whoami", { exact: true }).waitFor({ state: "attached" });
  channel = await gateway.omp(host.id);
  const shown = await card(host);
  assert.deepEqual([shown.turn, shown.lastUserMessage], ["done", "bash:am whoami"]);
});

spec("HOST-3", "a host session is marked red on its board card, task list row, and settings", async () => {
  const other = await gateway.data<Task>("POST", `/projects/${project.id}/tasks`, { title: "No session" });
  const opened = await openPage("#/");
  const board = opened.getByRole("region", { name: "Board" });
  const hostCard = board.locator(`[data-task="${TASK.title}"]`);
  await hostCard.locator(".host-mark", { hasText: "Host" }).waitFor();
  assert.equal(await hostCard.locator(".host-mark").evaluate((mark) => getComputedStyle(mark).backgroundColor), "rgb(247, 118, 142)");
  assert.equal(await board.locator(`[data-task="${other.title}"] .host-mark`).count(), 0);

  await opened.getByRole("navigation", { name: "Menus" }).getByRole("link", { name: "Tasks" }).click();
  const list = opened.getByRole("navigation", { name: "Tasks" });
  await list.getByRole("link", { name: new RegExp(TASK.title) }).locator(".host-mark").waitFor();
  assert.equal(await list.getByRole("link", { name: /No session/ }).locator(".host-mark").count(), 0);

  await list.getByRole("link", { name: new RegExp(TASK.title) }).click();
  await opened.getByRole("tab", { name: "Settings" }).click();
  await opened.getByRole("region", { name: "Settings" }).locator(".host-mark", { hasText: "Host" }).waitFor();
});

spec("HOST-2", "a host session's agent works as the user in its own worktree, and ending it stops every process it started", async () => {
  const uid = String(process.getuid?.());
  const shown = await prompt(host, 'bash:echo "$(id -u) $(pwd) $(git config user.email) $(gh auth token) $(ssh-keygen -y -f ~/.ssh/id_ed25519 | cut -d" " -f2)"');
  const key = readFileSync(join(home, ".ssh", "id_ed25519.pub"), "utf8").split(" ")[1];
  assert.equal(shown.lastReply, `answered: ${uid} ${dirs(host).worktree} fixture@example.com gho_fixture ${key}`);
  await prompt(host, "bash:git commit --allow-empty -qm by-host-agent");
  assert.equal(execFileSync("git", ["-C", repo, "log", "-1", "--format=%an <%ae> %s", host.branch], { encoding: "utf8" }).trim(), "Fixture User <fixture@example.com> by-host-agent");

  // A server of its own, detached from the chat.
  await prompt(host, "bash:setsid sleep 4242 </dev/null >/dev/null 2>&1 &");
  assert.ok(sessionProcesses(host).some((found) => found.cmdline === "sleep 4242"), "the agent's server runs");

  channel.close();
  await gateway.data("POST", `/sessions/${host.id}/end`, {});
  assert.deepEqual(sessionProcesses(host), []);
  assert.equal(existsSync(dirs(host).worktree), false);
});

let main: Session;
let mainTask: Task;

/** The chats of the checkout that Tern's /sessions lists, as omp with `agent` as its agent directory answers it. */
async function chatsOfCheckout(agent: string): Promise<string[]> {
  const omp = spawn("omp", ["acp"], { cwd: repo, env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent }, stdio: ["pipe", "pipe", "ignore"] });
  const send = (id: number, method: string, params: unknown) => omp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  send(1, "initialize", { protocolVersion: 1, clientCapabilities: {} });
  send(2, "session/list", { cwd: repo });
  try {
    for await (const line of createInterface({ input: omp.stdout })) {
      const reply = z.object({ id: z.number(), result: z.object({ sessions: z.array(z.object({ sessionId: z.string() })) }) }).safeParse(JSON.parse(line));
      if (reply.success && reply.data.id === 2) return reply.data.result.sessions.map((found) => found.sessionId);
    }
    throw new Error("omp acp ended without listing chats");
  } finally {
    omp.kill();
  }
}

spec("HOST-7", "a session in the main checkout has the user's omp chats there, as omp in a terminal does", async () => {
  // The user's chat, as omp in a terminal in the checkout leaves it; the fake model answers in this
  // process, and omp -p reads stdin until it closes.
  const userChat = promisify(execFile)("omp", ["-p", "--model", "fake/scripted", "say:origin-7c1"], { cwd: repo, env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir } });
  userChat.child.stdin?.end();
  await userChat;
  const [origin] = await chatsOfCheckout(agentDir);

  mainTask = await gateway.data<Task>("POST", `/projects/${project.id}/tasks`, { title: "Integration" });
  main = await gateway.data<Session>("POST", `/tasks/${mainTask.id}/sessions`, { runtime: "host", checkout: true });
  channel = await gateway.omp(main.id);
  assert.ok((await chatsOfCheckout(join(dirs(main).ompHome, "agent"))).includes(origin), "/sessions in the session lists the user's chat");

  const shown = await prompt(main, "say:joins-3f0");
  assert.deepEqual([shown.lastUserMessage, shown.lastReply], ["say:joins-3f0", "joins-3f0"]);
  const { sessionFile } = await channel.request("state");
  const own = /_([0-9a-f-]{36})\.jsonl$/.exec(String(sessionFile))?.[1];
  assert.deepEqual((await chatsOfCheckout(agentDir)).toSorted(), [origin, own].toSorted(), "omp in a terminal lists the session's chat");
});

spec("HOST-6", "a host session works in the main checkout, one per project, and ending it leaves the checkout as it is", async () => {
  const worktrees = execFileSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf8" });
  const shown = await prompt(main, "bash:pwd && echo live > live.txt");
  assert.equal(shown.lastReply, `answered: ${repo}`);
  assert.equal(readFileSync(join(repo, "live.txt"), "utf8"), "live\n");
  assert.equal(execFileSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf8" }), worktrees, "no worktree");
  const opened = await openPage("#/");
  await opened.getByRole("region", { name: "Board" }).locator(`[data-task="${mainTask.title}"] .host-mark`, { hasText: "Host · main" }).waitFor();

  const other = await gateway.data<Task>("POST", `/projects/${project.id}/tasks`, { title: "Second integrator" });
  assert.equal((await gateway.api("POST", `/tasks/${other.id}/sessions`, { runtime: "host", checkout: true })).status, 409);

  channel.close();
  const ended = await gateway.data<{ kept: string[] }>("POST", `/sessions/${main.id}/end`, {});
  assert.deepEqual(ended.kept, []);
  assert.deepEqual(sessionProcesses(main), []);
  assert.equal(readFileSync(join(repo, "live.txt"), "utf8"), "live\n");
  assert.equal(execFileSync("git", ["-C", repo, "branch", "--show-current"], { encoding: "utf8" }).trim(), "main");
  assert.equal(execFileSync("git", ["-C", repo, "for-each-ref", `refs/agentmonitor/snapshots/${mainTask.id}`], { encoding: "utf8" }), "");
  assert.equal((await gateway.data<{ task: { branch: string | null } }>("GET", `/tasks/${mainTask.id}`)).task.branch, null);
});

spec("HOST-5", "a host session never changes the user's omp, Tern, ssh, git, or gh configuration", () => {
  assert.deepEqual(userConfig(), configBefore);
});
