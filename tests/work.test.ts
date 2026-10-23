import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { z } from "zod";
import { DEPLOY_INSTRUCTION } from "../server/deploy.ts";
import type { Automation, Card, Project, Session, Task, TaskSummary, Work } from "../shared/api.ts";
import { FakeModel } from "./fake-model.ts";
import { buildApp, Gateway } from "./harness.ts";
import { spec } from "./spec.ts";

// A branch's work (CARD-3, CARD-6) and deploying it (DEPLOY-1, AUTO-16), against one gateway
// whose sessions run on the host. The fixture's origin is a bare repository standing in for
// GitHub: its remote reads as a GitHub URL, which git rewrites to the bare repository. `gh` is
// a script keeping its pull requests and Actions runs in a JSON file the tests also write.

const GITHUB = "https://github.com/fixture/fixture";

const gitHubState = z.object({
  prs: z.array(z.object({
    number: z.number(),
    title: z.string(),
    url: z.string(),
    state: z.enum(["OPEN", "MERGED", "CLOSED"]),
    headRefName: z.string(),
    headRefOid: z.string(),
    createdAt: z.string(),
  })),
  runs: z.array(z.object({ headSha: z.string(), name: z.string(), status: z.string(), conclusion: z.string(), url: z.string() })),
  /** A token that reads pull requests but not Actions. */
  actionsDenied: z.boolean(),
  /** gh cannot reach GitHub at all. */
  offline: z.boolean(),
});
type GitHubState = z.infer<typeof gitHubState>;

/** GitHub as gh shows it: pull requests and Actions runs from the state file; a merge pushes the branch onto origin's main. */
const fakeGh = (state: string) => `#!/usr/bin/env node
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
const save = () => fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(state));
const args = process.argv.slice(2);
const option = (name) => { const at = args.indexOf(name); return at === -1 ? undefined : args[at + 1]; };
const fields = (found) => found.map((item) => Object.fromEntries(option("--json").split(",").map((field) => [field, item[field]])));
const fail = (message) => { process.stderr.write(message + "\\n"); process.exit(1); };
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const command = args.slice(0, 2).join(" ");
if (state.offline) fail("error connecting to api.github.com");
if (command === "pr list") {
  process.stdout.write(JSON.stringify(fields(state.prs.filter((pr) => pr.headRefName === option("--head")).reverse())));
} else if (command === "run list") {
  if (state.actionsDenied) fail("HTTP 403: Resource not accessible by personal access token");
  process.stdout.write(JSON.stringify(fields(state.runs.filter((run) => run.headSha === option("--commit")))));
} else if (command === "pr create") {
  const number = state.prs.length + 1;
  const url = "${GITHUB}/pull/" + number;
  const headRefOid = git("rev-parse", "HEAD");
  state.prs.push({ number, title: option("--title"), url, state: "OPEN", headRefName: git("rev-parse", "--abbrev-ref", "HEAD"), headRefOid, createdAt: new Date().toISOString() });
  state.runs.push({ headSha: headRefOid, name: "test", status: "completed", conclusion: "success", url: "${GITHUB}/actions/runs/" + state.runs.length });
  save();
  console.log(url);
} else if (command === "pr checks") {
  console.log("test\\tpass");
} else if (command === "pr merge") {
  const pr = state.prs.find((candidate) => candidate.headRefName === git("rev-parse", "--abbrev-ref", "HEAD") && candidate.state === "OPEN");
  if (pr === undefined) fail("no open pull request for this branch");
  git("push", "-q", "origin", "HEAD:main");
  pr.state = "MERGED";
  save();
} else {
  fail("fake gh: " + args.join(" "));
}
`;

let scratch: string;
let origin: string;
let repo: string;
let ghState: string;
let fake: FakeModel;
let gateway: Gateway;
let project: Project;
let chrome: Browser | undefined;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function github(change: (state: GitHubState) => void): void {
  const state = gitHubState.parse(JSON.parse(readFileSync(ghState, "utf8")));
  change(state);
  writeFileSync(ghState, JSON.stringify(state));
}

