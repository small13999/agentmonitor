import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, get, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before } from "node:test";
import { chromium, type Browser, type FrameLocator, type Locator, type Page } from "playwright";
import { WebSocket } from "ws";
import { buildImage } from "../scripts/build-image.ts";
import { FakeModel } from "./fake-model.ts";
import { buildApp, Gateway, type OmpChannel } from "./harness.ts";
import { spec } from "./spec.ts";

// Every claim in this file runs against one gateway and its session containers, in order.
interface Session { id: string; taskId: string; name: string; branch: string; machine: string; endedAt: number | null }
interface Task { id: string; title: string; state: string; branch: string | null }
interface Card {
  session: Session;
  turn: string;
  lastUserMessage: string | null;
  lastReply: string | null;
  git: { uncommitted: string[]; unpushed: number; changedFiles: string[] } | null;
  pullRequests: Array<{ number: number; title: string; url: string }> | null;
  overlaps: Array<{ sessionId: string; name: string; files: string[] }>;
  cloudflare: { canWrite: boolean; writesUntil: number | null } | null;
}

const REPO_RULE = "Fixture rule 7f3a: run the fixture linter before committing.";
const PULL_REQUEST = { number: 7, title: "Patch notes JP", url: "https://github.com/example/fixture/pull/7" };
/** What a's task says before its first session starts (TASK-6). */
const TASK_A = {
  description: "Translate the JP patch notes 9c1e.",
  status: "Done: glossary 4b7d\n",
  notes: "Ask Jogi before publishing 2e8f.",
};

let scratch: string;
let repo: string;
/** The user's home the gateway takes git credentials from (SESSION-12). */
let home: string;
/** Cloudflare's API as the gateway's broker reaches it: each request's method, path and token. */
let cloudflareApi: Server;
const cloudflareSeen: Array<{ method: string; path: string; authorization: string }> = [];
let fake: FakeModel;
let gateway: Gateway;
let projectId: string;
let a: Session;
let channelA: OmpChannel;

before(async () => {
  buildImage({ quiet: true });
  buildApp();
  scratch = mkdtempSync(join(tmpdir(), "am-fixture-"));
  repo = join(scratch, "fixture");
  mkdirSync(repo);
  writeFileSync(join(repo, "AGENTS.md"), `# Fixture\n\n${REPO_RULE}\n`);
  // Same file names in nested folders, as a glob over real data folders returns them (AGENT-6).
  for (const file of ["data/brackets/worlds/index.ts", "data/brackets/worlds/2025/index.ts", "data/brackets/worlds/2025/knockout.ts", "data/participants/worlds/2025.ts"]) {
    mkdirSync(join(repo, file, ".."), { recursive: true });
    writeFileSync(join(repo, file), "export {};\n");
  }
  for (const args of [["init", "-q", "-b", "main"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]]) {
    execFileSync("git", args, { cwd: repo });
  }
  // omp's only model is the scripted fake; GitHub is a fake gh that lists one open PR.
  fake = await FakeModel.start();
  const agentDir = join(scratch, "omp-agent");
  mkdirSync(agentDir);
  fake.writeAgentDir(agentDir);
  const gh = join(scratch, "gh");
  writeFileSync(gh, `#!/bin/sh\necho '${JSON.stringify([PULL_REQUEST])}'\n`);
  chmodSync(gh, 0o755);

  // The user's git credentials and the project's Cloudflare tokens, which the gateway keeps.
  home = join(scratch, "home");
  mkdirSync(join(home, ".ssh"), { recursive: true, mode: 0o700 });
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "fixture", "-f", join(home, ".ssh", "id_ed25519")]);
  writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Fixture User\n\temail = fixture@example.com\n");
  mkdirSync(join(home, ".config", "gh"), { recursive: true });
  writeFileSync(join(home, ".config", "gh", "hosts.yml"), "github.com:\n    user: fixture-user\n    oauth_token: gho_fixture\n    git_protocol: ssh\n");
  const config = join(scratch, "config");
  mkdirSync(join(config, "cloudflare"), { recursive: true });
  writeFileSync(join(config, "cloudflare", "fixture.env"), "CLOUDFLARE_READ_TOKEN=cf-read-fixture\nCLOUDFLARE_WRITE_TOKEN=cf-write-fixture\n");
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

  gateway = await Gateway.start({
    runtime: "podman",
    env: {
      AGENTMONITOR_OMP_AGENT_DIR: agentDir,
      AGENTMONITOR_GH: gh,
      AGENTMONITOR_CREDENTIALS_HOME: home,
      AGENTMONITOR_CONFIG_DIR: config,
      AGENTMONITOR_CLOUDFLARE_API: `http://127.0.0.1:${address.port}`,
    },
  });
  projectId = (await gateway.data<{ id: string }>("POST", "/projects", { name: "fixture", repoPath: repo })).id;
  const taskA = await gateway.data<Task>("POST", `/projects/${projectId}/tasks`, { title: "Patch Notes JP", description: TASK_A.description });
  await gateway.data("PUT", `/tasks/${taskA.id}/status`, { status: TASK_A.status, baseRevision: 0 });
  await gateway.data("PUT", `/tasks/${taskA.id}/notes`, { text: TASK_A.notes, baseRevision: 0 });
  a = await gateway.data<Session>("POST", `/tasks/${taskA.id}/sessions`, { model: "fake/scripted" });
  channelA = await gateway.omp(a.id);
}, { timeout: 60_000 });

