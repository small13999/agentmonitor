import { connect } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import type { Automation, RunOutcome, Session } from "../../shared/api.ts";
import { defaultBaseRef, fetchOrigin, git, uncommittedFiles, unpushedCommits } from "../git.ts";
import { DEPLOY_INSTRUCTION } from "../deploy.ts";
import { hasMergedPullRequest } from "../github.ts";
import { runShortId, StoreError } from "./store.ts";

// AUTO-10, AUTO-11, AUTO-13, AUTO-14: what a run does from its first prompt to its end. The
// service (service.ts) starts and stops sessions; this file says what a run is told and when it
// may end how.

/** AUTO-1: the automation's memory, a file of its folder that every run starts with. */
export const MEMORY_FILE = "memory.md";

/** The most of memory.md a run's first prompt holds; the agent reads the rest in the folder. */
const MEMORY_PROMPT_BYTES = 32 * 1024;

/** AUTO-1: where a run's outputs go in its automation's folder. */
export function runOutputs(runId: string): string {
  return `runs/${runShortId(runId)}`;
}

/** What a run may say about how it went; `timed_out` and `ended` are the gateway's and people's to say. */
export type AgentOutcome = Extract<RunOutcome, "finished" | "nothing_to_deploy" | "review" | "failed">;

/**
 * AUTO-13: a run's first prompt: what started it (its trigger's guard and check), the
 * automation's memory, where its outputs go, and the automation's instructions, last, as what to
 * do. `memory` is memory.md as the run starts; null when the folder has none. `folder` is the
 * folder's directory as the agent sees it.
 */
export function runPrompt(automation: Automation, run: Session, memory: Buffer | null, folder: string): string {
  const outputs = runOutputs(run.id);
  const context = run.run?.triggerContext.trim() ?? "";
  const started = context !== ""
    ? context
    : run.run?.startedBy == null
      ? "One of its triggers fired; the trigger has no guard and no check."
      : "A person started it by hand (run now): no trigger fired, so no guard or check ran.";
  let remembered: string;
  if (memory === null) {
    remembered = `The folder has no \`${MEMORY_FILE}\` yet: this may be the automation's first run.`;
  } else {
    const shown = memory.subarray(0, MEMORY_PROMPT_BYTES).toString("utf8");
    const cut = memory.length > MEMORY_PROMPT_BYTES
      ? `\n\n(memory.md has ${memory.length} bytes; this is its first ${MEMORY_PROMPT_BYTES}. Read the rest in the folder.)`
      : "";
    remembered = `\`${MEMORY_FILE}\` of the automation's folder, as this run started:\n\n~~~~markdown\n${shown.trimEnd()}\n~~~~${cut}`;
  }
  return [
    `# Run ${runShortId(run.id)} of the automation "${automation.name}"`,
    "## What started this run",
    started,
    "## Memory",
    remembered,
    "## Outputs and memory",
    `Put what this run produces for people (reports, screenshots, exports) into \`${outputs}/\` of the automation's folder ` +
      `(the directory \`${folder}/${outputs}/\`, or \`am folder add FILE ${outputs}/NAME\`). ` +
      `\`${MEMORY_FILE}\` is yours to keep current: before the run ends, rewrite it with what the next run needs to know, replacing what is outdated. ` +
      "End the run as your context says under \"How this run ends\".",
    "## Instructions",
    automation.instructions.trim() === "" ? "(The automation has no instructions yet.)" : automation.instructions.trim(),
  ].join("\n\n");
}

/** AUTO-10, AUTO-14: what a run's agent is told about how its run ends, by its automation's end mode. */
export function endModeSection(automation: Automation, run: Session): string {
  const outputs = runOutputs(run.id);
  // DEPLOY-1: the instruction Deploy on the run's page sends, here as the run's own way to deploy.
  const deploy = `do what Deploy on the run's page sends you ("${DEPLOY_INSTRUCTION}"), then \`am run end finished\`; ` +
    "Agent Monitor accepts it once the branch is merged into the default branch";
  const common = [
    `- Nothing to deploy (no change to the repository): \`am run end nothing_to_deploy\`; Agent Monitor deletes the run's branch.`,
    "- You cannot do what the instructions ask: `am run end failed --why \"WHY\"`.",
    "`am run end` refuses an outcome that is not true yet (uncommitted files, an unmerged or unpushed branch) and says why.",
    `A run still going after ${automation.timeLimitMinutes} minutes is stopped and recorded as timed out; its uncommitted work is kept, not pushed.`,
  ];
  const mode = automation.endMode === "finish"
    ? [
        "This automation's end mode is Finish: the run deploys its work and ends. Its pull request needs no review: this end mode is the project's permission to merge it once its checks pass (MERGE-2).",
        `- Write the outputs into \`${outputs}/\` and update \`${MEMORY_FILE}\` first.`,
        `- Work to deploy: ${deploy}.`,
        ...common,
        "The run's session ends when your turn ends after `am run end`.",
      ]
    : [
        "This automation's end mode is Wait for review: the run deploys nothing and waits for a person.",
        `- Write the outputs into \`${outputs}/\`, update \`${MEMORY_FILE}\`, commit and push the branch, then \`am run end review\`. ` +
          "The session stays open and the run shows as waiting on the people of the project.",
        `- A person may go on in this session, for example to have you deploy what they reviewed: then ${deploy}.`,
        ...common,
        "After `am run end` with anything but review, the run's session ends when your turn ends.",
      ];
  return ["## How this run ends", ...mode].join("\n\n");
}

