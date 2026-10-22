import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

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

/** SESSION-9: where a task's latest snapshot lives; a ref outside refs/heads and refs/tags, so pushes leave it behind. */
export function snapshotRef(taskId: string): string {
  return `refs/agentmonitor/snapshots/${taskId}`;
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
