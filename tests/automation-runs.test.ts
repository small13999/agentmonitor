import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before } from "node:test";
import { chromium, type Browser } from "playwright";
import { FakeModel } from "./fake-model.ts";
import { buildApp, Gateway } from "./harness.ts";
import { spec } from "./spec.ts";

// What a run does from its first prompt to its end (AUTO-10 to AUTO-14), against one gateway
// whose runs are host sessions. The fixture's origin is a bare repository standing in for
// GitHub, with a `gh` whose merge pushes the pull request's branch onto main; the gateway's
// clock stands at the real time it started at until a test moves it (the harness's setClock). The claims run in order.
interface Run { outcome: string | null; reason: string | null; endedBy: { kind: string } | null }
interface Session { id: string; name: string; taskId: string | null; automationId: string | null; branch: string | null; endedAt: number | null; run: Run | null }
interface Automation { id: string; name: string }
interface Project { id: string }
interface Card { session: Session; turn: string; lastUserMessage: string | null; lastReply: string | null }
interface FolderFile { path: string }
interface TaskDetail { task: { id: string; title: string; branch: string | null } }

/** GitHub as the fixture's runs reach it: a pull request is merged by pushing its branch onto origin's main. */
const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "pr create") echo "https://github.com/fixture/fixture/pull/1" ;;
  "pr checks") echo "all checks passed" ;;
  "pr merge") git push -q origin HEAD:main ;;
  "pr list") echo "[]" ;;
  *) echo "fake gh: $*" >&2; exit 1 ;;
