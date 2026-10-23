import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { CheckState, PullRequest } from "../shared/api.ts";

const run = promisify(execFile);

const listed = z.array(z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  createdAt: z.string(),
  headRefOid: z.string(),
}));
// GitHub Actions runs as `gh run list` gives them: lowercase status and conclusion, the conclusion empty until completed.
const actionRuns = z.array(z.object({ name: z.string(), status: z.string(), conclusion: z.string(), url: z.string() }));

function checkState(found: z.infer<typeof actionRuns>[number]): CheckState {
  if (found.status !== "completed") return "pending";
  return found.conclusion === "success" || found.conclusion === "neutral" || found.conclusion === "skipped" ? "passing" : "failing";
}

/** A pull request with when it was opened (ms since epoch). */
export interface OpenedPullRequest extends PullRequest {
  createdAt: number;
}

/** GitHub CLI's JSON answer to `args`, asked from the repository at `cwd`. */
async function gh(cwd: string, args: string[]): Promise<unknown> {
  const { stdout } = await run(process.env.AGENTMONITOR_GH ?? "gh", args, { cwd, encoding: "utf8", timeout: 10_000 });
  return JSON.parse(stdout);
}

/** The pull requests from `branch`, open, merged, or closed, newest first, with their head commit and without checks; null when GitHub cannot be asked. */
async function listPullRequests(cwd: string, branch: string): Promise<Array<Omit<OpenedPullRequest, "checks"> & { head: string }> | null> {
  try {
    const answer = await gh(cwd, ["pr", "list", "--head", branch, "--state", "all", "--json", "number,title,url,state,createdAt,headRefOid"]);
    return listed.parse(answer).map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state === "OPEN" ? "open" : pr.state === "MERGED" ? "merged" : "closed",
      createdAt: Date.parse(pr.createdAt),
      head: pr.headRefOid,
    }));
  } catch {
    return null;
  }
}

/**
 * A commit's checks: its GitHub Actions runs. Read from Actions, not from the pull request's
 * check rollup: a fine-grained token has no Checks permission at all, while Actions: read
 * works. Null when they cannot be read; the pull request shows without them.
 */
async function commitChecks(cwd: string, sha: string): Promise<PullRequest["checks"]> {
  try {
    const answer = await gh(cwd, ["run", "list", "--commit", sha, "--json", "name,status,conclusion,url"]);
    return actionRuns.parse(answer).map((found) => ({ name: found.name, state: checkState(found), url: found.url }));
  } catch {
    return null;
  }
}

/** The pull requests from `branch` (listPullRequests), each with its head commit's checks (commitChecks). */
async function pullRequestsWithChecks(cwd: string, branch: string): Promise<OpenedPullRequest[] | null> {
  const prs = await listPullRequests(cwd, branch);
  if (prs === null) return null;
  return Promise.all(prs.map(async ({ head, ...pr }) => ({ ...pr, checks: await commitChecks(cwd, head) })));
}

/**
 * GitHub answers are slow and rate limited, and the board, the task page, and its history all
 * poll: one lookup per repository and branch per ten seconds, shared by everyone asking meanwhile.
 */
const CACHE_MS = 10_000;
const cache = new Map<string, { at: number; prs: Promise<OpenedPullRequest[] | null> }>();

/** CARD-3, CARD-6, TASK-14: the pull requests from `branch` with their checks (pullRequestsWithChecks), looked up at most once per CACHE_MS. */
export function branchPullRequests(repo: string, branch: string): Promise<OpenedPullRequest[] | null> {
  const key = `${repo}\0${branch}`;
  const cached = cache.get(key);
  if (cached !== undefined && Date.now() - cached.at < CACHE_MS) return cached.prs;
  const prs = pullRequestsWithChecks(repo, branch);
  cache.set(key, { at: Date.now(), prs });
  return prs;
}

/**
 * AUTO-10: whether GitHub CLI finds a merged pull request from `branch` (a squash merge leaves the
 * branch's own commits off the default branch); false when GitHub cannot be asked. Never cached:
 * the answer decides whether a run may say it deployed.
 */
export async function hasMergedPullRequest(cwd: string, branch: string): Promise<boolean> {
  return ((await listPullRequests(cwd, branch)) ?? []).some((pr) => pr.state === "merged");
}
