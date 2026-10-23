import { existsSync } from "node:fs";
import type { TaskChanges } from "../shared/api.ts";
import { gitState } from "./cards.ts";
import { branchChanges, branchExists, uncommittedFiles } from "./git.ts";
import { openPullRequests } from "./github.ts";
import type { WorkspaceDirs } from "./runtime/runtime.ts";
import type { Principal, Store } from "./store/store.ts";

/**
 * CARD-3: what the task's branch changed against the default branch it started from, its
 * running session's uncommitted files, and its open pull requests. The branch is read from the
 * running session's worktree, else from the project's repository, so a task without a session
 * shows its committed work too. CARD-4: the other running tasks of the project that changed
 * any of the same files, committed or not.
 */
export async function taskChanges(
  store: Store,
  dirsOf: (sessionId: string) => WorkspaceDirs,
  principal: Principal,
  taskId: string,
): Promise<TaskChanges> {
  const { task, sessions } = store.getTask(principal, taskId);
  const { repoPath } = store.getProject(principal, task.projectId);
  const running = sessions.find((session) => session.endedAt === null && !session.checkout && session.branch !== null);
  const worktree = running !== undefined && existsSync(dirsOf(running.id).worktree) ? dirsOf(running.id).worktree : null;
  const cwd = worktree ?? repoPath;
  const ref = worktree !== null
    ? "HEAD"
    : repoPath !== null && task.branch !== null && (await branchExists(repoPath, task.branch)) ? task.branch : null;
  const others = store.listSessions(principal, task.projectId)
    .filter((session) => session.taskId !== taskId && !session.checkout && session.baseRef !== null);
  const [committed, uncommitted, pullRequests, otherChanges] = await Promise.all([
    cwd !== null && ref !== null && task.baseRef !== null ? branchChanges(cwd, ref, task.baseRef).catch(() => null) : null,
    worktree === null ? null : uncommittedFiles(worktree).catch(() => null),
    cwd !== null && task.branch !== null ? openPullRequests(cwd, task.branch) : null,
    Promise.all(others.map(async (session) => ({ session, git: await gitState(dirsOf(session.id).worktree, session.baseRef ?? "") }))),
  ]);
  const mine = new Set([...(committed?.files.map((file) => file.path) ?? []), ...(uncommitted ?? [])]);
  const overlaps = otherChanges.flatMap(({ session, git }) => {
    const files = (git?.changedFiles ?? []).filter((file) => mine.has(file));
    // An automation's run (AUTO-9) is no task to point to.
    if (files.length === 0 || session.taskId === null) return [];
    return [{ taskId: session.taskId, title: store.getTask(principal, session.taskId).task.title, files }];
  });
  return { branch: task.branch, baseRef: task.baseRef, committed, uncommitted, pullRequests, overlaps };
}
