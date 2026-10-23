import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ChangedFile, WorkCommit } from "../shared/api.ts";

const run = promisify(execFile);

export async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await run("git", args, { cwd, encoding: "utf8", env: env ?? process.env, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

async function refExists(repo: string, ref: string): Promise<boolean> {
  return git(repo, ["rev-parse", "--verify", "--quiet", ref]).then(() => true, () => false);
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  return refExists(repo, `refs/heads/${branch}`);
}

/** Brings origin's branches up to date, when the repository has an origin; whether it has one. */
export async function fetchOrigin(repo: string): Promise<boolean> {
  if (!(await git(repo, ["remote"])).split("\n").includes("origin")) return false;
  await git(repo, ["fetch", "origin", "--prune"]);
  return true;
}

/**
 * The default branch to start new work from, after fetchOrigin: origin's default branch;
 * origin's copy of the main checkout's branch when origin's default is unknown (a remote
 * added rather than cloned); the main checkout's branch without an origin.
 */
export async function defaultBaseRef(repo: string, hasOrigin: boolean): Promise<string> {
  const local = await git(repo, ["symbolic-ref", "--short", "HEAD"]);
  if (!hasOrigin) return local;
  const head = await git(repo, ["rev-parse", "--abbrev-ref", "origin/HEAD"]).catch(() => null);
  if (head !== null) return head;
  return (await refExists(repo, `refs/remotes/origin/${local}`)) ? `origin/${local}` : local;
}

/**
 * TASK-4: a worktree of the task's branch. The branch is reused when the machine has it,
 * taken from origin when only origin has it (a task reopened after its local branch was
 * deleted, or started on another machine), and created from `baseRef` otherwise.
 */
export async function addWorktree(repo: string, branch: string, worktree: string, baseRef: string): Promise<void> {
  if (await branchExists(repo, branch)) {
    await git(repo, ["worktree", "add", worktree, branch]);
  } else if (await refExists(repo, `refs/remotes/origin/${branch}`)) {
    await git(repo, ["worktree", "add", "--track", "-b", branch, worktree, `origin/${branch}`]);
  } else {
    await git(repo, ["worktree", "add", "--no-track", "-b", branch, worktree, baseRef]);
  }
  // Container-side git must not prune other sessions' worktrees, which it cannot see.
  await git(repo, ["worktree", "lock", "--reason", "agentmonitor session", worktree]);
}

/** Removes a worktree with whatever it holds; its branch stays. */
export async function removeWorktree(repo: string, worktree: string): Promise<void> {
  if (existsSync(worktree)) await git(repo, ["worktree", "remove", "-f", "-f", worktree]);
}

export async function deleteBranch(repo: string, branch: string): Promise<void> {
  if (await branchExists(repo, branch)) await git(repo, ["branch", "-D", branch]);
}

/** Uncommitted (changed, staged, or untracked) files of a worktree, relative to it. */
export async function uncommittedFiles(worktree: string): Promise<string[]> {
  const status = (await run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: worktree, encoding: "utf8" })).stdout;
  // -z entries are "XY path"; renames carry the old path as an extra entry, which is skipped.
  // A path can show twice, e.g. staged as deleted and present untracked.
  const entries = status.split("\0").filter(Boolean);
  const files = new Set<string>();
  for (let index = 0; index < entries.length; index++) {
    files.add(entries[index].slice(3));
    if (entries[index][0] === "R" || entries[index][0] === "C") index++;
  }
  return [...files];
}

/**
 * Commits on `ref` that no remote branch and not `baseRef` has, as "<short sha> <subject>",
 * newest first: the commits that deleting `ref` loses.
 */
export async function unpushedCommits(repo: string, ref: string, baseRef: string): Promise<string[]> {
  return (await git(repo, ["log", "--format=%h %s", ref, "--not", "--remotes", baseRef])).split("\n").filter(Boolean);
}