after(async () => {
  await chrome?.close();
  channelA?.close();
  await gateway?.stop();
  await fake?.stop();
  cloudflareApi?.close();
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

/** A new task with a session working on it. */
async function session(title: string): Promise<Session> {
  const task = await gateway.data<Task>("POST", `/projects/${projectId}/tasks`, { title });
  return gateway.data<Session>("POST", `/tasks/${task.id}/sessions`, { model: "fake/scripted" });
}

async function taskOf(target: Session): Promise<{ task: Task; topics: Array<{ name: string }> }> {
  return gateway.data<{ task: Task; topics: Array<{ name: string }> }>("GET", `/tasks/${target.taskId}`);
}

function exec(target: Session, args: string[]): string {
  return execFileSync("podman", ["exec", `am-${target.id}`, ...args], { encoding: "utf8" }).trim();
}

async function cards(): Promise<Card[]> {
  return gateway.data<Card[]>("GET", `/projects/${projectId}/cards`);
}

async function card(target: Session): Promise<Card> {
  const found = (await cards()).find((candidate) => candidate.session.id === target.id);
  assert.ok(found, `no card for ${target.name}`);
  return found;
}

/** Reads the session's card until `test` holds; each read asks git and omp, which paces the loop. */
async function cardShowing(target: Session, test: (shown: Card) => boolean, what: string): Promise<Card> {
  for (const deadline = Date.now() + 20_000; ;) {
    const shown = await card(target);
    if (test(shown)) return shown;
    assert.ok(Date.now() < deadline, `the card of ${target.name} never showed ${what}`);
  }
}

/** Type a prompt into the session's chat in Tern and wait until its turn reaches `turn`. */
async function prompt(target: Session, channel: OmpChannel, text: string, turn: string): Promise<void> {
  const reached = channel.event((event) => event.type === "turn" && event.turn === turn);
  exec(target, ["tern", "send", "workspace/@focused", "text", text]);
  exec(target, ["tern", "send", "workspace/@focused", "keys", "Enter"]);
  await reached;
}

let chrome: Browser | undefined;
const openPages = new Set<Page>();

async function closePages(): Promise<void> {
  await Promise.all([...openPages].map((page) => page.close()));
  openPages.clear();
}

afterEach(closePages);

interface Chat {
  page: Page;
  /** Tern's web client in the session page's chat view. */
  frame: FrameLocator;
}

/**
 * A fresh session page. Earlier pages close first: a second web client on the session takes
 * several times as long to sync. All chat claims share one browser, since starting Tern's
 * web client in a new one costs seconds. The client draws with WebGPU; without a GPU,
 * Chromium runs it on Mesa's llvmpipe Vulkan driver.
 */
async function sessionPage(target: Session): Promise<Page> {
  await closePages();
  chrome ??= await chromium.launch({
    args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--enable-features=Vulkan,VulkanFromANGLE", "--use-vulkan=native", "--use-angle=vulkan"],
  });
  const page = await chrome.newPage();
  openPages.add(page);
  page.setDefaultTimeout(15_000);
  await page.goto(`${gateway.url}/#/t/${target.taskId}`);
  return page;
}

/** A fresh page on the board. */
async function boardPage(): Promise<Page> {
  const page = await sessionPage(a);
  await page.getByRole("navigation", { name: "Menus" }).getByRole("link", { name: "Board" }).click();
  await page.getByRole("region", { name: "Board" }).waitFor();
  return page;
}

/** A fresh session page, once its chat view shows Tern's chat synced with omp. */
async function openChat(target: Session): Promise<Chat> {
  const page = await sessionPage(target);
  const frame = page.frameLocator("iframe.session-frame.current");
  await frame.getByRole("group", { name: /^Model: Scripted/ }).waitFor();
  return { page, frame };
}

/**
 * Open the chat until it shows `shown` (a text, or an element). Tern's web client draws on a
 * canvas and mirrors what it draws into an accessibility tree. The tree is complete when the
 * page loads, but later changes reach it late, and not at all while the composer has focus,
 * so each look is a fresh page.
 */
async function chatShowing(target: Session, shown: string | ((frame: FrameLocator) => Locator)): Promise<Chat> {
  const find = typeof shown === "string" ? (frame: FrameLocator) => frame.getByText(shown, { exact: true }) : shown;
  for (const deadline = Date.now() + 20_000; ;) {
    const chat = await openChat(target);
    if (await find(chat.frame).count() > 0) return chat;
    assert.ok(Date.now() < deadline, `the chat never showed ${String(shown)}`);
  }
}

/** Click where the client drew an element; the canvas, not the mirrored element, takes pointer input. */
async function clickDrawn(chat: Chat, element: Locator): Promise<void> {
  const box = await element.boundingBox();
  assert.ok(box, "the element is not drawn");
  await chat.page.mouse.click(box.x + Math.min(20, box.width / 2), box.y + box.height / 2);
}

async function send(chat: Chat, text: string): Promise<void> {
  await clickDrawn(chat, chat.frame.getByRole("textbox", { name: "Message" }));
  await chat.page.keyboard.type(text);
  await chat.page.keyboard.press("Enter");
}

spec("SESSION-5", "a session belongs to one task and works in a worktree of the task's branch on one machine", async () => {
  const { task } = await taskOf(a);
  assert.equal(task.title, "Patch Notes JP");
  assert.match(a.branch, /^am\/patch-notes-jp-[0-9a-f]{4}$/);
  assert.equal(task.branch, a.branch);
  assert.ok(a.machine.length > 0);

  assert.equal(exec(a, ["git", "-C", "/workspace/fixture", "branch", "--show-current"]), a.branch);
  assert.equal(exec(a, ["cat", "/workspace/fixture/AGENTS.md"]), `# Fixture\n\n${REPO_RULE}`);
  assert.match(exec(a, ["am", "whoami"]), new RegExp(`^task {4}Patch Notes JP \\(${task.id}, in_progress\\)$`, "m"));
});

spec("SESSION-4", "a chat starts with the workflow context and the repository's AGENTS.md", async () => {
  const { systemPrompt } = await channelA.request("system_prompt");
  assert.equal(typeof systemPrompt, "string");
  assert.ok(String(systemPrompt).includes(REPO_RULE), "repository AGENTS.md is project context");
  assert.ok(String(systemPrompt).includes("# Agent Monitor session"), "workflow AGENTS.md is user context");
  assert.ok(String(systemPrompt).includes("am topic link NAME"), "workflow RULES.md is a sticky rule");
});

spec("TASK-6", "a session's first chat starts with its task's title, description, status, and notes", async () => {
  const { systemPrompt } = await channelA.request("system_prompt");
  for (const part of ['"Patch Notes JP"', TASK_A.description, TASK_A.status.trim(), TASK_A.notes]) {
    assert.ok(String(systemPrompt).includes(part), `the context holds ${part}`);
  }
});

spec("CARD-2", "a card shows the last user message and the agent's last reply", async () => {
  await prompt(a, channelA, "say:hello", "done");
  const shown = await card(a);
  assert.equal(shown.lastUserMessage, "say:hello");
  assert.equal(shown.lastReply, "hello");
});

spec("CARD-3", "a card shows uncommitted changes, unpushed commits, and open pull requests", async () => {
  exec(a, ["sh", "-c", [
    "cd /workspace/fixture",
    "echo note > notes.txt",
    "echo more >> AGENTS.md",
    "git -c user.name=a -c user.email=a@a commit -qam 'Translate patch notes'",
    "echo draft > draft.md",
  ].join(" && ")]);
  const shown = await card(a);
  assert.deepEqual(shown.git?.uncommitted.sort(), ["draft.md", "notes.txt"]);
  assert.equal(shown.git?.unpushed, 1);
  assert.deepEqual(shown.pullRequests, [PULL_REQUEST]);
});

let b: Session;

spec("CARD-4", "a card names other sessions that changed the same files", async () => {
  b = await session("Client fixes");
  const worktreeB = join(gateway.stateDir, "sessions", b.id, "worktree");
  writeFileSync(join(worktreeB, "AGENTS.md"), "# Fixture\n\nrewritten\n");
  writeFileSync(join(worktreeB, "client.ts"), "export {};\n");

  const shownA = await card(a);
  const shownB = await card(b);
  assert.deepEqual(shownA.overlaps, [{ sessionId: b.id, name: "Client fixes", files: ["AGENTS.md"] }]);
  assert.deepEqual(shownB.overlaps, [{ sessionId: a.id, name: "Patch Notes JP", files: ["AGENTS.md"] }]);
});

spec("CARD-5", "sessions waiting on you sort first", async () => {
  const channelB = await gateway.omp(b.id);
  try {
    await prompt(b, channelB, "ask:Proceed?", "blocked");
    const order = await cards();
    assert.deepEqual(order.map((shown) => [shown.session.name, shown.turn]), [["Client fixes", "blocked"], ["Patch Notes JP", "done"]]);
  } finally {
    channelB.close();
  }
});

spec("BOARD-2", "tasks waiting on you sort first in their column, and the header counts them", async () => {
  // CARD-5 left b waiting on you; a's turn is done. Both tasks are in progress.
  const page = await boardPage();
  const column = page.getByRole("region", { name: "In progress" });
  await column.locator(".card-blocked").waitFor();
  assert.deepEqual(await column.locator(".card strong").allTextContents(), ["Client fixes", "Patch Notes JP"]);
  assert.equal(await page.getByRole("navigation", { name: "Menus" }).getByRole("link", { name: "Board" }).locator(".badge").textContent(), "1");
});

spec("BOARD-1", "the board shows tasks in columns by state, each with its topics and its session's light, messages, and changes", async () => {
  const release = await gateway.data<{ id: string }>("POST", `/projects/${projectId}/topics`, { name: "Release" });
  await gateway.data("PUT", `/tasks/${a.taskId}/topics/${release.id}`);
  await gateway.data("POST", `/projects/${projectId}/tasks`, { title: "Leaderboard filters" });
  const page = await boardPage();
  assert.deepEqual(await page.getByRole("region", { name: "Board" }).locator(".column h2").allTextContents(), ["Open 1", "In progress 2", "In review 0", "Done 0"]);
  await page.getByRole("region", { name: "Open" }).getByRole("link", { name: /Leaderboard filters.*No session/ }).waitFor();
  // b's card names a's session among its overlaps, so pick a's card by its title.
  const cardA = page.getByRole("region", { name: "In progress" }).locator(".card").filter({ has: page.locator("strong", { hasText: "Patch Notes JP" }) });
  await cardA.locator(".chip", { hasText: "Release" }).waitFor();
  await cardA.getByLabel("Turn done").waitFor();
  await cardA.getByText("say:hello").waitFor();
  await cardA.getByText("2 uncommitted · 1 unpushed").waitFor();
  await cardA.getByRole("link", { name: "PR #7" }).waitFor();
  await cardA.click();
  await page.waitForURL(new RegExp(`#/t/${a.taskId}$`));
});

const turnDone = () => channelA.event((event) => event.type === "turn" && event.turn === "done");

/** Opens Tern's /wire socket through the gateway as a page on `origin` would: "open", or the refusal's status. */
async function openWire(host: string, origin: string): Promise<string> {
  const socket = new WebSocket(`ws://127.0.0.1:${new URL(gateway.url).port}/wire`, { headers: { host }, origin });
  const { promise, resolve } = Promise.withResolvers<string>();
  socket.on("open", () => {
    socket.close();
    resolve("open");
  });
  socket.on("unexpected-response", (request, response) => {
    request.destroy();
    resolve(String(response.statusCode));
  });
  socket.on("error", (error) => resolve(error.message));
  return promise;
}

spec("AGENT-1", "the session page opens the session's chat in Tern; only the gateway holds Tern's token", async () => {
  const chat = await openChat(a);
  await chat.frame.getByRole("textbox", { name: "Message" }).waitFor();
  const token = readFileSync(join(gateway.stateDir, "sessions", a.id, "run", "tern-token"), "utf8").trim();
  for (const frame of chat.page.frames()) assert.ok(!frame.url().includes(token), `${frame.url()} carries Tern's token`);
  // The gateway adds the token to Tern's socket for pages on the session's Tern host only:
  // another site open in the same browser cannot drive the session.
  const host = `tern-${a.id}.localhost:${new URL(gateway.url).port}`;
  assert.equal(await openWire(host, `http://${host}`), "open");
  assert.equal(await openWire(host, "http://elsewhere.example"), "403");
});

spec("AGENT-3", "web and Tern prompts land in the same conversation", async () => {
  // CARD-2 typed say:hello in Tern; the web shows it and its reply.
  const chat = await chatShowing(a, "say:hello");
  await chat.frame.getByText("hello", { exact: true }).first().waitFor({ state: "attached" });
  const done = turnDone();
  await send(chat, "say:fromweb");
  await done;
  const shown = await card(a);
  assert.equal(shown.lastUserMessage, "say:fromweb");
  assert.equal(shown.lastReply, "fromweb");
  await chatShowing(a, "fromweb");
});

spec("AGENT-4", "the web UI streams replies and thinking, and shows running commands", async () => {
  // Mid-reply, the chat shows the reply so far and its (collapsed) thinking.
  await prompt(a, channelA, "stream:alpha-omega", "working");
  await fake.holding();
  let chat = await chatShowing(a, "alpha");
  assert.equal(await chat.frame.getByText("alpha omega", { exact: true }).count(), 0);
  await chat.frame.getByRole("button", { name: "Thought" }).last().waitFor({ state: "attached" });
  let done = turnDone();
  fake.release();
  await done;

  // A command shows as running until it ends; it blocks on a FIFO until the test writes to it.
  const command = "mkfifo /tmp/gate; cat /tmp/gate; echo finished-run";
  await prompt(a, channelA, `bash:${command}`, "working");
  chat = await chatShowing(a, (frame) => frame.getByRole("button", { name: "Bash, running" }));
  await chat.frame.getByText(command, { exact: true }).last().waitFor({ state: "attached" });
  done = turnDone();
  exec(a, ["sh", "-c", "echo go > /tmp/gate"]);
  await done;

  // A fresh page shows the whole conversation again, the command finished.
  chat = await chatShowing(a, (frame) => frame.getByRole("button", { name: "Bash, done" }));
  assert.equal(await chat.frame.getByRole("button", { name: "Bash, running" }).count(), 0);
  for (const text of ["say:hello", "say:fromweb", "stream:alpha-omega", `bash:${command}`, "hello", "fromweb", "alpha omega"]) {
    await chat.frame.getByText(text, { exact: true }).first().waitFor({ state: "attached" });
  }
});

spec("AGENT-5", "a question the agent asks shows in the web UI with its options", async () => {
  await prompt(a, channelA, "ask:Ship?", "blocked");
  assert.equal((await card(a)).turn, "blocked");
  const question = (await chatShowing(a, (frame) => frame.getByRole("dialog"))).frame.getByRole("dialog");
  await question.getByText("Ship?", { exact: true }).first().waitFor({ state: "attached" });
  await question.getByRole("option", { name: "Yes" }).waitFor({ state: "attached" });
  await question.getByRole("option", { name: "No" }).waitFor({ state: "attached" });
  // Withdraw the question, so the session is free for the next claims.
  const done = turnDone();
  exec(a, ["tern", "send", "workspace/@focused", "keys", "Escape"]);
  await done;
});

spec("AGENT-6", "a file list with repeated names shows, and so does the conversation after it", async () => {
  // data/ holds index.ts in a folder and in its subfolder.
  await prompt(a, channelA, "glob:data/**", "done");
  await prompt(a, channelA, "say:afterglob", "done");
  const chat = await chatShowing(a, "afterglob");
  // Tern labels omp's glob "Grep" and draws its files as a tree.
  await chat.frame.getByRole("button", { name: /^Grep, .*, done$/ }).last().waitFor({ state: "attached" });
  await chat.frame.getByText(/knockout\.ts/).last().waitFor({ state: "attached" });
});

/** Asks the gateway for Tern's fallback fonts as a page on `origin` would: the response's status. */
async function fontsStatus(host: string, origin: string): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  get({ host: "127.0.0.1", port: new URL(gateway.url).port, path: "/fonts?chars=2713", headers: { host, origin } }, (response) => {
    response.resume();
    resolve(response.statusCode ?? 0);
  }).on("error", reject);
  return promise;
}

spec("AGENT-7", "text in any script, symbols and emoji show in a font that has them", async () => {
  const text = "한국어✓😀العربية";
  await prompt(a, channelA, `say:${text}`, "done");
  const chat = await chatShowing(a, text);
  const frame = chat.page.frames().find((candidate) => candidate.url().startsWith(`http://tern-${a.id}.localhost`));
  assert.ok(frame, "the chat view holds no Tern page");
  // Tern's web client asks the workspace's Tern for fonts covering what its own faces lack
  // (here Korean and Arabic), and loads them.
  await frame.waitForFunction(() => performance.getEntriesByType("resource").some((entry) => /^\/fonts\/[0-9a-f]+$/.test(new URL(entry.name).pathname)));
  const loads = await frame.evaluate(() => performance.getEntriesByType("resource").flatMap((entry) =>
    entry instanceof PerformanceResourceTiming && new URL(entry.name).pathname.startsWith("/fonts") ? [{ url: entry.name, status: entry.responseStatus }] : []));
  for (const load of loads) assert.equal(load.status, 200, `${load.url} failed`);
  // Each character it asked about has a font.
  const asked = loads.flatMap((load) => new URL(load.url).searchParams.get("chars")?.split(",") ?? []);
  assert.ok(asked.length > 0, "the client never asked which fonts cover its characters");
  const uncovered = await frame.evaluate(async (codePoints) => {
    const missing: string[] = [];
    for (const codePoint of codePoints) {
      const body: unknown = await (await fetch(`/fonts?chars=${codePoint}`)).json();
      if (!(typeof body === "object" && body !== null && "fonts" in body && Array.isArray(body.fonts) && body.fonts.length > 0)) missing.push(codePoint);
    }
    return missing;
  }, asked);
  assert.deepEqual(uncovered, []);
  // Only the session's Tern pages get fonts through the gateway.
  const host = `tern-${a.id}.localhost:${new URL(gateway.url).port}`;
  assert.equal(await fontsStatus(host, `http://${host}`), 200);
  assert.equal(await fontsStatus(host, "http://elsewhere.example"), 403);
});

spec("CARD-1", "a card shows whether its session is blocked on you, working, done, or stopped", async () => {
  assert.equal((await card(b)).turn, "blocked");

  await prompt(a, channelA, "hold:later", "working");
  assert.equal((await card(a)).turn, "working");
  const done = channelA.event((event) => event.type === "turn" && event.turn === "done");
  await fake.holding();
  fake.release();
  await done;
  assert.equal((await card(a)).turn, "done");

  execFileSync("podman", ["stop", "-t", "0", `am-${a.id}`]);
  assert.equal((await card(a)).turn, "stopped");
});

spec("SESSION-10", "opening a session whose container stopped starts it again on its last chat", async () => {
  // CARD-1 stopped a's container after its last turn, "hold:later".
  await chatShowing(a, "later");
  const shown = await card(a);
  assert.equal(shown.turn, "done");
  assert.equal(shown.lastUserMessage, "hold:later");
});

/** The session's chat transcripts; subagent transcripts sit a level deeper. */
function chats(target: Session): string[] {
  const sessions = join(gateway.stateDir, "sessions", target.id, "omp-home", "agent", "sessions");
  return readdirSync(sessions, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".jsonl") && path.split("/").length === 2)
    .map((path) => join(sessions, path));
}

