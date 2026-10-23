import { existsSync } from "node:fs";
import type { BranchState, PullRequest, TaskSummary, Work, WorkBadge } from "../shared/api.ts";
import { gitState } from "./cards.ts";
import { branchChanges, branchExists, git, uncommittedFiles } from "./git.ts";
import { branchPullRequests } from "./github.ts";
import type { WorkspaceDirs } from "./runtime/runtime.ts";
import type { Principal, Session, Store } from "./store/store.ts";

type DirsOf = (sessionId: string) => WorkspaceDirs;

/** A task's or a run's branch, and the worktree of its running session when this machine has one. */
interface Branch {
  repoPath: string | null;
  branch: string | null;
  baseRef: string | null;
  worktree: string | null;
}

function worktreeOf(dirsOf: DirsOf, session: Session | undefined): string | null {
  if (session === undefined || session.endedAt !== null || session.checkout || session.branch === null) return null;
  const { worktree } = dirsOf(session.id);
  return existsSync(worktree) ? worktree : null;
}

/** Where the branch is read: its running session's worktree, else the repository's branch, so work without a session shows too. */
async function readable(target: Branch): Promise<{ cwd: string; ref: string } | null> {
  if (target.worktree !== null) return { cwd: target.worktree, ref: "HEAD" };
  if (target.repoPath !== null && target.branch !== null && (await branchExists(target.repoPath, target.branch))) {
    return { cwd: target.repoPath, ref: target.branch };
  }
  return null;
}

async function pullRequestsOf(target: Branch): Promise<PullRequest[] | null> {
  if (target.repoPath === null || target.branch === null) return null;
  const prs = await branchPullRequests(target.repoPath, target.branch);
  return prs === null ? null : prs.map(({ createdAt: _createdAt, ...pr }) => pr);
}

/** CARD-6: not pushed comes first, as the only one that can lose work; then a pull request open; then merged, deployed. */
function badgeOf(unpushed: boolean, prs: PullRequest[] | null): WorkBadge | null {
  if (unpushed) return "unpushed";
  if (prs?.some((pr) => pr.state === "open") === true) return "open";
  if (prs?.some((pr) => pr.state === "merged") === true) return "deployed";
  return null;
}

/** CARD-3: the branch's state, commits, files, and pull requests. */
async function branchWork(target: Branch): Promise<Omit<Work, "overlaps" | "deployable">> {
  const where = await readable(target);
  const [changes, uncommitted, pullRequests] = await Promise.all([
    where !== null && target.branch !== null && target.baseRef !== null
      ? branchChanges(where.cwd, where.ref, target.branch, target.baseRef).catch(() => null)
      : null,
    target.worktree === null ? null : uncommittedFiles(target.worktree).catch(() => null),
    pullRequestsOf(target),
  ]);
  const commits = changes?.commits ?? null;
  const state: BranchState = (uncommitted?.length ?? 0) > 0
    ? "uncommitted"
    : commits?.some((commit) => !commit.pushed) === true ? "unpushed" : (commits?.length ?? 0) > 0 ? "pushed" : "nothing";
  return { branch: target.branch, baseRef: target.baseRef, state, commits, files: changes?.files ?? null, uncommitted, pullRequests };
}

/**
 * CARD-4: the other running tasks of the project that changed any of `mine`, committed or not;
 * an automation's runs (AUTO-9) are no tasks to point to.
 */
async function overlapsOf(store: Store, dirsOf: DirsOf, principal: Principal, projectId: string, self: { taskId: string | null; sessionId: string | null }, mine: Set<string>): Promise<Work["overlaps"]> {
  const others = store.listSessions(principal, projectId)
    .filter((session) => session.id !== self.sessionId && session.taskId !== null && session.taskId !== self.taskId && !session.checkout && session.baseRef !== null);
  const changed = await Promise.all(others.map(async (session) => ({ session, git: await gitState(dirsOf(session.id).worktree, session.baseRef ?? "") })));
  return changed.flatMap(({ session, git: state }) => {
    const files = (state?.changedFiles ?? []).filter((file) => mine.has(file));
    if (files.length === 0 || session.taskId === null) return [];
    return [{ taskId: session.taskId, title: store.getTask(principal, session.taskId).task.title, files }];
  });
}

/** DEPLOY-1: Deploy is offered for commits with no pull request open or merged; while one is open the page shows it instead. */
function deployable(work: Omit<Work, "overlaps" | "deployable">): boolean {
  return (work.commits?.length ?? 0) > 0 && !(work.pullRequests ?? []).some((pr) => pr.state === "open" || pr.state === "merged");
}

/** CARD-3, CARD-4: a task's Work section, read from its running session's worktree, else from the project's repository. */
export async function taskWork(store: Store, dirsOf: DirsOf, principal: Principal, taskId: string): Promise<Work> {
  const { task, sessions } = store.getTask(principal, taskId);
  const { repoPath } = store.getProject(principal, task.projectId);
  const running = sessions.find((session) => session.endedAt === null);
  const work = await branchWork({ repoPath, branch: task.branch, baseRef: task.baseRef, worktree: worktreeOf(dirsOf, running) });
  const mine = new Set([...(work.files ?? []).map((file) => file.path), ...(work.uncommitted ?? [])]);
  const overlaps = await overlapsOf(store, dirsOf, principal, task.projectId, { taskId, sessionId: running?.id ?? null }, mine);
  return { ...work, overlaps, deployable: deployable(work) };
}

/** AUTO-16: a run's Work section as a task's; Deploy only while the run waits for review. */
export async function runWork(store: Store, dirsOf: DirsOf, principal: Principal, runId: string): Promise<Work> {
  const { session } = store.getSession(principal, runId);
  const { repoPath } = store.getProject(principal, session.projectId);
  const work = await branchWork({ repoPath, branch: session.branch, baseRef: session.baseRef, worktree: worktreeOf(dirsOf, session) });
  const mine = new Set([...(work.files ?? []).map((file) => file.path), ...(work.uncommitted ?? [])]);
  const overlaps = await overlapsOf(store, dirsOf, principal, session.projectId, { taskId: null, sessionId: session.id }, mine);
  const waits = session.run?.outcome === "review" && session.endedAt === null;
  return { ...work, overlaps, deployable: waits && deployable(work) };
}

/**
 * CARD-6: the project's tasks with their board badges. Only unfinished tasks with a branch have
 * one; a badge reads only what it needs: whether a commit is not pushed, then the pull requests.
 */
export async function withBadges(store: Store, dirsOf: DirsOf, principal: Principal, projectId: string, summaries: Array<Omit<TaskSummary, "badge">>): Promise<TaskSummary[]> {
  const { repoPath } = store.getProject(principal, projectId);
  const sessions = new Map(store.listSessions(principal, projectId).map((session) => [session.id, session]));
  return Promise.all(summaries.map(async (summary): Promise<TaskSummary> => {
    const { task } = summary;
    if (task.state === "done" || task.state === "cancelled" || task.branch === null || task.baseRef === null) return { ...summary, badge: null };
    const target: Branch = {
      repoPath,
      branch: task.branch,
      baseRef: task.baseRef,
      worktree: worktreeOf(dirsOf, summary.sessionId === null ? undefined : sessions.get(summary.sessionId)),
    };
    const where = await readable(target);
    const unpushed = where === null
      ? 0
      : Number(await git(where.cwd, ["rev-list", "--count", where.ref, "--not", "--remotes", task.baseRef]).catch(() => "0"));
    return { ...summary, badge: badgeOf(unpushed > 0, unpushed > 0 ? null : await pullRequestsOf(target)) };
  }));
}
