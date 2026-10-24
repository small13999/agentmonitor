import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { after, afterEach, before } from "node:test";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { z } from "zod";
import { DEPLOY_INSTRUCTION } from "../server/deploy.ts";
import type { ChatDraft } from "../shared/chat.ts";
import { FakeModel } from "./fake-model.ts";
import { buildApp, Gateway, png, type OmpChannel } from "./harness.ts";
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
const USER_CONFIG = [".ssh", ".gitconfig", ".config/gh", ".omp/agent"];
/**
 * The configured omp agent directory's settings: no extension of the user's, a compaction
 * threshold, and the scripted model for subagents (AGENT-2), whose own default needs the network.
 */
const USER_OMP_SETTINGS = "compaction:\n  thresholdTokens: 271828\ntask:\n  agentModelOverrides:\n    task: fake/scripted\n";

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
/** The task's folder as the host session's agent finds it (FOLDER-3). */
let folder: string;

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
  await buildApp();
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
  // The user's own omp settings, which sessions run with (SESSION-17).
  writeFileSync(join(agentDir, "config.yml"), USER_OMP_SETTINGS);

  // The user's home: credentials, and omp settings of their own.
  home = join(scratch, "home");
  mkdirSync(join(home, ".ssh"), { recursive: true, mode: 0o700 });
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "fixture", "-f", join(home, ".ssh", "id_ed25519")]);
  writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Fixture User\n\temail = fixture@example.com\n");
  mkdirSync(join(home, ".config", "gh"), { recursive: true });
  writeFileSync(join(home, ".config", "gh", "hosts.yml"), "github.com:\n    user: fixture-user\n    oauth_token: gho_fixture\n    git_protocol: ssh\n");
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

/** Sends a prompt into the session's chat as a page does, and waits for its turn to finish. */
async function prompt(target: Session, text: string): Promise<Card> {
  const done = turn("done");
  const chat = await gateway.chat(target.id);
  try {
    await chat.rpc({ type: "prompt", message: text });
  } finally {
    chat.close();
  }
  await done;
  return card(target);
}

/** The next turn of the session's omp, as its channel reports it, that reaches `state`; register before causing it. */
function turn(state: string, on: OmpChannel = channel): Promise<unknown> {
  return on.event((event) => event.type === "turn" && event.turn === state);
}

let chrome: Browser | undefined;
const pages = new Set<Page>();
afterEach(async () => {
  await Promise.all([...pages].map((open) => open.close()));
  pages.clear();
});

/** A page on `hash`, in a browser of its own: no two pages share storage. */
async function openPage(hash: string): Promise<Page> {
  chrome ??= await chromium.launch();
  const opened = await chrome.newPage();
  pages.add(opened);
  opened.setDefaultTimeout(15_000);
  await opened.goto(`${gateway.url}/${hash}`);
  return opened;
}

/** Resolves once the chat draws the session's chat from omp's state: a model is chosen. */
async function loaded(chat: Locator, timeout = 15_000): Promise<void> {
  await chat.getByRole("combobox", { name: "Model" }).locator("option:checked").filter({ hasText: /Scripted|Second/ }).waitFor({ state: "attached", timeout });
}

/** A page on the task's Chat tab, once its chat has loaded. */
async function openChat(target: Task = task, timeout = 15_000): Promise<Locator> {
  const opened = await openPage(`#/t/${target.id}/chat`);
  const chat = opened.getByRole("region", { name: "Chat" });
  await loaded(chat, timeout);
  return chat;
}

/** Types a prompt into the chat's prompt box and sends it, as a person does. */
async function send(chat: Locator, text: string): Promise<void> {
  await chat.getByRole("textbox", { name: "Message" }).fill(text);
  await chat.getByRole("button", { name: "Send" }).click();
}

/** A user message and a reply in the chat's conversation, by their text. */
function said(chat: Locator, text: string | RegExp): Locator {
  return chat.getByRole("log", { name: "Conversation" }).getByRole("article", { name: "Your message" }).filter({ hasText: text });
}
function replied(chat: Locator, text: string | RegExp): Locator {
  return chat.getByRole("log", { name: "Conversation" }).getByRole("article", { name: "Reply" }).filter({ hasText: text });
}