/**
 * CARD-3: where the work of `branch` (at `ref`, its name or a worktree's HEAD) starts: where it
 * left `baseRef`. A branch merged into `baseRef` without a squash has no commits of its own
 * there any more; its work then starts where the branch was created, as its reflog says, so a
 * deployed branch still shows what it did.
 */
async function workBase(cwd: string, ref: string, branch: string, baseRef: string): Promise<string> {
  const base = await git(cwd, ["merge-base", ref, baseRef]);
  if (base !== await git(cwd, ["rev-parse", ref])) return base;
  const reflog = (await git(cwd, ["log", "-g", "--format=%H%x00%gs", `refs/heads/${branch}`]).catch(() => "")).split("\n").filter(Boolean);
  const [created, message] = (reflog.at(-1) ?? "").split("\0");
  if (message?.startsWith("branch: Created from") !== true) return base;
  return git(cwd, ["merge-base", "--is-ancestor", created, ref]).then(() => created, () => base);
}

/** CARD-3: the web page of a commit on the repository's origin, e.g. GitHub's, from origin's URL as configured; null when origin is no web host. */
async function commitPage(cwd: string): Promise<((sha: string) => string) | null> {
  const url = await git(cwd, ["config", "--get", "remote.origin.url"]).catch(() => "");
  // https://host/owner/repo.git, ssh://git@host:22/owner/repo.git, git@host:owner/repo.git
  const match = /^(?:(?:https?|ssh):\/\/(?:[^@/]+@)?|[^@/:]+@)([^/:]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/.exec(url);
  if (match === null) return null;
  return (sha) => `https://${match[1]}/${match[2]}/commit/${sha}`;
}

/**
 * CARD-3: the commits of `branch` (at `ref`) since it left `baseRef` (workBase), newest first,
 * each with whether a remote has it, and the files they changed with their lines added and
 * deleted.
 */
export async function branchChanges(cwd: string, ref: string, branch: string, baseRef: string): Promise<{ commits: WorkCommit[]; files: ChangedFile[] }> {
  const base = await workBase(cwd, ref, branch, baseRef);
  const [log, unpushed, page, statuses, numstat] = await Promise.all([
    git(cwd, ["log", "--format=%H%x00%ct%x00%s%x00%b%x1e", `${base}..${ref}`]),
    // As unpushedCommits counts them: what a remote branch or the default branch has is safe.
    git(cwd, ["rev-list", `${base}..${ref}`, "--not", "--remotes", baseRef]),
    commitPage(cwd),
    git(cwd, ["diff", "--name-status", "-z", base, ref]),
    git(cwd, ["diff", "--numstat", "-z", base, ref]),
  ]);
  const notPushed = new Set(unpushed.split("\n"));
  const commits = log.split("\x1e").map((entry) => entry.trim()).filter(Boolean).map((entry): WorkCommit => {
    const [sha, at, subject, body] = entry.split("\0");
    return { sha, subject, body: (body ?? "").trim(), at: Number(at) * 1000, pushed: !notPushed.has(sha), url: page === null ? null : page(sha) };
  });
  // numstat -z entries are "added\tdeleted\tpath\0", or for a rename "added\tdeleted\t\0old\0new\0"; binary files count "-".
  const lines = new Map<string, { added: number | null; deleted: number | null }>();
  const counted = numstat.split("\0");
  for (let index = 0; index < counted.length; index++) {
    const [added, deleted, path] = counted[index].split("\t");
    if (path === undefined) continue;
    const target = path === "" ? counted[(index += 2)] : path;
    lines.set(target, { added: added === "-" ? null : Number(added), deleted: deleted === "-" ? null : Number(deleted) });
  }
  // name-status -z entries are "status\0path\0"; renames and copies carry the old path first.
  const entries = statuses.split("\0").filter(Boolean);
  const files: ChangedFile[] = [];
  for (let index = 0; index < entries.length; index += 2) {
    const code = entries[index][0];
    if (code === "R" || code === "C") index++;
    const path = entries[index + 1];
    const status = code === "R" ? "renamed" : code === "A" || code === "C" ? "added" : code === "D" ? "deleted" : "modified";
    files.push({ path, status, ...(lines.get(path) ?? { added: null, deleted: null }) });
  }
  return { commits, files };
}

/** SESSION-9: where a task's latest snapshot lives, or a run's (AUTO-9), by its session's id; a ref outside refs/heads and refs/tags, so pushes leave it behind. */
export function snapshotRef(taskId: string): string {
  return `refs/agentmonitor/snapshots/${taskId}`;
}

/** SESSION-9, STORE-6: a task's or a run's snapshot refs, its latest and those kept beside it when they did not apply cleanly. */
export async function taskSnapshots(repo: string, taskId: string): Promise<string[]> {
  return (await git(repo, ["for-each-ref", "--format=%(refname)", `${snapshotRef(taskId)}*`])).split("\n").filter(Boolean);
}

/**
 * SESSION-9: records the worktree's uncommitted changes, untracked files included and
 * ignored files not, as a commit on top of HEAD at `ref`, through a scratch index so the
 * worktree's own index and files stay as they are. Returns the files it kept; none: no
 * snapshot is written.
 */
export async function saveSnapshot(repo: string, worktree: string, ref: string): Promise<string[]> {
  const files = await uncommittedFiles(worktree);
  if (files.length === 0) return files;
  const index = join(tmpdir(), `agentmonitor-snapshot-${randomBytes(6).toString("hex")}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    await git(worktree, ["read-tree", "HEAD"], env);
    await git(worktree, ["add", "-A"], env);
    const tree = await git(worktree, ["write-tree"], env);
    const commit = await git(worktree, ["commit-tree", tree, "-p", "HEAD", "-m", "Agent Monitor snapshot of uncommitted work"]);
    await git(repo, ["update-ref", ref, commit]);
  } finally {
    rmSync(index, { force: true });
  }
  return files;
}

/** What restoring a task's snapshot did; `kept` names the ref holding a snapshot that did not apply cleanly. */
export type RestoredSnapshot = { kind: "none" } | { kind: "restored" } | { kind: "conflicts"; kept: string };

/**
 * SESSION-9: puts the snapshot at `ref` back into a fresh worktree as uncommitted changes
 * and drops `ref`, so it is restored once. The snapshot applies as the diff from the commit
 * it was taken on. When the branch has moved since and parts conflict, git leaves merge
 * markers where it can, and the snapshot moves to a kept ref beside `ref` so nothing in it
 * is lost.
 */
export async function restoreSnapshot(repo: string, worktree: string, ref: string): Promise<RestoredSnapshot> {
  if (!(await refExists(repo, ref))) return { kind: "none" };
  const patch = join(tmpdir(), `agentmonitor-snapshot-${randomBytes(6).toString("hex")}.patch`);
  let applied: boolean;
  try {
    // A file, not a pipe: snapshots can be large, and git apply reads binary patches from files.
    const { stdout } = await run("git", ["diff", "--binary", `${ref}^`, ref], { cwd: worktree, encoding: "buffer", maxBuffer: 1024 * 1024 * 1024 });
    writeFileSync(patch, stdout);
    applied = await git(worktree, ["apply", "--3way", patch]).then(() => true, () => false);
    // apply --3way stages what it applied; the snapshot was uncommitted work, so it is unstaged again.
    await git(worktree, ["reset", "--quiet"]);
  } finally {
    rmSync(patch, { force: true });
  }
  if (applied) {
    await git(repo, ["update-ref", "-d", ref]);
    return { kind: "restored" };
  }
  const kept = `${ref}-unapplied-${Date.now()}`;
  await git(repo, ["update-ref", kept, ref]);
  await git(repo, ["update-ref", "-d", ref]);
  return { kind: "conflicts", kept };
}