esac
`;
/** The run's own 8 characters, as its agent's shell finds them, naming its outputs `runs/<run>/`. */
const OUTPUTS = "runs/$(echo $AGENTMONITOR_SESSION | cut -c1-8)";
const MEMORY = "Last digest 2b8e covered the beta release.";

let scratch: string;
let origin: string;
let repo: string;
let fake: FakeModel;
let gateway: Gateway;
let project: Project;
let chrome: Browser | undefined;
/** Runs the later claims go on from. */
let finished: Session;
let failed: Session;
let reviewed: Session;
let fromRun: Session;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

before(async () => {
  await buildApp();
  scratch = mkdtempSync(join(tmpdir(), "am-runs-"));
  origin = join(scratch, "origin.git");
  repo = join(scratch, "fixture");
  git(scratch, ["init", "-q", "--bare", "-b", "main", origin]);
  mkdirSync(repo);
  writeFileSync(join(repo, "AGENTS.md"), "# Fixture\n");
  for (const args of [["init", "-q", "-b", "main"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], ["remote", "add", "origin", origin], ["push", "-q", "-u", "origin", "main"]]) {
    git(repo, args);
  }
  const bin = join(scratch, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), FAKE_GH);
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
    env: {
      HOME: home,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      AGENTMONITOR_GH: join(bin, "gh"),
      AGENTMONITOR_OMP_AGENT_DIR: agentDir,
    },
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

async function automation(name: string, fields: Record<string, unknown>): Promise<Automation> {
  return gateway.data<Automation>("POST", `/projects/${project.id}/automations`, { name, model: "fake/scripted", ...fields });
}

async function runNow(target: Automation): Promise<Session> {
  return gateway.data<Session>("POST", `/automations/${target.id}/runs`, { runtime: "host" });
}

async function session(id: string): Promise<Session> {
  return (await gateway.data<{ session: Session }>("GET", `/sessions/${id}`)).session;
}

function runDir(target: Session): string {
  return join(gateway.stateDir, "sessions", target.id, "run");
}

/** The session once it has ended: its run directory goes last when a session ends. */
async function ended(target: Session): Promise<Session> {
  const path = runDir(target);
  const { promise, resolve } = Promise.withResolvers<void>();
  const watcher = watch(dirname(path), () => {
    if (!existsSync(path)) resolve();
  });
  if (!existsSync(path)) resolve();
  await promise;
  watcher.close();
  return session(target.id);
}

async function cardShowing(target: Session, test: (card: Card) => boolean, what: string): Promise<Card> {
  for (;;) {
    const found = (await gateway.data<Card[]>("GET", `/projects/${project.id}/cards`)).find((candidate) => candidate.session.id === target.id);
    assert.ok(found, `${target.name} has no card while waiting for ${what}`);
    if (test(found)) return found;
  }
}

async function folder(target: Automation): Promise<string[]> {
  return (await gateway.data<FolderFile[]>("GET", `/automations/${target.id}/folder`)).map((file) => file.path);
}

function short(target: Session): string {
  return target.id.slice(0, 8);
}

function originHas(subject: string): boolean {
  return git(origin, ["log", "main", "--format=%s"]).split("\n").includes(subject);
}

let digest: Automation;
let held: Session;

spec("AUTO-13", "a run's first prompt holds what started it, the automation's memory, where its outputs go, and its instructions", async () => {
  digest = await automation("Nightly digest", { instructions: "Write the digest.\nhold:digest-9d3f", timeLimitMinutes: 30 });
  const put = await fetch(`${gateway.url}/api/store/automations/${digest.id}/folder/memory.md`, { method: "PUT", body: MEMORY });
  assert.equal(put.status, 200);
  held = await runNow(digest);
  await fake.holding();
  const { lastUserMessage } = await cardShowing(held, (card) => card.lastUserMessage !== null, "its first prompt");
  const prompt = String(lastUserMessage);
  assert.match(prompt, /A person started it by hand \(run now\): no trigger fired/);
  assert.ok(prompt.includes(`~~~~markdown\n${MEMORY}\n~~~~`), "memory.md as the run started");
  assert.ok(prompt.includes(`\`runs/${short(held)}/\` of the automation's folder`), "where the outputs go");
  assert.ok(prompt.includes("`memory.md` is yours to keep current"), "memory.md is the run's to keep current");
  assert.ok(prompt.endsWith("## Instructions\n\nWrite the digest.\nhold:digest-9d3f"), "the instructions come last");
  // AUTO-10: its context says how the run ends, by the automation's end mode.
  const channel = await gateway.omp(held.id);
  const { systemPrompt } = await channel.request("system_prompt");
  channel.close();
  assert.ok(String(systemPrompt).includes("## How this run ends"));
  assert.ok(String(systemPrompt).includes("This automation's end mode is Finish"));
});

spec("AUTO-14", "a run that reaches its time limit is stopped, its work kept, and recorded as timed out, across gateway restarts", async () => {
  // Work the run has not committed when its time is up.
  writeFileSync(join(gateway.stateDir, "sessions", held.id, "worktree", "DIGEST.md"), "digest draft 61a0\n");
  await gateway.restart();
  // The restarted gateway checks its runs' time limits as it starts: within its limit, this one goes on.
  assert.equal((await session(held.id)).endedAt, null);
  const stopping = ended(held);
  gateway.setClock(new Date(Date.now() + 31 * 60_000).toISOString());
  const stopped = await stopping;
  fake.release();
  assert.equal(stopped.run?.outcome, "timed_out");
  assert.equal(stopped.run?.endedBy, null, "no one ended it: its time limit did");
  assert.equal(git(repo, ["show", `refs/agentmonitor/snapshots/${held.id}:DIGEST.md`]), "digest draft 61a0");
});

