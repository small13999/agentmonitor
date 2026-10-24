import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before } from "node:test";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { FakeModel } from "./fake-model.ts";
import { buildApp, buildTestImage, Gateway, rgb, type OmpChannel } from "./harness.ts";
import type { HistoryEntry, Work } from "../shared/api.ts";
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
  overlaps: Array<{ sessionId: string; name: string; files: string[] }>;
  cloudflare: { canWrite: boolean; writesUntil: number | null } | null;
}

const REPO_RULE = "Fixture rule 7f3a: run the fixture linter before committing.";
const PULL_REQUEST = { number: 7, title: "Patch notes JP", url: "https://github.com/example/fixture/pull/7" };
/** What a's task says before its first session starts (TASK-6). */
const TASK_A = {
  description: "Translate the JP patch notes 9c1e.",
  status: "Done: glossary 4b7d\n",
  comment: "Ask Jogi before publishing 2e8f.",
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
  await buildTestImage();
  await buildApp();
  scratch = mkdtempSync(join(tmpdir(), "am-fixture-"));
  repo = join(scratch, "fixture");
  mkdirSync(repo);
  writeFileSync(join(repo, "AGENTS.md"), `# Fixture\n\n${REPO_RULE}\n`);
  for (const args of [["init", "-q", "-b", "main"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]]) {
    execFileSync("git", args, { cwd: repo });
  }
  // omp's only model is the scripted fake; GitHub is a fake gh that lists one open PR.
  fake = await FakeModel.start();
  const agentDir = join(scratch, "omp-agent");
  mkdirSync(agentDir);
  fake.writeAgentDir(agentDir);
  const gh = join(scratch, "gh");
  // Each listing says the pull request was opened now, so it is recorded when GitHub is first asked (TASK-14); its head has no Actions runs.
  const listing = JSON.stringify([{ ...PULL_REQUEST, state: "OPEN", createdAt: "OPENED", headRefOid: "0000000000000000000000000000000000000000" }]);
  writeFileSync(gh, `#!/bin/sh\nif [ "$1" = run ]; then echo '[]'; exit 0; fi\necho '${listing}' | sed "s/OPENED/$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)/"\n`);
  chmodSync(gh, 0o755);

  // The user's git credentials, which the gateway keeps; Cloudflare's API, for the project's tokens.
  home = join(scratch, "home");
  mkdirSync(join(home, ".ssh"), { recursive: true, mode: 0o700 });
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "fixture", "-f", join(home, ".ssh", "id_ed25519")]);
  writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Fixture User\n\temail = fixture@example.com\n");
  mkdirSync(join(home, ".config", "gh"), { recursive: true });
  writeFileSync(join(home, ".config", "gh", "hosts.yml"), "github.com:\n    user: fixture-user\n    oauth_token: gho_fixture\n    git_protocol: ssh\n");
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
      AGENTMONITOR_CLOUDFLARE_API: `http://127.0.0.1:${address.port}`,
    },
  });
  projectId = (await gateway.data<{ id: string }>("POST", "/projects", { name: "fixture", repoPath: repo })).id;
  // CLOUDFLARE-3: the project's tokens, kept in its store.
  await gateway.data("PUT", `/projects/${projectId}/cloudflare`, { read: "cf-read-fixture", write: "cf-write-fixture" });
  const taskA = await gateway.data<Task>("POST", `/projects/${projectId}/tasks`, { title: "Patch Notes JP", description: TASK_A.description });
  await gateway.data("PUT", `/tasks/${taskA.id}/status`, { status: TASK_A.status, baseRevision: 0 });
  await gateway.data("POST", `/tasks/${taskA.id}/comments`, { body: TASK_A.comment });
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
    assert.ok(Date.now() < deadline, `the card of ${target.name} never showed ${what}: ${JSON.stringify(shown)}`);
  }
}

/** Sends a prompt into the session's chat as a page does, and waits until its turn reaches `turn`. */
async function prompt(target: Session, channel: OmpChannel, text: string, turn: string): Promise<void> {
  const reached = channel.event((event) => event.type === "turn" && event.turn === turn);
  const chat = await gateway.chat(target.id);
  try {
    await chat.rpc({ type: "prompt", message: text });
  } finally {
    chat.close();
  }
  await reached;
}

let chrome: Browser | undefined;
const openPages = new Set<Page>();

async function closePages(): Promise<void> {
  await Promise.all([...openPages].map((page) => page.close()));
  openPages.clear();
}