/** CHAT-4: a file pasted into, or dropped onto, the prompt box, as the browser delivers it. */
async function deliver(box: Locator, how: "paste" | "drop", file: { name: string; mimeType: string; data: Buffer }): Promise<void> {
  await box.evaluate((element, { how, name, mimeType, data }) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(atob(data), (char) => char.charCodeAt(0))], name, { type: mimeType }));
    element.dispatchEvent(how === "paste"
      ? new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true })
      : new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, { how, name: file.name, mimeType: file.mimeType, data: file.data.toString("base64") });
}

/** Resolves once the text field holds `text`. */
async function holds(box: Locator, text: string): Promise<void> {
  await box.page().waitForFunction(
    ({ element, text }) => (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) && element.value === text,
    { element: await box.elementHandle(), text },
  );
}

/** Resolves once the element's text differs from `before`. */
async function changes(element: Locator, before: string | null): Promise<void> {
  await element.page().waitForFunction(({ element, before }) => element?.textContent !== before, { element: await element.elementHandle(), before });
}

/** CHAT-2: the seconds a tool call's timer shows (`0.4s`, `12s`, `1m 05s`). */
function seconds(shown: string | null): number {
  const match = /^(?:(\d+)m )?(\d+(?:\.\d+)?)s$/.exec((shown ?? "").trim());
  assert.ok(match, `a timer shows ${shown}`);
  return Number(match[1] ?? 0) * 60 + Number(match[2]);
}