/** A pull request from `branch` at commit `sha` as GitHub would have it, with Actions runs on `sha` named by their state. */
function pullRequest(branch: string, sha: string, state: GitHubState["prs"][number]["state"], checks: Record<string, "passing" | "failing" | "pending">): void {
  github((current) => {
    const number = current.prs.length + 1;
    current.prs.push({ number, title: `Fixture PR ${number}`, url: `${GITHUB}/pull/${number}`, state, headRefName: branch, headRefOid: sha, createdAt: new Date().toISOString() });
    for (const [name, check] of Object.entries(checks)) {
      current.runs.push({
        headSha: sha,
        name,
        status: check === "pending" ? "in_progress" : "completed",
        conclusion: check === "pending" ? "" : check === "passing" ? "success" : "failure",
        url: `${GITHUB}/actions/runs/${current.runs.length}`,
      });
    }
  });
}

before(async () => {
  await buildApp();
  scratch = mkdtempSync(join(tmpdir(), "am-work-"));
  origin = join(scratch, "origin.git");
  repo = join(scratch, "fixture");
  git(scratch, ["init", "-q", "--bare", "-b", "main", origin]);
  mkdirSync(repo);
  writeFileSync(join(repo, "AGENTS.md"), "# Fixture\n");
  for (const args of [
    ["init", "-q", "-b", "main"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"],
    // The remote reads as GitHub's, so commits link there; git fetches and pushes the bare repository.
    ["remote", "add", "origin", `${GITHUB}.git`], ["config", `url.${origin}.insteadOf`, `${GITHUB}.git`], ["push", "-q", "-u", "origin", "main"],
  ]) {
    git(repo, args);
  }
  const bin = join(scratch, "bin");
  mkdirSync(bin);
  ghState = join(scratch, "github.json");
  writeFileSync(ghState, JSON.stringify({ prs: [], runs: [], actionsDenied: false, offline: false } satisfies GitHubState));
  writeFileSync(join(bin, "gh"), fakeGh(ghState));
  chmodSync(join(bin, "gh"), 0o755);
  fake = await FakeModel.start();
  const agentDir = join(scratch, "omp-agent");
  mkdirSync(agentDir);
  fake.writeAgentDir(agentDir, "127.0.0.1");
  const home = join(scratch, "home");
  mkdirSync(home);
  writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Fixture User\n\temail = fixture@example.com\n");
  gateway = await Gateway.start({
    runtime: "podman",
    env: { HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}`, AGENTMONITOR_GH: join(bin, "gh"), AGENTMONITOR_OMP_AGENT_DIR: agentDir },
  });
  project = await gateway.data<Project>("POST", "/projects", { name: "fixture", repoPath: repo });
  await gateway.data("PATCH", `/projects/${project.id}`, { hostSessions: true });
}, { timeout: 60_000 });

after(async () => {
  await chrome?.close();
  await gateway?.stop();
  await fake?.stop();
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

async function task(title: string): Promise<Task> {
  return gateway.data<Task>("POST", `/projects/${project.id}/tasks`, { title, description: "" });
}

async function start(target: Task): Promise<Session> {
  return gateway.data<Session>("POST", `/tasks/${target.id}/sessions`, { runtime: "host", model: "fake/scripted" });
}

function worktree(session: Session): string {
  return join(gateway.stateDir, "sessions", session.id, "worktree");
}

function commit(session: Session, file: string, subject: string, body = ""): string {
  writeFileSync(join(worktree(session), file), `${subject}\nsecond line\n`);
  git(worktree(session), ["add", file]);
  git(worktree(session), ["commit", "-qm", subject, ...(body === "" ? [] : ["-m", body])]);
  return git(worktree(session), ["rev-parse", "HEAD"]);
}

/** Polls `read` until `test` holds: the gateway answers from git and from gh's briefly kept answers. */
async function until<T>(read: () => Promise<T>, test: (value: T) => boolean, what: string): Promise<T> {
  for (const deadline = Date.now() + 30_000; ;) {
    const value = await read();
    if (test(value)) return value;
    assert.ok(Date.now() < deadline, `never ${what}: ${JSON.stringify(value)}`);
  }
}

async function cardShowing(target: Session, test: (card: Card) => boolean, what: string): Promise<Card> {
  return until(async () => (await gateway.data<Card[]>("GET", `/projects/${project.id}/cards`)).find((card) => card.session.id === target.id), (card) => card !== undefined && test(card), what)
    .then((card) => card ?? assert.fail(what));
}

async function badge(target: Task): Promise<TaskSummary["badge"]> {
  const found = (await gateway.data<TaskSummary[]>("GET", `/projects/${project.id}/tasks`)).find((summary) => summary.task.id === target.id);
  return found?.badge ?? null;
}

async function openPage(hash: string): Promise<Page> {
  chrome ??= await chromium.launch();
  const page = await chrome.newPage();
  // The page polls its work every 5 s, and gh's answers are kept 10 s.
  page.setDefaultTimeout(30_000);
  await page.goto(`${gateway.url}/${hash}`);
  return page;
}

function originHas(subject: string): boolean {
  return git(origin, ["log", "main", "--format=%s"]).split("\n").includes(subject);
}

/** What the agent does when told to deploy (DEPLOY_INSTRUCTION), the way its instruction says. */
const DEPLOYS = "bash:git push -q -u origin HEAD && gh pr create --title 'Ship it' --body 'What changed and why' && gh pr checks --watch && gh pr merge --merge";

/** Each claim waits out gh's kept answers (10 s) and the page's polling (5 s) several times: longer than npm test's 30 s default. */
const WAITS = { timeout: 180_000 };

spec("CARD-3", "a task's Work section shows its branch's state, its commits with their descriptions, its pull requests with their checks, and the files it changed", async () => {
  const notes = await task("Patch notes");
  const page = await openPage(`#/t/${notes.id}`);
  const view = page.getByRole("region", { name: "Work" });
  const state = view.getByRole("status", { name: "Branch state" });
  await state.filter({ hasText: /^Nothing yet: the task's first session creates its branch\.$/ }).waitFor();

  const session = await start(notes);
  await state.filter({ hasText: /^Nothing yet\.$/ }).waitFor();
  writeFileSync(join(worktree(session), "draft.md"), "draft\n");
  await state.filter({ hasText: /^Uncommitted changes in the running session \(1 file\)\.$/ }).waitFor();
  assert.deepEqual(await view.locator(".uncommitted code").allTextContents(), ["draft.md"]);
  rmSync(join(worktree(session), "draft.md"));

  const sha = commit(session, "notes.md", "Write the patch notes", "Why: the JP release 4d2e needs them.\n\nSecond paragraph.");
  await state.filter({ hasText: /^1 commit not pushed\.$/ }).waitFor();
  const row = view.locator(".commit", { hasText: "Write the patch notes" });
  await row.locator(".unpushed-mark").waitFor();
  const link = row.getByRole("link", { name: sha.slice(0, 7) });
  assert.equal(await link.getAttribute("href"), `${GITHUB}/commit/${sha}`);
  // The description shows when the subject is opened.
  assert.equal(await row.locator(".commit-body").count(), 0);
  await row.getByRole("button", { name: "Write the patch notes" }).click();
  assert.equal(await row.locator(".commit-body").textContent(), "Why: the JP release 4d2e needs them.\n\nSecond paragraph.");

  git(worktree(session), ["push", "-q", "-u", "origin", "HEAD"]);
  await state.filter({ hasText: /^1 commit pushed\.$/ }).waitFor();
  await row.locator(".unpushed-mark").waitFor({ state: "detached" });
  const work = await gateway.data<Work>("GET", `/tasks/${notes.id}/changes`);
  assert.deepEqual(work.commits?.map(({ at: _at, ...shown }) => shown), [
    { sha, subject: "Write the patch notes", body: "Why: the JP release 4d2e needs them.\n\nSecond paragraph.", pushed: true, url: `${GITHUB}/commit/${sha}` },
  ]);

  // The files expand from their count.
  const files = view.getByRole("button", { name: "1 file changed, +2 −0" });
  assert.equal(await view.locator(".changed-files").count(), 0);
  await files.click();
  assert.deepEqual(await view.locator(".changed-files li").allTextContents(), ["A notes.md +2 −0"]);

  // A merged pull request reads as deployed; an open one shows its checks (its head's Actions runs), also in place of Deploy.
  const branch = String(session.branch);
  pullRequest(branch, git(repo, ["rev-parse", "main"]), "MERGED", { test: "passing" });
  pullRequest(branch, sha, "OPEN", { test: "passing", lint: "failing", e2e: "pending" });
  const merged = view.locator(".pull-request", { hasText: "PR #1" });
  const open = view.locator(".pull-request", { hasText: "PR #2" });
  await merged.locator(".pr-state", { hasText: "Deployed" }).waitFor();
  assert.equal(await merged.locator(".checks").textContent(), "Checks passing");
  assert.equal(await merged.getByRole("link", { name: "PR #1" }).getAttribute("href"), `${GITHUB}/pull/1`);
  await open.locator(".pr-state", { hasText: "Open" }).waitFor();
  assert.equal(await open.locator(".checks").textContent(), "Checks failing");
  assert.equal(await open.locator(".checks").getAttribute("href"), `${GITHUB}/actions/runs/2`, "the failing run");
  await view.getByRole("status").filter({ hasText: "Pull request #2 open, checks failing" }).waitFor();
  assert.equal(await view.getByRole("button", { name: "Deploy" }).count(), 0);

  // A token that cannot read Actions still shows the pull requests.
  github((current) => { current.actionsDenied = true; });
  await view.getByText("Checks unavailable").first().waitFor();
  assert.equal(await view.locator(".pull-request").count(), 2);
  // gh failing shows on the page, never as an error.
  github((current) => { current.offline = true; });
  await view.getByText("Pull requests unavailable.").waitFor();
  await state.filter({ hasText: /^1 commit pushed\.$/ }).waitFor();
  github((current) => { current.actionsDenied = false; current.offline = false; });
  await page.close();
}, WAITS);

spec("CARD-6", "a board card shows one badge for its work: not pushed before a pull request open before deployed", async () => {
  const fixes = await task("Client fixes");
  assert.equal(await badge(fixes), null);
  const session = await start(fixes);
  commit(session, "client.ts", "Fix the client");
  assert.equal(await badge(fixes), "unpushed");
  const page = await openPage("#/");
  const shown = page.getByRole("article", { name: "Client fixes" }).locator(".work-badge");
  await shown.filter({ hasText: /^Not pushed$/ }).waitFor();

  git(worktree(session), ["push", "-q", "-u", "origin", "HEAD"]);
  pullRequest(String(session.branch), git(worktree(session), ["rev-parse", "HEAD"]), "OPEN", { test: "pending" });
  await until(() => badge(fixes), (found) => found === "open", "a pull request open");
  await shown.filter({ hasText: /^PR open$/ }).waitFor();
  // A commit not pushed goes before the open pull request.
  commit(session, "client.ts", "Fix the client again");
  assert.equal(await badge(fixes), "unpushed");
  git(worktree(session), ["push", "-q"]);
  assert.equal(await badge(fixes), "open");

  github((current) => {
    for (const pr of current.prs) if (pr.headRefName === session.branch) pr.state = "MERGED";
  });
  await until(() => badge(fixes), (found) => found === "deployed", "deployed");
  await shown.filter({ hasText: /^Deployed$/ }).waitFor();
  assert.equal(await page.getByRole("article", { name: "Client fixes" }).locator(".work-badge").count(), 1);
  await page.close();
}, WAITS);

spec("DEPLOY-1", "Deploy sends the task's running session the fixed instruction, and the pull request its agent opens and merges shows as deployed", async () => {
  fake.when(DEPLOY_INSTRUCTION, DEPLOYS);
  const ship = await task("Ship notes");
  const session = await start(ship);
  commit(session, "ship.md", "Ship notes 8b1f");
  const page = await openPage(`#/t/${ship.id}`);
  const view = page.getByRole("region", { name: "Work" });
  await view.getByRole("button", { name: "Deploy" }).click();
  await view.getByRole("status").filter({ hasText: "Sent to the agent" }).waitFor();

  const card = await cardShowing(session, (shown) => shown.lastUserMessage === DEPLOY_INSTRUCTION && shown.turn === "done", "the instruction answered");
  assert.match(String(card.lastReply), /^answered: https:\/\/github\.com\/fixture\/fixture\/pull\/\d+$/, "the agent opened the pull request");
  await view.locator(".pull-request .pr-state", { hasText: "Deployed" }).waitFor();
  assert.ok(originHas("Ship notes 8b1f"), "merged into origin's main");
  await view.getByRole("button", { name: "Deploy" }).waitFor({ state: "detached" });
  await page.close();
}, WAITS);

spec("DEPLOY-1", "Deploy on a task without a running session starts one on the fixed instruction, which its context also gives for a person's \"deploy\"", async () => {
  fake.when(DEPLOY_INSTRUCTION, DEPLOYS);
  const ship = await task("Ship docs");
  const first = await start(ship);
  commit(first, "docs.md", "Ship docs 2c7a");
  await gateway.data("POST", `/sessions/${first.id}/end`, {});
  const work = await gateway.data<Work>("GET", `/tasks/${ship.id}/changes`);
  assert.equal(work.deployable, true);

  const told = await gateway.data<Session>("POST", `/tasks/${ship.id}/deploy`);
  assert.notEqual(told.id, first.id);
  const card = await cardShowing(told, (shown) => shown.lastUserMessage === DEPLOY_INSTRUCTION, "the instruction as its first prompt");
  assert.equal(card.session.taskId, ship.id);
  const channel = await gateway.omp(told.id);
  const { systemPrompt } = await channel.request("system_prompt");
  channel.close();
  assert.ok(String(systemPrompt).includes(`## Deploying\n\nWhen a person tells you to deploy, do what Deploy on the task's page sends you: ${DEPLOY_INSTRUCTION}`));

  const deployed = await until(() => gateway.data<Work>("GET", `/tasks/${ship.id}/changes`), (found) => found.pullRequests?.some((pr) => pr.state === "merged") === true, "deployed");
  assert.equal(deployed.deployable, false);
  assert.ok(originHas("Ship docs 2c7a"), "merged into origin's main");
}, WAITS);

spec("AUTO-16", "a run waiting for review shows its work with Deploy, which has its agent deploy; every run's work opens from its row", async () => {
  fake.when(DEPLOY_INSTRUCTION, `${DEPLOYS} && am run end finished`);
  const audit = await gateway.data<Automation>("POST", `/projects/${project.id}/automations`, {
    name: "Weekly audit",
    model: "fake/scripted",
    endMode: "review",
    instructions: "bash:echo 'audit 5f1b' > AUDIT.md && git add AUDIT.md && git commit -qm 'Audit 5f1b' -m 'Found two stale links.' && git push -q -u origin HEAD && am run end review",
  });
  const run = await gateway.data<Session>("POST", `/automations/${audit.id}/runs`, { runtime: "host" });
  await cardShowing(run, (card) => card.turn === "blocked" && card.session.run?.outcome === "review", "the run waiting for review");
  const work = await gateway.data<Work>("GET", `/runs/${run.id}/changes`);
  assert.equal(work.branch, run.branch);
  assert.deepEqual(work.commits?.map((shown) => [shown.subject, shown.body, shown.pushed]), [["Audit 5f1b", "Found two stale links.", true]]);
  assert.equal(work.deployable, true);

  const page = await openPage(`#/a/${audit.id}`);
  const view = page.getByRole("region", { name: "Waiting for review" }).getByRole("region", { name: "Work" });
  await view.getByRole("status", { name: "Branch state" }).filter({ hasText: /^1 commit pushed\.$/ }).waitFor();
  await view.getByRole("button", { name: "Audit 5f1b" }).click();
  await view.getByText("Found two stale links.").waitFor();
  await view.getByRole("button", { name: "Deploy" }).click();

  await until(() => gateway.data<{ session: Session }>("GET", `/sessions/${run.id}`), ({ session }) => session.run?.outcome === "finished", "the run finished");
  assert.ok(originHas("Audit 5f1b"), "what the person reviewed is deployed");
  const done = await gateway.data<Work>("GET", `/runs/${run.id}/changes`);
  assert.equal(done.deployable, false);

  // The run's row opens its work.
  const reloaded = await openPage(`#/a/${audit.id}`);
  await reloaded.getByRole("button", { name: `Work of run ${run.id.slice(0, 8)}` }).click();
  await reloaded.getByRole("region", { name: "Runs and firings" }).getByRole("region", { name: "Work" }).locator(".pull-request .pr-state", { hasText: "Deployed" }).waitFor();
  await page.close();
  await reloaded.close();
}, WAITS);