afterEach(closePages);

/** A fresh page on `hash`; earlier pages close first. All claims share one browser. */
async function freshPage(hash: string): Promise<Page> {
  await closePages();
  chrome ??= await chromium.launch();
  const page = await chrome.newPage();
  openPages.add(page);
  page.setDefaultTimeout(15_000);
  await page.goto(`${gateway.url}/${hash}`);
  return page;
}

/** A fresh page on one of the task's tabs (UI-2); the chat by default. */
async function sessionPage(target: Session, tab: "page" | "chat" | "settings" = "chat"): Promise<Page> {
  return freshPage(`#/t/${target.taskId}${tab === "page" ? "" : `/${tab}`}`);
}

/** A fresh page on the board; no chat loads. */
async function boardPage(): Promise<Page> {
  const page = await freshPage("#/");
  await page.getByRole("region", { name: "Board" }).waitFor();
  return page;
}

/** A fresh session page, once its chat shows the session's chat from omp's state (its model). */
async function openChat(target: Session, timeout = 15_000): Promise<Locator> {
  const page = await sessionPage(target);
  const chat = page.getByRole("region", { name: "Chat" });
  await chat.getByRole("combobox", { name: "Model" }).locator("option:checked").filter({ hasText: "Scripted" }).waitFor({ state: "attached", timeout });
  return chat;
}

/** A user message and a reply in the chat's conversation, by their text. */
function said(chat: Locator, text: string): Locator {
  return chat.getByRole("log", { name: "Conversation" }).getByRole("article", { name: "Your message" }).filter({ hasText: text });
}
function replied(chat: Locator, text: string): Locator {
  return chat.getByRole("log", { name: "Conversation" }).getByRole("article", { name: "Reply" }).filter({ hasText: text });
}

spec("SESSION-5", "a session belongs to one task or one automation and works in a worktree of its branch on one machine", async () => {
  const { task } = await taskOf(a);
  assert.equal(task.title, "Patch Notes JP");
  assert.match(a.branch, /^am\/patch-notes-jp-[0-9a-f]{4}$/);
  assert.equal(task.branch, a.branch);
  assert.ok(a.machine.length > 0);

  assert.equal(exec(a, ["git", "-C", "/workspace/fixture", "branch", "--show-current"]), a.branch);
  assert.equal(exec(a, ["cat", "/workspace/fixture/AGENTS.md"]), `# Fixture\n\n${REPO_RULE}`);
  assert.match(exec(a, ["am", "whoami"]), new RegExp(`^task {4}Patch Notes JP \\(${task.id}, in_progress\\)$`, "m"));

  // AUTO-9: "run now" starts a session of the automation, of no task, on a branch of its own
  // from the default branch; the automation's instructions end its chat's first prompt (AUTO-13).
  const automation = await gateway.data<{ id: string }>("POST", `/projects/${projectId}/automations`, {
    name: "Patch review",
    instructions: "say:reviewed-3f9a",
    model: "fake/scripted",
  });
  const run = await gateway.data<Session & { automationId: string | null }>("POST", `/automations/${automation.id}/runs`, {});
  try {
    assert.equal(run.taskId, null);
    assert.equal(run.automationId, automation.id);
    assert.equal(run.branch, `am/patch-review-${run.id.slice(0, 8)}`);
    assert.equal(exec(run, ["git", "-C", "/workspace/fixture", "branch", "--show-current"]), run.branch);
    assert.equal(exec(run, ["git", "-C", "/workspace/fixture", "rev-parse", "HEAD"]), execFileSync("git", ["rev-parse", "main"], { cwd: repo, encoding: "utf8" }).trim());
    await cardShowing(run, (shown) => shown.lastUserMessage?.endsWith("\nsay:reviewed-3f9a") === true && shown.lastReply === "reviewed-3f9a", "its instructions answered");
    assert.match(exec(run, ["am", "whoami"]), new RegExp(`^automation Patch review \\(${automation.id}\\), run ${run.id.slice(0, 8)}$`, "m"));
    const taskless = spawnSync("podman", ["exec", `am-${run.id}`, "am", "task", "show"], { encoding: "utf8" });
    assert.equal(taskless.status, 1);
    assert.match(taskless.stderr, /belongs to no task: name one with --task ID/);
  } finally {
    await gateway.data("POST", `/sessions/${run.id}/end`);
  }
});