/** Reads `read` until `test` holds; each read is a request, which paces the loop. */
async function until<T>(read: () => Promise<T>, test: (value: T) => boolean, what: string): Promise<T> {
  for (const deadline = Date.now() + 20_000; ;) {
    const value = await read();
    if (test(value)) return value;
    assert.ok(Date.now() < deadline, `never ${what}: ${JSON.stringify(value)}`);
  }
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

spec("HOST-1", "a session runs on the host only where the store's owner allowed host sessions on its project's settings page", async () => {
  const refused = await gateway.api("POST", `/tasks/${task.id}/sessions`, { runtime: "host", model: "fake/scripted" });
  assert.equal(refused.status, 403);
  assert.deepEqual((await gateway.data<{ sessions: Session[] }>("GET", `/tasks/${task.id}`)).sessions, []);

  // The store's owner allows them on the project's settings page, reached from the project menu.
  const settings = await openPage("#/t");
  await settings.getByRole("navigation", { name: "Tasks" }).getByRole("combobox", { name: "Project" }).selectOption({ label: "Project settings" });
  const form = settings.getByRole("form", { name: "Project settings" });
  await form.getByRole("checkbox", { name: /Allow host sessions/ }).check();
  await form.getByRole("button", { name: "Save" }).click();
  await form.getByRole("status").getByText("Saved.").waitFor();
  assert.equal((await gateway.data<Project[]>("GET", "/projects"))[0].hostSessions, true);
  const starting = gateway.data<Session>("POST", `/tasks/${task.id}/sessions`, { runtime: "host", model: "fake/scripted" });
  // The task list shows the session while it starts, and its page opens the chat meanwhile:
  // opened once the worktree exists, the chat waits for the start, which the gateway does
  // not begin a second time.
  let listed: Session[] = [];
  while (listed.length === 0 || !existsSync(dirs(listed[0]).worktree)) {
    listed = (await gateway.data<{ sessions: Session[] }>("GET", `/tasks/${task.id}`)).sessions;
  }
  const opened = gateway.chat(listed[0].id);
  host = await starting;
  (await opened).close();
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

  // The session page shows its chat.
  const chat = await openChat();
  await said(chat, "bash:am whoami").waitFor();
});

spec("HOST-4", "a stopped host session starts again on its last chat when its page opens", async () => {
  for (const { pid } of sessionProcesses(host)) process.kill(pid, "SIGKILL");
  assert.equal((await card(host)).turn, "stopped");
  channel.close();

  const chat = await openChat(task, 60_000);
  await said(chat, "bash:am whoami").waitFor();
  channel = await gateway.omp(host.id);
  const shown = await card(host);
  assert.deepEqual([shown.turn, shown.lastUserMessage], ["done", "bash:am whoami"]);
});

spec("SESSION-17", "a session's agent runs with the user's omp settings, the session's own winning, and the user's file stays as it is", async () => {
  const setting = await prompt(host, "bash:omp config get compaction.thresholdTokens");
  assert.equal(setting.lastReply, "answered: 271828");
  // The user's settings name no extension; Agent Monitor's is the one that runs, so the turn
  // reached the card through it.
  const extensions = await prompt(host, "bash:omp config get extensions");
  assert.match(String(extensions.lastReply), /omp-extension\.ts/);
  assert.equal(readFileSync(join(agentDir, "config.yml"), "utf8"), USER_OMP_SETTINGS);
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

spec("FOLDER-3", "a host session's agent finds its task's folder outside its worktree; what it writes there shows on the page, and the reverse", async () => {
  const { systemPrompt } = await channel.request("system_prompt");
  folder = /The task's folder is the directory `([^`]+)`/.exec(String(systemPrompt))?.[1] ?? "";
  assert.notEqual(folder, "", "the task context names the folder");
  assert.ok(!folder.startsWith(dirs(host).worktree), "the folder is outside the worktree");

  await prompt(host, `bash:echo 'host agent 4c7f' > ${folder}/host-report.md`);
  const opened = await openPage(`#/t/${task.id}`);
  const files = opened.getByRole("region", { name: "Folder" });
  await files.getByRole("row").filter({ hasText: "host-report.md" }).getByText("Agent").waitFor();

  await files.locator("input[type=file]").setInputFiles({ name: "brief.txt", mimeType: "text/plain", buffer: Buffer.from("from the page 6a3b\n") });
  await files.getByRole("row").filter({ hasText: "brief.txt" }).waitFor();
  assert.equal((await prompt(host, `bash:cat ${folder}/brief.txt`)).lastReply, "answered: from the page 6a3b");
  assert.equal(execFileSync("git", ["-C", dirs(host).worktree, "status", "--porcelain"], { encoding: "utf8" }), "");
});

spec("STORE-5", "am task changes says what the task's Work section says", async () => {
  const worktree = dirs(host).worktree;
  writeFileSync(join(worktree, "AGENTS.md"), `# Fixture\n\n${REPO_RULE}\nAnd one more rule.\n`);
  execFileSync("git", ["-C", worktree, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "One more rule"]);
  writeFileSync(join(worktree, "draft.md"), "draft\n");
  try {
    const said = gateway.am(host.id, ["task", "changes"]);
    assert.equal(said.code, 0, said.stderr);

    const opened = await openPage(`#/t/${task.id}`);
    const view = opened.getByRole("region", { name: "Work" });
    await view.locator(".commit", { hasText: "One more rule" }).waitFor();
    await view.locator(".uncommitted code", { hasText: "draft.md" }).waitFor();
    const branch = await view.locator(".branch").textContent();
    const commits = await view.locator(".commit").evaluateAll((items) => items.map((item) => `${item.querySelector(".sha")?.textContent} ${item.querySelector(".commit-subject")?.textContent}`));
    const uncommitted = await view.locator(".uncommitted code").allTextContents();
    await view.locator(".files-toggle").click();
    const files = await view.locator(".changed-files li").evaluateAll((items) => items.map((item) => `${item.querySelector(".file-status")?.getAttribute("title")}\t${item.querySelector("code")?.textContent}`));
    const pullRequests = (await view.locator(".pull-requests").textContent()) ?? "";
    const lines = said.stdout.split("\n");
    assert.match(lines[0], new RegExp(`^branch ${branch} from \\S+: uncommitted changes in the running session: ${uncommitted.join(", ")}$`));
    assert.deepEqual(lines.filter((line) => /^ {2}[0-9a-f]{7} /.test(line)).map((line) => line.trim().split("\t")[0].replace(/ \(not pushed\)$/, "")), commits);
    assert.deepEqual(lines.filter((line) => /^ {2}(added|modified|deleted|renamed)\t/.test(line)).map((line) => line.trim().split("\t").slice(0, 2).join("\t")), files);
    assert.equal(lines[lines.indexOf("pull requests:") + 1], `  ${pullRequests.replace(/\.$/, "").toLowerCase()}`);
    assert.equal(branch, host.branch);
    assert.deepEqual([commits.map((commit) => commit.slice(8)), files, uncommitted], [["One more rule"], ["modified\tAGENTS.md"], ["draft.md"]]);
  } finally {
    rmSync(join(worktree, "draft.md"));
  }
});

spec("CHAT-1", "a host session's page draws its chat from omp's own events, with no other chat program in between; a page of another site cannot open it", async () => {
  const chat = await openChat();
  await said(chat, "bash:am whoami").first().waitFor();
  await replied(chat, "answered: ").first().waitFor();
  const commands = sessionProcesses(host).map((found) => found.cmdline);
  assert.ok(commands.some((cmdline) => /\bomp\b.* --mode rpc-ui\b/.test(cmdline)), `omp runs in RPC mode:\n${commands.join("\n")}`);
  assert.ok(!commands.some((cmdline) => /\btern\b/.test(cmdline)), `no other chat program runs:\n${commands.join("\n")}`);
  await assert.rejects(gateway.chat(host.id, { origin: "http://elsewhere.example" }), /chat refused: 403/);
});

spec("AGENT-2", "a session is driven from its page alone: its transcript with streaming replies, the prompt box, context usage, and its subagents", async () => {
  const helped = await gateway.data<Task>("POST", `/projects/${project.id}/tasks`, { title: "Subagents" });
  const session = await gateway.data<Session>("POST", `/tasks/${helped.id}/sessions`, { runtime: "host", model: "fake/scripted" });
  const own = await gateway.omp(session.id);
  try {
    const chat = await openChat(helped);
    let done = turn("done", own);
    await send(chat, "stream:typed-2a1");
    await fake.holding();
    await replied(chat, "typed").waitFor();
    assert.equal(await replied(chat, "typed 2a1").count(), 0, "the reply shows while it streams");
    fake.release();
    await done;
    await replied(chat, "typed 2a1").waitFor();
    assert.equal(Math.round(Number(await chat.getByRole("meter", { name: "Context" }).getAttribute("aria-valuenow"))), 5);

    // A subagent's work shows under the call that started it.
    done = turn("done", own);
    await send(chat, "subagent:helped-2a1");
    await done;
    await chat.getByRole("log", { name: "Conversation" }).getByRole("button", { name: /^task/ }).click();
    const details = chat.getByRole("region", { name: "task details" });
    await details.getByText("Helper").first().waitFor();
    await chat.getByText(/HELPED-2A1/).first().waitFor({ timeout: 60_000 });
  } finally {
    own.close();
    await gateway.data("POST", `/sessions/${session.id}/end`, {});
  }
}, { timeout: 120_000 });

spec("AGENT-4", "the chat shows a reply and its thinking as they stream, and a command as running, before the turn ends; a reload shows the same conversation", async () => {
  const chat = await openChat();
  let done = turn("done");
  await send(chat, "stream:alpha-omega");
  await fake.holding();
  await replied(chat, "alpha").waitFor();
  await chat.getByRole("log", { name: "Conversation" }).getByRole("group", { name: "Thinking" }).filter({ hasText: "pondering alpha" }).waitFor();
  assert.equal(await replied(chat, "alpha omega").count(), 0);
  assert.equal((await card(host)).turn, "working");
  fake.release();
  await done;
  await replied(chat, "alpha omega").waitFor();

  // A command blocks on a FIFO until the test writes to it; meanwhile its timer runs.
  const gate = join(scratch, "gate-agent-4");
  execFileSync("mkfifo", [gate]);
  done = turn("done");
  await send(chat, `bash:cat ${gate}`);
  const timer = chat.getByRole("log", { name: "Conversation" }).getByRole("button", { name: /^bash/ }).filter({ hasText: "gate-agent-4" }).getByRole("timer");
  await timer.waitFor();
  await changes(timer, await timer.textContent());
  assert.equal((await card(host)).turn, "working");
  await writeFile(gate, "go\n");
  await done;
  await replied(chat, "answered: go").waitFor();

  // After a reload the conversation is the same.
  await chat.page().reload();
  await loaded(chat);
  for (const text of ["stream:alpha-omega", `bash:cat ${gate}`]) await said(chat, text).first().waitFor();
  for (const text of ["alpha omega", "answered: go"]) await replied(chat, text).first().waitFor();
  await chat.getByRole("log", { name: "Conversation" }).getByRole("group", { name: "Thinking" }).filter({ hasText: "pondering alpha" }).waitFor();
});

spec("CHAT-2", "a tool call is one collapsed line with its tool and target and a timer that runs, then stops at how long it took; clicking it shows its input and output", async () => {
  const chat = await openChat();
  const gate = join(scratch, "gate-chat-2");
  execFileSync("mkfifo", [gate]);
  let done = turn("done");
  await send(chat, `bash:cat ${gate} && echo output-2f8`);
  const line = chat.getByRole("log", { name: "Conversation" }).getByRole("button", { name: /^bash/ }).filter({ hasText: "gate-chat-2" });
  await line.waitFor();
  assert.equal(await line.getAttribute("aria-expanded"), "false");
  assert.equal(await chat.getByRole("region", { name: "bash details" }).count(), 0);
  const { height, lineHeight } = await line.evaluate((element) => {
    const style = getComputedStyle(element);
    return { height: element.getBoundingClientRect().height, lineHeight: Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.5 };
  });
  assert.ok(height < 3 * lineHeight, `the call takes one line: ${height}px at ${lineHeight}px a line`);

  // The timer runs while the call runs.
  const timer = line.getByRole("timer");
  await changes(timer, await timer.textContent());
  await writeFile(gate, "go\n");
  await done;
  const took = await timer.textContent();
  assert.ok(seconds(took) > 0);
  // Then it stands still at how long the call took, while a whole other turn goes by.
  done = turn("done");
  await send(chat, "say:after-2f8");
  await done;
  await replied(chat, "after-2f8").waitFor();
  assert.equal(await timer.textContent(), took);

  await line.click();
  assert.equal(await line.getAttribute("aria-expanded"), "true");
  const details = chat.getByRole("region", { name: "bash details" });
  await details.getByText(`cat ${gate} && echo output-2f8`).first().waitFor();
  await details.getByText(/output-2f8/).last().waitFor();
});

spec("AGENT-5", "a question the agent asks shows on the page with its options while the session waits; answering it there goes on", async () => {
  const chat = await openChat();
  const blocked = turn("blocked");
  await send(chat, "ask:Ship?");
  await blocked;
  assert.equal((await card(host)).turn, "blocked");
  const question = chat.page().getByRole("dialog", { name: "Ship?" });
  await question.getByRole("button", { name: "No" }).waitFor();
  const done = turn("done");
  await question.getByRole("button", { name: "Yes" }).click();
  await done;
  await question.waitFor({ state: "detached" });
  const shown = await card(host);
  assert.equal(shown.turn, "done");
  assert.match(String(shown.lastReply), /^answered: /);
});

/** The model id in omp's state. */
function modelOf(state: Record<string, unknown>): unknown {
  return typeof state.model === "object" && state.model !== null && "id" in state.model ? state.model.id : undefined;
}

spec("CHAT-3", "the chat shows the session's model, effort, context usage, and working folder; the model and effort chosen there are the next turn's", async () => {
  const chat = await openChat();
  const model = chat.getByRole("combobox", { name: "Model" });
  const effort = chat.getByRole("combobox", { name: "Effort" });
  assert.match(String(await model.locator("option:checked").textContent()), /Scripted/);
  await effort.waitFor();
  assert.equal(Math.round(Number(await chat.getByRole("meter", { name: "Context" }).getAttribute("aria-valuenow"))), 5);
  assert.ok(String(await chat.getByLabel("Folder").textContent()).includes(dirs(host).worktree), "the working folder shows");

  // omp takes each choice before the next prompt goes out.
  const watcher = await gateway.chat(host.id);
  try {
    const switched = watcher.next((message) => message.type === "state" && modelOf(message.state) === "second");
    await model.selectOption("fake/second");
    await switched;
    const deeper = watcher.next((message) => message.type === "state" && message.state.thinkingLevel === "high");
    await effort.selectOption("high");
    await deeper;
    const done = turn("done");
    await send(chat, "say:effort-3c1");
    await done;
    const asked = fake.requests.findLast((request) => request.said.includes("say:effort-3c1"));
    assert.deepEqual([asked?.model, asked?.effort], ["second", "high"]);

    const back = watcher.next((message) => message.type === "state" && modelOf(message.state) === "scripted");
    await model.selectOption("fake/scripted");
    await back;
  } finally {
    watcher.close();
  }
});

spec("CHAT-4", "an image pasted into the prompt box reaches the model as an image; a file dropped there lands in the task's folder, which the prompt names", async () => {
  const chat = await openChat();
  const box = chat.getByRole("textbox", { name: "Message" });
  const attachments = chat.getByRole("list", { name: "Attachments" });
  await deliver(box, "paste", { name: "shot.png", mimeType: "image/png", data: png() });
  await deliver(box, "drop", { name: "notes-4b2.txt", mimeType: "text/plain", data: Buffer.from("notes 4b2\n") });
  await attachments.getByRole("listitem").filter({ hasText: "shot.png" }).waitFor();
  await attachments.getByRole("listitem").filter({ hasText: "notes-4b2.txt" }).waitFor();
  const done = turn("done");
  await send(chat, "say:attached-4b2");
  await done;
  await attachments.getByRole("listitem").first().waitFor({ state: "detached" });

  const asked = fake.requests.find((request) => request.said.includes("say:attached-4b2"));
  assert.equal(asked?.image, true, "the model saw the image");
  const files = await gateway.data<Array<{ path: string }>>("GET", `/tasks/${task.id}/folder`);
  const stored = files.map((file) => file.path).find((path) => /^chat\/\d{4}-\d{2}-\d{2}-\d{6}-notes-4b2\.txt$/.test(path));
  assert.ok(stored !== undefined, `the file is in the folder's chat/: ${files.map((file) => file.path).join(", ")}`);
  assert.equal(await (await fetch(`${gateway.url}/api/store/tasks/${task.id}/folder/${stored}`)).text(), "notes 4b2\n");
  const { lastUserMessage } = await card(host);
  assert.ok(String(lastUserMessage).includes(`${folder}/${stored}`), `the prompt names the file: ${lastUserMessage}`);
});

spec("CHAT-5", "replies render as Markdown; an image a tool read and an SVG the reply shows from the workspace show inline", async () => {
  const worktree = dirs(host).worktree;
  writeFileSync(join(worktree, "chart-5e1.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#f7768e"/></svg>');
  writeFileSync(join(worktree, "dot-5e1.png"), png());
  try {
    const chat = await openChat();
    const sender = await gateway.chat(host.id);
    try {
      let done = turn("done");
      await sender.rpc({ type: "prompt", message: "markdown:# Notes 5e1\n\nSome **bold 5e1** text.\n\n![chart](chart-5e1.svg)" });
      await done;
      done = turn("done");
      await sender.rpc({ type: "prompt", message: "readfile:dot-5e1.png" });
      await done;
    } finally {
      sender.close();
    }
    const reply = replied(chat, "bold 5e1");
    await reply.getByRole("heading", { name: "Notes 5e1" }).waitFor();
    await reply.locator("strong", { hasText: "bold 5e1" }).waitFor();
    const shown = (image: Locator) => image.evaluate((element) => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0);
    const chart = reply.locator("img");
    await chart.waitFor();
    await chat.page().waitForFunction((element) => element instanceof HTMLImageElement && element.complete && element.naturalWidth === 40, await chart.elementHandle());

    const log = chat.getByRole("log", { name: "Conversation" });
    await log.getByRole("button", { name: /^read/ }).last().click();
    const read = log.locator('img[src^="data:"], img[src^="blob:"]').last();
    await read.waitFor();
    await chat.page().waitForFunction((element) => element instanceof HTMLImageElement && element.complete, await read.elementHandle());
    assert.ok(await shown(read), "the image the tool read shows");
  } finally {
    rmSync(join(worktree, "chart-5e1.svg"));
    rmSync(join(worktree, "dot-5e1.png"));
  }
});

spec("CHAT-6", "what a person types and attaches is kept on the gateway as they type, shows after a reload and in another browser, and goes once omp took it", async () => {
  const { person } = await gateway.data<{ person: { id: string } }>("GET", "/me");
  const file = join(gateway.stateDir, "drafts", host.id, `${person.id}.json`);
  const first = await openChat();
  const box = first.getByRole("textbox", { name: "Message" });
  await box.pressSequentially("say:draft-6d4");
  await deliver(box, "drop", { name: "notes-6d4.txt", mimeType: "text/plain", data: Buffer.from("notes 6d4\n") });
  const kept = await until(
    () => gateway.data<ChatDraft | null>("GET", `/sessions/${host.id}/draft`),
    (draft) => draft?.text === "say:draft-6d4" && draft.attachments.some((attached) => attached.name === "notes-6d4.txt"),
    "kept the draft",
  );
  assert.equal(JSON.parse(readFileSync(file, "utf8")).text, kept?.text, "the draft is a file on the gateway");

  // After a reload, and in another browser.
  await first.page().reload();
  await loaded(first);
  await holds(box, "say:draft-6d4");
  await first.getByRole("list", { name: "Attachments" }).getByRole("listitem").filter({ hasText: "notes-6d4.txt" }).waitFor();
  const second = await openChat();
  const secondBox = second.getByRole("textbox", { name: "Message" });
  await holds(secondBox, "say:draft-6d4");
  await second.getByRole("list", { name: "Attachments" }).getByRole("listitem").filter({ hasText: "notes-6d4.txt" }).waitFor();

  // Sent and taken by omp, it is gone. The first page goes first, so nothing saves it again.
  await first.page().close();
  const done = turn("done");
  await second.getByRole("button", { name: "Send" }).click();
  await done;
  await replied(second, "draft-6d4").waitFor();
  await holds(secondBox, "");
  await until(() => gateway.data<ChatDraft | null>("GET", `/sessions/${host.id}/draft`), (draft) => draft === null, "dropped the draft");
  assert.equal(existsSync(file), false);
});

spec("CHAT-8", "a prompt sent while a turn runs shows as queued until the agent takes it; Stop ends a running turn", async () => {
  const chat = await openChat();
  let done = turn("done");
  await send(chat, "hold:held-8a1");
  await fake.holding();
  await send(chat, "say:queued-8a1");
  const queued = chat.getByRole("list", { name: "Queued" }).getByRole("listitem").filter({ hasText: "say:queued-8a1" });
  await queued.waitFor();
  fake.release();
  await queued.waitFor({ state: "detached" });
  await replied(chat, "queued-8a1").waitFor();
  await done;

  await send(chat, "hold:stopped-8a1");
  await fake.holding();
  // Registered once the held turn runs, so an earlier turn's end cannot settle it.
  const ended = channel.event((event) => event.type === "turn" && event.turn !== "working");
  await chat.getByRole("button", { name: "Stop" }).click();
  await ended;
  fake.release();
  await chat.getByRole("button", { name: "Stop" }).waitFor({ state: "detached" });
  assert.notEqual((await card(host)).turn, "working");
  assert.equal(await replied(chat, "stopped-8a1").count(), 0, "the stopped turn never replied");
  // The session takes the next prompt.
  done = turn("done");
  await send(chat, "say:after-8a1");
  await done;
  await replied(chat, "after-8a1").waitFor();
});

spec("CHAT-9", "pages open on a session show each other's prompts live, and Deploy's", async () => {
  const watching = await openChat();
  const sending = await openChat();
  let done = turn("done");
  await send(sending, "say:both-9b1");
  await done;
  await said(watching, "say:both-9b1").waitFor();
  await replied(watching, "both-9b1").waitFor();

  fake.when(DEPLOY_INSTRUCTION, "say:deployed-9b1");
  done = turn("done");
  await gateway.data("POST", `/tasks/${task.id}/deploy`);
  await done;
  await said(watching, "Deploy: commit what belongs to this work").waitFor();
  await replied(watching, "deployed-9b1").waitFor();
});

spec("CHAT-7", "the chat lists the session's chats, starts a new one, and goes on with an older one", async () => {
  const chat = await openChat();
  await said(chat, "bash:am whoami").first().waitFor();
  const chats = chat.page().getByRole("dialog", { name: "Chats" });
  await chat.getByRole("button", { name: "Chats" }).click();
  await chats.getByRole("button", { name: "New chat" }).click();
  await said(chat, "bash:am whoami").first().waitFor({ state: "detached" });
  const done = turn("done");
  await send(chat, "say:fresh-7e2");
  await done;
  await replied(chat, "fresh-7e2").waitFor();

  await chat.getByRole("button", { name: "Chats" }).click();
  await chats.locator("li button").nth(1).waitFor();
  assert.equal(await chats.locator("li button").count(), 2);
  await chats.locator('li button:not([aria-current="true"])').click();
  await said(chat, "bash:am whoami").first().waitFor();
  assert.equal(await replied(chat, "fresh-7e2").count(), 0);
  // A chat change may start the extension's channel again.
  channel.close();
  channel = await gateway.omp(host.id);
});

spec("HOST-2", "a host session's agent works as the user in its own worktree, and ending it stops every process it started", async () => {
  const uid = String(process.getuid?.());
  const shown = await prompt(host, 'bash:echo "$(id -u) $(pwd) $(git config user.email) $(gh auth token) $(ssh-keygen -y -f ~/.ssh/id_ed25519 | cut -d" " -f2)"');
  const key = readFileSync(join(home, ".ssh", "id_ed25519.pub"), "utf8").split(" ")[1];
  assert.equal(shown.lastReply, `answered: ${uid} ${dirs(host).worktree} fixture@example.com gho_fixture ${key}`);
  await prompt(host, "bash:git commit --allow-empty -qm by-host-agent");
  assert.equal(execFileSync("git", ["-C", repo, "log", "-1", "--format=%an <%ae> %s", host.branch], { encoding: "utf8" }).trim(), "Fixture User <fixture@example.com> by-host-agent");
  // An omp the agent runs itself (a test suite, `omp -p`) inherits the session's environment,
  // its extension included; the session's card still reads the session's own omp afterwards.
  const nested = await prompt(host, "bash:omp -p --model fake/scripted say:nested-5d2 </dev/null 2>/dev/null");
  assert.equal(nested.lastReply, "answered: nested-5d2");
  assert.equal(nested.turn, "done");

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

/** The chats of the checkout that omp in a terminal lists, as omp with `agent` as its agent directory answers it. */
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

/** CHAT-7: the chats the session's chat lists, by omp's ids. */
async function chatsOfSession(target: Session): Promise<string[]> {
  const chat = await gateway.chat(target.id);
  try {
    const answered = chat.next((message) => message.type === "response" && message.id === "chats");
    chat.send({ type: "list_chats", id: "chats" });
    const { data } = z.object({ data: z.object({ chats: z.array(z.object({ id: z.string() })) }) }).parse(await answered);
    return data.chats.map((listed) => listed.id);
  } finally {
    chat.close();
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
  assert.ok((await chatsOfSession(main)).includes(origin), "the session's chat lists the user's chat");

  const shown = await prompt(main, "say:joins-3f0");
  assert.deepEqual([shown.lastUserMessage, shown.lastReply], ["say:joins-3f0", "joins-3f0"]);
  const { sessionFile } = await channel.request("state");
  const own = /_([0-9a-f-]{36})\.jsonl$/.exec(String(sessionFile))?.[1];
  assert.deepEqual((await chatsOfCheckout(agentDir)).toSorted(), [origin, own].toSorted(), "omp in a terminal lists the session's chat");
});

spec("CHAT-7", "a checkout session's chat lists the user's chats of the checkout and goes on with one", async () => {
  // HOST-7 left the session in its own chat, beside the user's.
  const chat = await openChat(mainTask);
  await said(chat, "say:joins-3f0").waitFor();
  await chat.getByRole("button", { name: "Chats" }).click();
  const chats = chat.page().getByRole("dialog", { name: "Chats" });
  const listed = await chatsOfSession(main);
  await chats.locator("li button").nth(listed.length - 1).waitFor();
  assert.equal(await chats.locator("li button").count(), listed.length);
  await chats.locator('li button:not([aria-current="true"])').click();
  await said(chat, "say:origin-7c1").waitFor();
  await replied(chat, "origin-7c1").waitFor();
  channel.close();
  channel = await gateway.omp(main.id);
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

spec("HOST-5", "a host session never changes the user's omp, ssh, git, or gh configuration", () => {
  assert.deepEqual(userConfig(), configBefore);
});