spec("AUTO-10", "a Finish run deploys through a pull request it merges and ends; with nothing to deploy its branch goes; it ends only as its work bears out", async () => {
  const notes = await automation("Release notes", {
    instructions: [
      "bash:echo 'notes 4c1d' > NOTES.md && git add NOTES.md && git commit -qm 'Release notes 4c1d' && git push -q -u origin HEAD",
      `&& gh pr create --fill && gh pr checks --watch && gh pr merge --merge && f=$(mktemp) && echo 'report 7e2a' > $f && am folder add $f ${OUTPUTS}/report.md`,
      "&& am run end finished",
    ].join(" "),
  });
  finished = await ended(await runNow(notes));
  assert.equal(finished.run?.outcome, "finished");
  assert.equal(finished.run?.endedBy?.kind, "agent");
  assert.ok(originHas("Release notes 4c1d"), "the pull request is merged into origin's main");
  assert.ok((await folder(notes)).includes(`runs/${short(finished)}/report.md`), "the outputs are in the folder");

  const quiet = await automation("Quiet check", { instructions: "bash:git push -q -u origin HEAD && am run end nothing_to_deploy" });
  const nothing = await ended(await runNow(quiet));
  assert.equal(nothing.run?.outcome, "nothing_to_deploy");
  const branch = String(nothing.branch);
  // The branch goes from origin before the run ends, and from this machine once its worktree has.
  assert.equal(git(repo, ["ls-remote", "--heads", "origin", branch]), "");
  while (spawnSync("git", ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], { cwd: repo }).status === 0) {
    // deleteBranch follows the session's end.
  }

  // An unmerged branch is no finished run: refused, the run says it failed, and why.
  const draft = await automation("Draft review", {
    instructions: [
      "bash:echo 'draft 3a9c' > DRAFT.md && git add DRAFT.md && git commit -qm 'Draft 3a9c'",
      `&& f=$(mktemp) && echo 'findings 3a9c' > $f && am folder add $f ${OUTPUTS}/findings.md`,
      "&& (am run end finished 2>/dev/null || am run end failed --why 'no reviewer 6a0e')",
    ].join(" "),
  });
  failed = await ended(await runNow(draft));
  assert.equal(failed.run?.outcome, "failed");
  assert.equal(failed.run?.reason, "no reviewer 6a0e");
  assert.ok(!originHas("Draft 3a9c"));
});

spec("AUTO-10", "a Wait for review run pushes its branch, deploys nothing, and waits on you", async () => {
  const audit = await automation("Weekly audit", {
    endMode: "review",
    instructions: [
      "bash:echo 'audit 5f1b' > AUDIT.md && git add AUDIT.md && git commit -qm 'Audit 5f1b'",
      "&& (am run end review 2>/dev/null || echo 'refused 1c7e') && git push -q -u origin HEAD && am run end review",
    ].join(" "),
  });
  const run = await runNow(audit);
  reviewed = run;
  const card = await cardShowing(run, (shown) => shown.turn === "blocked", "the run waiting for review");
  assert.equal(card.lastReply, "answered: refused 1c7e", "a run with unpushed commits does not wait for review");
  assert.equal(card.session.run?.outcome, "review");
  assert.equal(git(repo, ["rev-parse", `origin/${String(run.branch)}`]), git(repo, ["rev-parse", String(run.branch)]), "its branch is pushed");
  assert.ok(!originHas("Audit 5f1b"), "nothing deployed");
  // Ending it as finished needs its pull request merged first.
  const early = gateway.am(run.id, ["run", "end", "finished"]);
  assert.equal(early.code, 1);
  assert.match(early.stderr, /is not merged into origin\/main/);

  // UI-5: the header counts it among what waits on you, linking to its chat on the automation's page.
  chrome ??= await chromium.launch();
  const page = await chrome.newPage();
  page.setDefaultTimeout(15_000);
  await page.goto(`${gateway.url}/#/`);
  await page.getByTitle("Tasks and runs waiting on you").getByText("1").waitFor();
  await page.getByTitle("Tasks and runs waiting on you").click();
  await page.getByRole("navigation", { name: "Waiting on you" }).getByRole("link", { name: `Weekly audit: run ${short(run)} waits for review` }).click();
  await page.waitForURL(`${gateway.url}/#/a/${audit.id}/chat/${run.id}`);
  await page.close();
});