spec("SESSION-4", "a chat starts with the workflow context and the repository's AGENTS.md", async () => {
  const { systemPrompt } = await channelA.request("system_prompt");
  assert.equal(typeof systemPrompt, "string");
  assert.ok(String(systemPrompt).includes(REPO_RULE), "repository AGENTS.md is project context");
  assert.ok(String(systemPrompt).includes("# Agent Monitor session"), "workflow AGENTS.md is user context");
  assert.ok(String(systemPrompt).includes("am topic link NAME"), "workflow RULES.md is a sticky rule");
});

spec("TASK-6", "a session's first chat starts with its task's title, description, status, and comments", async () => {
  const { systemPrompt } = await channelA.request("system_prompt");
  for (const part of ['"Patch Notes JP"', TASK_A.description, TASK_A.status.trim(), `> ${TASK_A.comment}`]) {
    assert.ok(String(systemPrompt).includes(part), `the context holds ${part}`);
  }
});

spec("FOLDER-3", "a container session's agent finds its task's folder as a directory; what it writes there shows on the page, and the reverse", async () => {
  const { systemPrompt } = await channelA.request("system_prompt");
  const folder = /The task's folder is the directory `([^`]+)`/.exec(String(systemPrompt))?.[1];
  assert.equal(folder, "/task-folder", "the task context names the folder");

  // Written in the agent's container as its tools would; a bash turn in a's chat would show in the later chat claims.
  exec(a, ["sh", "-c", `mkdir -p ${folder}/shots && echo 'agent wrote 5b2c' > ${folder}/shots/report.txt`]);
  const page = await sessionPage(a, "page");
  const files = page.getByRole("region", { name: "Folder" });
  await files.getByRole("row").filter({ hasText: "shots/report.txt" }).getByText("Agent").waitFor();
  const history = await gateway.data<Array<{ kind: string; path?: string; actor: unknown }>>("GET", `/tasks/${a.taskId}/history`);
  assert.deepEqual(history.filter((entry) => entry.kind === "file").map((entry) => [entry.path, entry.actor]), [["shots/report.txt", { kind: "agent", sessionId: a.id }]]);

  // A file a person adds on the page is in the agent's directory.
  await files.locator("input[type=file]").setInputFiles({ name: "brief.txt", mimeType: "text/plain", buffer: Buffer.from("from the page 8e1d\n") });
  await files.getByRole("row").filter({ hasText: "brief.txt" }).waitFor();
  assert.equal(exec(a, ["cat", `${folder}/brief.txt`]), "from the page 8e1d");
  // Neither is in the worktree, so neither is in git.
  assert.equal(exec(a, ["git", "-C", "/workspace/fixture", "status", "--porcelain"]), "");
});

spec("COMMENT-3", "comments never reach a running session's chat; its agent reads them when its session starts and with am comments", async () => {
  const before = String((await channelA.request("system_prompt")).systemPrompt);
  const posted = "Hold the release until Friday 5d2a.";
  await gateway.data("POST", `/tasks/${a.taskId}/comments`, { body: posted });
  assert.equal(String((await channelA.request("system_prompt")).systemPrompt), before, "the running chat's context stays as it started");
  assert.ok(!chats(a).some((path) => readFileSync(path, "utf8").includes(posted)), "no chat of the session got the comment");
  const asked = exec(a, ["am", "comments"]);
  assert.ok(asked.includes(TASK_A.comment) && asked.includes(posted), `am comments lists both:\n${asked}`);
});

spec("CARD-3", "a container session's task page shows its branch's work: uncommitted files, commits not pushed, files changed, and its pull request", async () => {
  exec(a, ["sh", "-c", [
    "cd /workspace/fixture",
    "echo note > notes.txt",
    "echo more >> AGENTS.md",
    "git -c user.name=a -c user.email=a@a commit -qam 'Translate patch notes'",
    "echo draft > draft.md",
  ].join(" && ")]);
  const work = await gateway.data<Work>("GET", `/tasks/${a.taskId}/changes`);
  assert.equal(work.branch, a.branch);
  assert.equal(work.state, "uncommitted");
  assert.deepEqual(work.commits?.map((commit) => [commit.subject, commit.pushed]), [["Translate patch notes", false]]);
  assert.deepEqual(work.files, [{ path: "AGENTS.md", status: "modified", added: 1, deleted: 0 }]);
  assert.deepEqual(work.uncommitted?.sort(), ["draft.md", "notes.txt"]);
  assert.deepEqual(work.pullRequests, [{ ...PULL_REQUEST, state: "open", checks: [] }]);

  // The task's page shows it.
  const page = await sessionPage(a, "page");
  const view = page.getByRole("region", { name: "Work" });
  await view.locator(".commit", { hasText: "Translate patch notes" }).waitFor();
  assert.deepEqual((await view.locator(".uncommitted code").allTextContents()).sort(), ["draft.md", "notes.txt"]);
  await view.getByRole("link", { name: "PR #7" }).waitFor();
  await view.getByRole("button", { name: /^1 file changed/ }).click();
  await view.locator(".changed-files li", { hasText: "AGENTS.md" }).waitFor();
});

