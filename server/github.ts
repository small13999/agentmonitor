import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { CheckState, PullRequest } from "../shared/api.ts";

const run = promisify(execFile);

// A check is a GitHub Actions run (CheckRun) or a commit status another service set (StatusContext).
const check = z.union([
  z.object({ __typename: z.literal("CheckRun"), name: z.string(), status: z.string(), conclusion: z.string().nullable().optional() }),
  z.object({ __typename: z.literal("StatusContext"), context: z.string(), state: z.string() }),
]);
const listed = z.array(z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  createdAt: z.string(),
}));
const checked = z.array(z.object({ number: z.number(), statusCheckRollup: z.array(check).nullable().optional() }));

function checkState(found: z.infer<typeof check>): CheckState {
  if (found.__typename === "StatusContext") {
    return found.state === "SUCCESS" ? "passing" : found.state === "PENDING" || found.state === "EXPECTED" ? "pending" : "failing";
  }
  if (found.status !== "COMPLETED") return "pending";
  return found.conclusion === "SUCCESS" || found.conclusion === "NEUTRAL" || found.conclusion === "SKIPPED" ? "passing" : "failing";
}

/** A pull request with when it was opened (ms since epoch). */
export interface OpenedPullRequest extends PullRequest {
  createdAt: number;
}

/** `gh pr list` of every pull request from `branch`, open, merged, or closed, with `fields`, as GitHub CLI answers from the repository at `cwd`. */
async function ghPullRequests(cwd: string, branch: string, fields: string): Promise<unknown> {
  const { stdout } = await run(
    process.env.AGENTMONITOR_GH ?? "gh",
    ["pr", "list", "--head", branch, "--state", "all", "--json", fields],
    { cwd, encoding: "utf8", timeout: 10_000 },
  );
  return JSON.parse(stdout);
}

/** The pull requests from `branch`, newest first, without their checks; null when GitHub cannot be asked. */
async function listPullRequests(cwd: string, branch: string): Promise<Array<Omit<OpenedPullRequest, "checks">> | null> {
  try {
    return listed.parse(await ghPullRequests(cwd, branch, "number,title,url,state,createdAt")).map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state === "OPEN" ? "open" : pr.state === "MERGED" ? "merged" : "closed",
      createdAt: Date.parse(pr.createdAt),
    }));
  } catch {
    return null;
  }
}

/**
 * The pull requests from `branch` (listPullRequests) with their checks. Checks are asked for
 * apart: a token may read pull requests but not checks (a fine-grained token without the Checks
 * permission fails the whole query), and then the pull requests still show, their checks null.
 */
async function pullRequestsWithChecks(cwd: string, branch: string): Promise<OpenedPullRequest[] | null> {
  const prs = await listPullRequests(cwd, branch);
  if (prs === null) return null;
  if (prs.length === 0) return [];
  const checks = await ghPullRequests(cwd, branch, "number,statusCheckRollup").then(
    (answer) => new Map(checked.parse(answer).map((pr) => [pr.number, (pr.statusCheckRollup ?? []).map((found) => ({
      name: found.__typename === "CheckRun" ? found.name : found.context,
      state: checkState(found),
    }))])),
    () => null,
  );
  return prs.map((pr) => ({ ...pr, checks: checks === null ? null : checks.get(pr.number) ?? [] }));
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