spec("SESSION-7", "a new chat stays in its session, with the session's worktree and task", async () => {
  await gateway.data("POST", `/projects/${projectId}/topics`, { name: "Patch notes" });
  assert.equal(gateway.am(a.id, ["topic", "link", "Patch notes"]).code, 0);
  const before = chats(a).length;

  // Tern's chat command for a new chat with the same agent, in the same pane.
  exec(a, ["tern", "send", "workspace/@focused", "text", "/new"]);
  exec(a, ["tern", "send", "workspace/@focused", "keys", "Enter"]);
  exec(a, ["tern", "send", "workspace/@focused", "text", "say:newchat"]);
  exec(a, ["tern", "send", "workspace/@focused", "keys", "Enter"]);

  const shown = await cardShowing(a, (candidate) => candidate.lastReply === "newchat", "the new chat's reply");
  assert.equal(shown.lastUserMessage, "say:newchat");
  assert.equal(chats(a).length, before + 1);
  // The new chat's agent is still on a's task, with its topics (BOARD-1 linked Release).
  assert.match(exec(a, ["am", "task", "show"]), /^task Patch Notes JP .*\n(.*\n)*topics Release, Patch notes$/m);
  // CARD-3's commit and uncommitted files are still in the worktree.
  assert.equal(exec(a, ["git", "-C", "/workspace/fixture", "log", "-1", "--format=%s"]), "Translate patch notes");
  assert.deepEqual(shown.git?.uncommitted.sort(), ["draft.md", "notes.txt"]);
  await chatShowing(a, "newchat");
});

