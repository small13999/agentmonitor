import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { PullRequest } from "../shared/api.ts";

const run = promisify(execFile);

const listed = z.array(z.object({ number: z.number(), title: z.string(), url: z.string(), createdAt: z.string() }));

/** A pull request with when it was opened (ms since epoch). */
export interface OpenedPullRequest extends PullRequest {
  createdAt: number;
}

/** GitHub answers are slow and rate limited; one lookup per branch and state per half minute. */
const cache = new Map<string, { at: number; prs: OpenedPullRequest[] | null }>();

/**
 * The pull requests from `branch`, open ones or all, as GitHub CLI finds them from the
 * repository at `cwd`; null when GitHub cannot be asked.
 */
export async function branchPullRequests(cwd: string, branch: string, state: "open" | "all"): Promise<OpenedPullRequest[] | null> {
  const key = `${cwd}\0${branch}\0${state}`;
  const cached = cache.get(key);
  if (cached !== undefined && Date.now() - cached.at < 30_000) return cached.prs;
  let prs: OpenedPullRequest[] | null;
  try {
    const { stdout } = await run(
      process.env.AGENTMONITOR_GH ?? "gh",
      ["pr", "list", "--head", branch, "--state", state, "--json", "number,title,url,createdAt"],
      { cwd, encoding: "utf8", timeout: 10_000 },
    );
    prs = listed.parse(JSON.parse(stdout)).map((pr) => ({ number: pr.number, title: pr.title, url: pr.url, createdAt: Date.parse(pr.createdAt) }));
  } catch {
    prs = null;
  }
  cache.set(key, { at: Date.now(), prs });
  return prs;
}

/** Open pull requests from `branch` as cards and the Changes view show them. */
export async function openPullRequests(cwd: string, branch: string): Promise<PullRequest[] | null> {
  const prs = await branchPullRequests(cwd, branch, "open");
  return prs === null ? null : prs.map((pr) => ({ number: pr.number, title: pr.title, url: pr.url }));
}