spec("TASK-14", "a task's history lists the pull requests of its branch, which no one in the store did", async () => {
  const history = await gateway.data<HistoryEntry[]>("GET", `/tasks/${a.taskId}/history`);
  const prs = history.filter((entry) => entry.kind === "pull_request");
  assert.deepEqual(prs.map(({ at: _at, ...entry }) => entry), [{ kind: "pull_request", ...PULL_REQUEST, actor: null }]);
  assert.ok(history.every((entry, index) => index === 0 || entry.at >= history[index - 1].at), "in time order");
  assert.ok(prs[0].at > history[0].at, "opened after the task was created");
  const page = await sessionPage(a, "page");
  const entry = page.getByRole("region", { name: "History" }).locator("li", { hasText: "pull request #7 Patch notes JP opened" });
  await entry.waitFor();
  assert.equal(await entry.locator(".actor-name").textContent(), "GitHub");
  assert.equal(await entry.getByRole("link", { name: "#7" }).getAttribute("href"), PULL_REQUEST.url);
});

let b: Session;

spec("CARD-4", "a task's Work section and its card name the other running tasks that changed the same files", async () => {
  b = await session("Client fixes");
  const worktreeB = join(gateway.stateDir, "sessions", b.id, "worktree");
  writeFileSync(join(worktreeB, "AGENTS.md"), "# Fixture\n\nrewritten\n");
  writeFileSync(join(worktreeB, "client.ts"), "export {};\n");

  const shownA = await card(a);
  const shownB = await card(b);
  assert.deepEqual(shownA.overlaps, [{ sessionId: b.id, name: "Client fixes", files: ["AGENTS.md"] }]);
  assert.deepEqual(shownB.overlaps, [{ sessionId: a.id, name: "Patch Notes JP", files: ["AGENTS.md"] }]);
  const workA = await gateway.data<Work>("GET", `/tasks/${a.taskId}/changes`);
  const workB = await gateway.data<Work>("GET", `/tasks/${b.taskId}/changes`);
  assert.deepEqual(workA.overlaps, [{ taskId: b.taskId, title: "Client fixes", files: ["AGENTS.md"] }]);
  assert.deepEqual(workB.overlaps, [{ taskId: a.taskId, title: "Patch Notes JP", files: ["AGENTS.md"] }]);
  const page = await freshPage(`#/t/${a.taskId}`);
  const overlap = page.getByRole("region", { name: "Work" }).locator(".overlap", { hasText: "Client fixes: AGENTS.md" });
  await overlap.waitFor();
  assert.equal(await overlap.getByRole("link", { name: "Client fixes" }).getAttribute("href"), `#/t/${b.taskId}`);

  const board = await boardPage();
  const mark = board.getByRole("article", { name: "Patch Notes JP" }).locator(".overlap-mark");
  await mark.waitFor();
  assert.equal(await mark.getAttribute("title"), "Same files changed in Client fixes (AGENTS.md)");
});

spec("BOARD-2", "tasks waiting on you sort first in their column, and the header counts them", async () => {
  await prompt(a, channelA, "say:hello", "done");
  const channelB = await gateway.omp(b.id);
  try {
    await prompt(b, channelB, "ask:Proceed?", "blocked");
  } finally {
    channelB.close();
  }
  // b waits on you; a's turn is done. Both tasks are in progress; a was created first.
  const page = await boardPage();
  const column = page.getByRole("region", { name: "In progress" });
  const waiting = page.locator(".app-header .waiting summary");
  await column.locator(".card-blocked").waitFor();
  assert.deepEqual(await column.locator(".card-link").allTextContents(), ["Client fixes", "Patch Notes JP"]);
  assert.equal(await waiting.textContent(), "1 waiting on you");

  // A task assigned to someone else waits on them, not on you.
  const jogi = await gateway.data<{ id: string }>("POST", "/people", { name: "Jogi", email: "jogi@example.com" });
  await gateway.data("PATCH", `/tasks/${b.taskId}`, { assigneeId: jogi.id });
  await waiting.waitFor({ state: "detached" });
  assert.deepEqual(await column.locator(".card-link").allTextContents(), ["Patch Notes JP", "Client fixes"]);
  await gateway.data("PATCH", `/tasks/${b.taskId}`, { assigneeId: null });
  await waiting.waitFor();
});