/** Git in a session's worktree on the host, as a user with an identity. */
function gitIn(target: Session, ...args: string[]): string {
  const worktree = join(gateway.stateDir, "sessions", target.id, "worktree");
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: worktree, encoding: "utf8" }).trim();
}

spec("SESSION-8", "ending a session removes its workspace and keeps its chats and the task's branch", async () => {
  // b pushes client.ts (new in CARD-4); AGENTS.md (changed in CARD-4) and a scratch file stay uncommitted.
  execFileSync("git", ["init", "-q", "--bare", join(scratch, "origin.git")]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", join(scratch, "origin.git")]);
  gitIn(b, "add", "client.ts");
  gitIn(b, "commit", "-qm", "Add client");
  gitIn(b, "push", "-q", "origin", b.branch);
  writeFileSync(join(gateway.stateDir, "sessions", b.id, "worktree", "scratch.txt"), "draft\n");

  const page = await sessionPage(b);
  await page.getByRole("button", { name: "Workspace settings" }).click();
  const settings = page.getByRole("complementary", { name: "Workspace settings" });
  await settings.getByRole("button", { name: "End session" }).click();
  await settings.getByRole("region", { name: "End session" }).getByRole("button", { name: "End session" }).click();
  await settings.getByRole("status").filter({ hasText: "Session ended. 2 uncommitted files were kept for the task's next session." }).waitFor();
  // Without a session, the task's chat tab offers to start one.
  await page.getByRole("region", { name: "Start session" }).getByRole("button", { name: "Start session" }).waitFor();

  const ended = await gateway.data<{ session: Session }>("GET", `/sessions/${b.id}`);
  assert.notEqual(ended.session.endedAt, null);
  assert.equal(spawnSync("podman", ["container", "exists", `am-${b.id}`]).status, 1, "the container is gone");
  assert.ok(!existsSync(join(gateway.stateDir, "sessions", b.id, "worktree")), "the worktree is gone");
  assert.equal(spawnSync("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/${b.branch}`]).status, 0, "the branch stays");
  assert.ok(chats(b).some((path) => readFileSync(path, "utf8").includes("ask:Proceed?")), "the chat is kept");
});

let b2: Session;

spec("SESSION-9", "ending never loses work: the next session of the task gets its uncommitted changes back, and no push carries them", async () => {
  // SESSION-8 ended b with AGENTS.md changed and scratch.txt new: kept here, outside branches and tags,
  // so pushing the task's branch with every tag leaves it behind.
  const kept = execFileSync("git", ["-C", repo, "for-each-ref", "--format=%(refname)", "refs/agentmonitor"], { encoding: "utf8" }).trim();
  assert.equal(kept, `refs/agentmonitor/snapshots/${b.taskId}`);
  execFileSync("git", ["-C", repo, "push", "-q", "--tags", "origin", b.branch]);
  assert.doesNotMatch(execFileSync("git", ["-C", repo, "ls-remote", "origin"], { encoding: "utf8" }), /agentmonitor/);

  b2 = await gateway.data<Session>("POST", `/tasks/${b.taskId}/sessions`, { model: "fake/scripted" });
  assert.equal(exec(b2, ["cat", "/workspace/fixture/AGENTS.md"]), "# Fixture\n\nrewritten");
  assert.equal(exec(b2, ["cat", "/workspace/fixture/scratch.txt"]), "draft");
  // Still uncommitted, as they were left: AGENTS.md changed, scratch.txt untracked.
  assert.equal(gitIn(b2, "diff", "--name-only"), "AGENTS.md");
  assert.equal(gitIn(b2, "ls-files", "--others", "--exclude-standard"), "scratch.txt");
  // Restored once: the next session after this one starts from what this one leaves.
  assert.equal(execFileSync("git", ["-C", repo, "for-each-ref", "refs/agentmonitor"], { encoding: "utf8" }), "");
});

spec("TASK-4", "every session of a task works on the task's branch, which outlives them", async () => {
  const { task } = await taskOf(b2);
  assert.equal(b2.branch, b.branch);
  assert.equal(task.branch, b.branch);
  assert.equal(exec(b2, ["git", "-C", "/workspace/fixture", "branch", "--show-current"]), b.branch);
  assert.equal(exec(b2, ["git", "-C", "/workspace/fixture", "log", "-1", "--format=%s"]), "Add client");
});

spec("TASK-9", "finishing a task ends its session and deletes its branch here, asking first for commits no remote has", async () => {
  gitIn(b2, "add", "-A");
  gitIn(b2, "commit", "-qm", "Keep notes");
  const unpushed = gitIn(b2, "log", "-1", "--format=%h %s");

  const page = await sessionPage(b2);
  await page.getByRole("button", { name: "Workspace settings" }).click();
  const finish = page.getByRole("complementary", { name: "Workspace settings" }).getByRole("region", { name: "Finish task" });
  await finish.getByRole("button", { name: "Mark done" }).click();
  await finish.getByText("No remote has these commits; finishing deletes them with the branch:").waitFor();
  assert.deepEqual(await finish.locator(".unpushed code").allTextContents(), [unpushed]);
  assert.equal((await taskOf(b2)).task.state, "in_progress", "the refused finish changed nothing");

  await finish.getByRole("button", { name: "Mark done and delete them" }).click();
  await page.getByRole("region", { name: "Start session" }).getByText("This task is done.").waitFor();
  assert.equal((await taskOf(b2)).task.state, "done");
  assert.notEqual((await gateway.data<{ session: Session }>("GET", `/sessions/${b2.id}`)).session.endedAt, null);
  assert.equal(spawnSync("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/${b.branch}`]).status, 1, "the branch is gone here");
  assert.match(execFileSync("git", ["-C", repo, "ls-remote", "origin", b.branch], { encoding: "utf8" }).trim(), new RegExp(`refs/heads/${b.branch}$`), "origin keeps it");
});

spec("TASK-11", "am check lists what would not survive the session and fails until it is clean", async () => {
  // CARD-3 left draft.md and notes.txt uncommitted and "Translate patch notes" unpushed in a.
  exec(a, ["sh", "-c", "echo KEY=1 > /workspace/fixture/r2.env"]);
  const dirty = spawnSync("podman", ["exec", `am-${a.id}`, "am", "check"], { encoding: "utf8" });
  assert.equal(dirty.status, 1);
  for (const line of ["uncommitted files (2)", "  draft.md", "  notes.txt", "untracked files that look like secrets (1)", "  r2.env", "unpushed commits (1)"]) {
    assert.ok(dirty.stdout.split("\n").some((shown) => shown.startsWith(line)), `am check lists ${line}:\n${dirty.stdout}`);
  }
  assert.match(dirty.stdout, /^ {2}[0-9a-f]+ Translate patch notes$/m);

  // As the rules say: commit the work, ignore the secret, push.
  writeFileSync(join(gateway.stateDir, "sessions", a.id, "worktree", ".gitignore"), "r2.env\n");
  gitIn(a, "add", "-A");
  gitIn(a, "commit", "-qm", "Drafts and notes");
  gitIn(a, "push", "-q", "origin", "HEAD");
  assert.equal(exec(a, ["am", "check"]), "clean: everything is committed and pushed");
});

spec("SESSION-12", "a session's agent commits as the user, with the user's ssh keys and gh login", async () => {
  const channel = await gateway.omp(a.id);
  try {
    await prompt(a, channel, "bash:git commit --allow-empty -qm by-agent", "done");
  } finally {
    channel.close();
  }
  assert.equal(execFileSync("git", ["-C", repo, "log", "-1", "--format=%an <%ae> %s", a.branch], { encoding: "utf8" }).trim(), "Fixture User <fixture@example.com> by-agent");
  // ssh takes the key where it looks for keys; it refuses keys that others can read.
  const key = (text: string) => text.trim().split(" ").slice(0, 2).join(" ");
  assert.equal(key(exec(a, ["ssh-keygen", "-y", "-f", "/home/agent/.ssh/id_ed25519"])), key(readFileSync(join(home, ".ssh", "id_ed25519.pub"), "utf8")));
  assert.equal(exec(a, ["gh", "auth", "token"]), "gho_fixture");
});

/**
 * Calls Cloudflare's API from the agent's bash tool, as Wrangler does: at
 * CLOUDFLARE_API_BASE_URL with CLOUDFLARE_API_TOKEN. The status and Cloudflare's error message.
 */
async function agentCloudflare(channel: OmpChannel, method: string, path: string): Promise<{ status: number; message: string | null }> {
  const client = [
    `import { writeFileSync } from "node:fs";`,
    `const [method, path, out] = process.argv.slice(2);`,
    `try {`,
    `  const response = await fetch(process.env.CLOUDFLARE_API_BASE_URL + path, { method, headers: { authorization: "Bearer " + process.env.CLOUDFLARE_API_TOKEN, "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" });`,
    `  const body = await response.json();`,
    `  writeFileSync(out, JSON.stringify({ status: response.status, message: body.errors?.[0]?.message ?? null }));`,
    `} catch (error) {`,
    `  writeFileSync(out, JSON.stringify({ status: 0, message: String(error.cause ?? error) + " base=" + process.env.CLOUDFLARE_API_BASE_URL }));`,
    `}`,
  ].join("\n");
  exec(a, ["sh", "-c", `cat > /tmp/cloudflare.mjs <<'EOF'\n${client}\nEOF`]);
  const out = `/tmp/cloudflare-${cloudflareSeen.length}-${Date.now()}.json`;
  await prompt(a, channel, `bash:node /tmp/cloudflare.mjs ${method} ${path} ${out}`, "done");
  const answer = exec(a, ["sh", "-c", `cat ${out} 2>/dev/null || true`]);
  // The fake model replies with the first line of the command's output.
  assert.ok(answer !== "", `the Cloudflare client failed: ${(await card(a)).lastReply ?? ""}`);
  const result: unknown = JSON.parse(answer);
  assert.ok(
    typeof result === "object" && result !== null && "status" in result && typeof result.status === "number"
      && "message" in result && (typeof result.message === "string" || result.message === null),
    `unexpected answer ${JSON.stringify(result)}`,
  );
  return { status: result.status, message: result.message };
}

spec("CLOUDFLARE-1", "an agent reads its project's Cloudflare account through the gateway, which keeps the tokens", async () => {
  const channel = await gateway.omp(a.id);
  try {
    assert.deepEqual(await agentCloudflare(channel, "GET", "/accounts"), { status: 200, message: null });
  } finally {
    channel.close();
  }
  assert.deepEqual(cloudflareSeen.at(-1), { method: "GET", path: "/client/v4/accounts", authorization: "Bearer cf-read-fixture" });
  // No process environment and no file in the container holds either token.
  const leaks = exec(a, ["sh", "-c", "(cat /proc/[0-9]*/environ | tr '\\0' '\\n'; grep -rhsa -e cf-read-fixture -e cf-write-fixture /run/agentmonitor /home/agent /workspace /tmp) 2>/dev/null | grep -c -e cf-read-fixture -e cf-write-fixture || true"]);
  assert.equal(leaks, "0");
});

spec("CLOUDFLARE-2", "an agent changes Cloudflare only while the user allows it on the session page", async () => {
  const channel = await gateway.omp(a.id);
  try {
    const write = () => agentCloudflare(channel, "POST", "/accounts/fixture/workers/scripts");
    const refused = await write();
    assert.equal(refused.status, 403);
    assert.match(refused.message ?? "", /allow them in the task's settings/);
    assert.ok(!cloudflareSeen.some((seen) => seen.method === "POST"), "a refused write reached Cloudflare");
    // The agent cannot allow its own writes through its socket.
    const allowSelf = `require("node:http").request({ socketPath: "/run/agentmonitor/am.sock", method: "POST", path: "/api/store/sessions/${a.id}/cloudflare-writes" }, (r) => { console.log(r.statusCode); r.resume(); }).end()`;
    assert.equal(exec(a, ["node", "-e", allowSelf]), "403");

    const { page } = await openChat(a);
    await page.getByRole("button", { name: "Workspace settings" }).click();
    const panel = page.getByRole("complementary", { name: "Workspace settings" }).getByRole("region", { name: "Cloudflare" });
    await panel.getByRole("button", { name: "Allow writes for 10 min" }).click();
    await panel.getByText(/^Writes allowed until/).waitFor();
    const until = (await card(a)).cloudflare?.writesUntil ?? 0;
    assert.ok(Math.abs(until - (Date.now() + 10 * 60_000)) < 30_000, "writes are allowed for 10 minutes");
    assert.equal((await write()).status, 200);
    assert.deepEqual(cloudflareSeen.at(-1), { method: "POST", path: "/client/v4/accounts/fixture/workers/scripts", authorization: "Bearer cf-write-fixture" });

    await panel.getByRole("button", { name: "Revoke" }).click();
    await panel.getByRole("button", { name: "Allow writes for 10 min" }).waitFor();
    assert.equal((await write()).status, 403);
  } finally {
    channel.close();
  }
});

spec("SESSION-13", "until a session's chat loads, its page says what it waits on, such as a starting container", async () => {
  execFileSync("podman", ["stop", "-t", "0", `am-${a.id}`]);
  assert.equal((await card(a)).turn, "stopped");
  const page = await sessionPage(a);
  const waiting = page.getByRole("status").filter({ hasText: /^(Starting the session's container…|Loading the chat…)$/ });
  await waiting.filter({ hasText: "Starting the session's container…" }).waitFor();
  await page.frameLocator("iframe.session-frame.current").getByRole("group", { name: /^Model: Scripted/ }).waitFor({ timeout: 60_000 });
  await waiting.waitFor({ state: "detached" });
});