/**
 * AUTO-10: refuses an outcome a run's work does not bear out: `finished` needs the branch merged
 * into the default branch (or a merged pull request of it, for squash merges), `nothing_to_deploy`
 * a branch with nothing the default branch lacks, `review` the branch pushed; none may leave
 * uncommitted files. `failed` needs only its reason.
 */
export async function checkOutcome(repo: string, worktree: string, run: Session, outcome: AgentOutcome): Promise<void> {
  if (outcome === "failed" || run.branch === null || run.baseRef === null) return;
  const uncommitted = await uncommittedFiles(worktree);
  if (uncommitted.length > 0) {
    throw new StoreError(409, `the run's worktree has uncommitted files (${uncommitted.join(", ")}): commit or remove them first`);
  }
  if (outcome === "review") {
    const unpushed = await unpushedCommits(repo, run.branch, run.baseRef);
    if (unpushed.length > 0) throw new StoreError(409, `${run.branch} has ${unpushed.length} commit(s) no remote has: push the branch first (git push -u origin HEAD)`);
    return;
  }
  const target = await defaultBaseRef(repo, await fetchOrigin(repo));
  if (outcome === "nothing_to_deploy") {
    const ahead = (await git(repo, ["rev-list", `${target}..${run.branch}`])).split("\n").filter(Boolean);
    if (ahead.length > 0) {
      throw new StoreError(409, `${run.branch} has ${ahead.length} commit(s) ${target} lacks: deploy them (am run end finished), or end the run as failed`);
    }
    return;
  }
  const merged = await git(repo, ["merge-base", "--is-ancestor", run.branch, target]).then(() => true, () => false);
  if (!merged && !(await hasMergedPullRequest(repo, run.branch))) {
    throw new StoreError(409, `${run.branch} is not merged into ${target}: open its pull request, merge it once its checks pass, then end the run`);
  }
}

/** AUTO-10: removes a run's branch from origin, where its agent may have pushed it; nothing when origin lacks it. */
export async function deleteRemoteBranch(repo: string, branch: string): Promise<void> {
  const remote = await git(repo, ["ls-remote", "--heads", "origin", branch]).catch(() => "");
  if (remote !== "") await git(repo, ["push", "origin", "--delete", branch]);
}

/** AUTO-14: a run that its time limit stops now: going, not waiting for review (a person has it then), and older than the limit. */
export function overTimeLimit(run: Session, automation: Automation, now: number): boolean {
  return run.run !== null && run.endedAt === null && run.run.outcome !== "review" && now >= run.startedAt + automation.timeLimitMinutes * 60_000;
}

const channelMessage = z.object({ id: z.number().optional(), type: z.string().optional(), ok: z.boolean().optional(), turn: z.string().optional() });

/**
 * Resolves once the session's agent is not in a turn: at once when it is not, else when its turn
 * ends (container/omp-extension.ts pushes the change), or when no live agent answers.
 */
export async function turnEnded(runDir: string): Promise<void> {
  const socket = connect(join(runDir, "omp.sock"));
  const { promise, resolve } = Promise.withResolvers<void>();
  socket.setEncoding("utf8");
  socket.on("error", () => resolve());
  socket.on("close", () => resolve());
  socket.on("connect", () => socket.write(`${JSON.stringify({ id: 1, op: "state" })}\n`));
  let buffer = "";
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const message = channelMessage.safeParse(JSON.parse(line));
      if (!message.success) continue;
      const { id, type, ok, turn } = message.data;
      if ((id === 1 && (ok !== true || turn !== "working")) || (type === "turn" && turn !== "working")) resolve();
    }
  });
  return promise.finally(() => socket.destroy());
}