spec("UI-5", "the header counts the tasks waiting on you, on every page, and links to them", async () => {
  // BOARD-2 left b waiting on you.
  const page = await boardPage();
  const header = page.locator(".app-header");
  for (const hash of ["#/", `#/t/${a.taskId}`, "#/t", "#/all"]) {
    await page.evaluate((target) => { window.location.hash = target; }, hash);
    assert.equal(await header.locator(".waiting summary").textContent(), "1 waiting on you", `on ${hash}`);
  }
  await header.locator(".waiting summary").click();
  const links = header.getByRole("navigation", { name: "Waiting on you" }).getByRole("link");
  assert.deepEqual(await links.allTextContents(), ["Client fixes"]);
  await links.first().click();
  await page.waitForURL(new RegExp(`#/t/${b.taskId}$`));
  assert.equal(await page.getByRole("navigation", { name: "Tasks" }).getByRole("link", { name: /Client fixes/ }).getAttribute("aria-current"), "page");
});

spec("BOARD-1", "the board shows open, in-progress, and in-review tasks, each with its topics, assignee, and session light and machine", async () => {
  const release = await gateway.data<{ id: string; color: string }>("POST", `/projects/${projectId}/topics`, { name: "Release" });
  await gateway.data("PUT", `/tasks/${a.taskId}/topics/${release.id}`);
  const { person: owner } = await gateway.data<{ person: { id: string; name: string; color: string } }>("GET", "/me");
  await gateway.data("PATCH", `/tasks/${a.taskId}`, { assigneeId: owner.id });
  await gateway.data("POST", `/projects/${projectId}/tasks`, { title: "Leaderboard filters" });
  const page = await boardPage();
  const board = page.getByRole("region", { name: "Board" });
  await board.getByRole("article", { name: "Leaderboard filters" }).getByText("No session").waitFor();
  assert.deepEqual(await board.locator(".column h2").allTextContents(), ["Open 1", "In progress 2", "In review 0"]);

  const cardA = board.getByRole("article", { name: "Patch Notes JP" });
  const topic = cardA.getByRole("button", { name: "Release" });
  await topic.waitFor();
  assert.equal(await topic.evaluate((element) => getComputedStyle(element).color), rgb(release.color));
  const avatar = cardA.getByRole("img", { name: owner.name });
  await avatar.waitFor();
  assert.equal(await avatar.evaluate((element) => getComputedStyle(element).backgroundColor), rgb(owner.color));
  await cardA.getByLabel("Idle").waitFor();
  assert.equal(await cardA.locator(".machine").textContent(), a.machine);
  // No messages, no git: what the session said and changed is on its task's page.
  assert.equal(await cardA.getByText("say:hello").count(), 0);
  assert.equal(await cardA.getByText(/uncommitted|unpushed|PR #/).count(), 0);
  await cardA.click();
  await page.waitForURL(new RegExp(`#/t/${a.taskId}$`));
});

spec("CHAT-1", "a container session's page draws its chat from omp's own events: omp runs in RPC mode in the container, with no other chat program", async () => {
  // BOARD-2 sent say:hello.
  const chat = await openChat(a);
  await said(chat, "say:hello").waitFor();
  await replied(chat, "hello").waitFor();
  const commands = exec(a, ["sh", "-c", "for process in /proc/[0-9]*; do tr '\\0' ' ' < $process/cmdline; echo; done 2>/dev/null"]);
  assert.match(commands, /\bomp\b.* --mode rpc-ui\b/);
  assert.doesNotMatch(commands, /\btern\b/);
});

spec("CARD-1", "a task's card and page show its running session as waiting on you, working, idle, or stopped; working pulses", async () => {
  const pulse = (light: Element) => getComputedStyle(light).animationName;
  const onBoard = async (title: string, label: string) => {
    const page = await boardPage();
    const light = page.getByRole("article", { name: title }).locator(".card-session").getByLabel(label, { exact: true });
    await light.waitFor();
    return light;
  };
  const onPage = async (target: Session, text: string) => {
    const page = await freshPage(`#/t/${target.taskId}`);
    const state = page.getByRole("status", { name: "Session state" });
    await state.filter({ hasText: text }).waitFor();
    return state.locator(".light");
  };
  assert.equal((await card(b)).turn, "blocked");
  await onBoard("Client fixes", "Waiting on you");
  await onPage(b, "Waiting on you");

  await prompt(a, channelA, "hold:later", "working");
  assert.equal((await card(a)).turn, "working");
  assert.equal(await (await onBoard("Patch Notes JP", "Working")).evaluate(pulse), "pulse");
  assert.notEqual(await (await onPage(a, "Working")).evaluate(pulse), "none", "working pulses");
  const done = channelA.event((event) => event.type === "turn" && event.turn === "done");
  await fake.holding();
  fake.release();
  await done;
  assert.equal((await card(a)).turn, "done");
  assert.equal(await (await onBoard("Patch Notes JP", "Idle")).evaluate(pulse), "none");
  assert.equal(await (await onPage(a, "Idle")).evaluate(pulse), "none");

  execFileSync("podman", ["stop", "-t", "0", `am-${a.id}`]);
  assert.equal((await card(a)).turn, "stopped");
  await onBoard("Patch Notes JP", "Stopped");
  await onPage(a, "Stopped");
});

spec("SESSION-10", "opening a session whose container stopped starts it again on its last chat", async () => {
  // CARD-1 stopped a's container after its last turn, "hold:later".
  const chat = await openChat(a, 60_000);
  await replied(chat, "later").waitFor();
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

  // A new chat with the same agent, as the chat's New chat starts it.
  const chat = await gateway.chat(a.id);
  try {
    await chat.rpc({ type: "new_session" });
    await chat.rpc({ type: "prompt", message: "say:newchat" });
  } finally {
    chat.close();
  }

  const shown = await cardShowing(a, (candidate) => candidate.lastReply === "newchat", "the new chat's reply");
  assert.equal(shown.lastUserMessage, "say:newchat");
  assert.equal(chats(a).length, before + 1);
  // The new chat's agent is still on a's task, with its topics (BOARD-1 linked Release).
  assert.match(exec(a, ["am", "task", "show"]), /^task Patch Notes JP .*\n(.*\n)*topics Release, Patch notes$/m);
  // CARD-3's commit and uncommitted files are still in the worktree.
  assert.equal(exec(a, ["git", "-C", "/workspace/fixture", "log", "-1", "--format=%s"]), "Translate patch notes");
  assert.deepEqual(shown.git?.uncommitted.sort(), ["draft.md", "notes.txt"]);
  await replied(await openChat(a), "newchat").waitFor();
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

  const page = await sessionPage(b, "settings");
  const settings = page.getByRole("region", { name: "Settings" });
  await settings.getByRole("tab", { name: "End session" }).click();
  await settings.getByRole("region", { name: "End session" }).getByRole("button", { name: "End session" }).click();
  await settings.getByRole("status").filter({ hasText: "Session ended. 2 uncommitted files were kept for the task's next session." }).waitFor();
  // Without a session, the task's chat tab offers to start one.
  await page.getByRole("tab", { name: "Chat" }).click();
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

  const page = await sessionPage(b2, "page");
  const finish = page.getByRole("region", { name: "Finish task" });
  await finish.getByRole("button", { name: "Mark done" }).click();
  await finish.getByText("No remote has these commits; finishing deletes them with the branch:").waitFor();
  assert.deepEqual(await finish.locator(".unpushed code").allTextContents(), [unpushed]);
  assert.equal((await taskOf(b2)).task.state, "in_progress", "the refused finish changed nothing");

  await finish.getByRole("button", { name: "Mark done and delete them" }).click();
  await page.getByRole("region", { name: "State" }).getByText("Done", { exact: true }).waitFor();
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

    const page = await sessionPage(a, "settings");
    const settings = page.getByRole("region", { name: "Settings" });
    await settings.getByRole("tab", { name: "Cloudflare" }).click();
    const panel = settings.getByRole("region", { name: "Cloudflare" });
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
  const waiting = page.getByRole("status").filter({ hasText: /^(Starting the session's container…|Connecting to the agent…)$/ });
  await waiting.filter({ hasText: "Starting the session's container…" }).waitFor();
  await page.getByRole("region", { name: "Chat" }).getByRole("combobox", { name: "Model" }).locator("option:checked").filter({ hasText: "Scripted" }).waitFor({ state: "attached", timeout: 60_000 });
  await waiting.waitFor({ state: "detached" });
});