spec("AUTO-11", "a run is followed up in its session, or in a session on the automation that is no run, from the run: its branch, its work, and its outputs", async () => {
  // A run still going is gone on in its own session.
  const refused = await gateway.api("POST", `/automations/${reviewed.automationId}/sessions`, { runtime: "host", model: "fake/scripted", fromRun: reviewed.id });
  assert.equal(refused.status, 409);
  // A person goes on in the reviewed run's chat and has it deploy.
  const env = { ...process.env, TERN_DAEMON_SOCKET: join(runDir(reviewed), "tern-daemon.sock"), TERN_CONFIG_DIR: join(runDir(reviewed), "tern-config") };
  const deployed = ended(reviewed);
  execFileSync("tern", ["send", "workspace/@focused", "text", "bash:gh pr create --fill && gh pr merge --merge && am run end finished"], { env });
  execFileSync("tern", ["send", "workspace/@focused", "keys", "Enter"], { env });
  const done = await deployed;
  assert.equal(done.run?.outcome, "finished");
  assert.ok(originHas("Audit 5f1b"), "what the person reviewed is deployed");

  fromRun = await gateway.data<Session>("POST", `/automations/${failed.automationId}/sessions`, { runtime: "host", model: "fake/scripted", fromRun: failed.id });
  assert.equal(fromRun.run, null);
  assert.equal(fromRun.taskId, null);
  assert.equal(fromRun.automationId, failed.automationId);
  assert.equal(fromRun.branch, failed.branch);
  assert.equal(git(join(gateway.stateDir, "sessions", fromRun.id, "worktree"), ["log", "-1", "--format=%s"]), "Draft 3a9c");
  assert.match(gateway.am(fromRun.id, ["whoami"]).stdout, /^automation Draft review \(.+\), a session on it, no run$/m);
  const channel = await gateway.omp(fromRun.id);
  const { systemPrompt } = await channel.request("system_prompt");
  channel.close();
  assert.ok(String(systemPrompt).includes(`runs/${short(failed)}/`), "its context names the run's outputs");
  // It is no run: it has no outcome to record.
  const noRun = gateway.am(fromRun.id, ["run", "end", "finished"]);
  assert.equal(noRun.code, 1);
  assert.match(noRun.stderr, /no run of an automation/);
});

spec("AUTO-12", "a task made from a run takes over its branch, with the run's outputs copied into the task's folder", async () => {
  // From an agent, with am.
  const made = gateway.am(fromRun.id, ["--json", "run", "task", short(failed), "--title", "Finish the draft"]);
  assert.equal(made.code, 0, made.stderr);
  await gateway.data("POST", `/sessions/${fromRun.id}/end`);
  const drafted = await gateway.data<TaskDetail>("GET", `/tasks/${String(JSON.parse(made.stdout).task.id)}`);
  assert.equal(drafted.task.title, "Finish the draft");
  assert.equal(drafted.task.branch, failed.branch);
  const files = await gateway.data<FolderFile[]>("GET", `/tasks/${drafted.task.id}/folder`);
  assert.deepEqual(files.map((file) => file.path), [`runs/${short(failed)}/findings.md`]);
  const copied = await fetch(`${gateway.url}/api/store/tasks/${drafted.task.id}/folder/runs/${short(failed)}/findings.md`);
  assert.equal((await copied.text()).trim(), "findings 3a9c");

  // From a person, through the store API.
  const followed = await gateway.data<TaskDetail>("POST", `/runs/${finished.id}/task`, {});
  assert.equal(followed.task.title, `Release notes: run ${short(finished)}`);
  assert.equal(followed.task.branch, finished.branch);
  const outputs = await gateway.data<FolderFile[]>("GET", `/tasks/${followed.task.id}/folder`);
  assert.deepEqual(outputs.map((file) => file.path), [`runs/${short(finished)}/report.md`]);
});
