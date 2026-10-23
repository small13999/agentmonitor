import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { FiringVerdict } from "../../shared/api.ts";
import { CONTAINER_FOLDER, WORKSPACE_IMAGE } from "../runtime/podman.ts";

/** AUTO-8: how long a trigger's guard may run, and its check. */
const GUARD_LIMIT_MS = 2 * 60_000;
const CHECK_LIMIT_MS = 5 * 60_000;
/** How much of a guard's or check's output is kept, each of stdout and stderr. */
const OUTPUT_LIMIT = 64 * 1024;
/** Where a check's container has the omp agent directory: credentials, providers, and the user's settings (SESSION-17). */
const CONTAINER_OMP_AGENT = "/host-omp-agent";

/** What the guard and check containers are made with. */
export interface GateOptions {
  /** The gateway's state directory, which labels its containers. */
  stateDir: string;
  /** The omp agent directory sessions take credentials, providers, and the user's settings from. */
  ompAgentDir: string;
  memoryMib: number;
}

interface GateInput {
  firingId: string;
  /** The automation's folder on this machine. */
  folder: string;
  /** The guard's or check's file in it. */
  path: string;
  /** Aborted: the gateway stops, and the container with it. */
  signal: AbortSignal;
}

interface Finished {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Runs `command` in the session image, never on the gateway's machine: the automation's folder
 * read-only, as its working directory, and nothing else of the gateway's unless `mounts` adds
 * it. Stopped after `limitMs`, or when `signal` aborts.
 */
async function inImage(
  options: GateOptions,
  input: { name: string; folder: string; mounts: string[]; command: string[]; stdin: string | null; limitMs: number; signal: AbortSignal },
): Promise<Finished> {
  const [entrypoint, ...args] = input.command;
  const child = spawn("podman", [
    "run", "--rm", "--init",
    "--name", input.name,
    "--label", `agentmonitor.state=${options.stateDir}`,
    "--userns=keep-id",
    "--memory", `${options.memoryMib}m`, "--memory-swap", `${options.memoryMib}m`,
    "-v", `${input.folder}:${CONTAINER_FOLDER}:ro`,
    "-w", CONTAINER_FOLDER,
    ...input.mounts,
    ...(input.stdin === null ? [] : ["-i"]),
    "--entrypoint", entrypoint,
    WORKSPACE_IMAGE,
    ...args,
  ], { stdio: [input.stdin === null ? "ignore" : "pipe", "pipe", "pipe"] });
  const finished: Finished = { code: null, stdout: "", stderr: "", timedOut: false };
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    if (finished.stdout.length < OUTPUT_LIMIT) finished.stdout = (finished.stdout + chunk).slice(0, OUTPUT_LIMIT);
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    if (finished.stderr.length < OUTPUT_LIMIT) finished.stderr = (finished.stderr + chunk).slice(0, OUTPUT_LIMIT);
  });
  child.stdin?.end(input.stdin);
  const closed = Promise.withResolvers<void>();
  child.once("error", closed.reject);
  child.once("close", (code) => {
    finished.code = code;
    closed.resolve();
  });
  const remove = () => execFile("podman", ["rm", "-f", "-t", "0", input.name], () => undefined);
  const timer = setTimeout(() => {
    finished.timedOut = true;
    remove();
  }, input.limitMs);
  input.signal.addEventListener("abort", remove, { once: true });
  try {
    await closed.promise;
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", remove);
  }
  return finished;
}

/** A failed guard's or check's output: what it printed, then why it ended. */
function failedOutput(finished: Finished, limitMs: number): string {
  const ending = finished.timedOut ? `stopped after ${limitMs / 1000} s` : `exit ${finished.code ?? "by a signal"}`;
  return [finished.stdout.trimEnd(), finished.stderr.trimEnd(), ending].filter((part) => part !== "").join("\n");
}

/**
 * AUTO-8: a trigger's guard, code in the automation's folder, run in the session image with the
 * folder read-only as its working directory. Its `#!` line names its interpreter (none: `sh`).
 * Exit 0 passes, and its stdout goes on to the check and the run.
 */
export async function runGuard(options: GateOptions, input: GateInput): Promise<FiringVerdict> {
  const file = join(input.folder, input.path);
  if (!existsSync(file)) return { passed: false, output: `the automation's folder has no ${input.path}` };
  const script = `${CONTAINER_FOLDER}/${input.path}`;
  // As the kernel reads it: the interpreter, then the rest of the line as one argument.
  const shebang = /^#!\s*(\S+)(?:[ \t]+(.*\S))?/.exec(readFileSync(file, "utf8").split("\n", 1)[0] ?? "");
  const command = shebang === null ? ["sh", script] : [shebang[1], ...(shebang[2] === undefined ? [] : [shebang[2]]), script];
  const finished = await inImage(options, {
    name: `am-guard-${input.firingId}`, folder: input.folder, mounts: [], command, stdin: null, limitMs: GUARD_LIMIT_MS, signal: input.signal,
  });
  if (finished.code === 0 && !finished.timedOut) return { passed: true, output: finished.stdout };
  return { passed: false, output: failedOutput(finished, GUARD_LIMIT_MS) };
}

/** The check's answer, the last such JSON object of its reply. */
const checkAnswer = z.object({ answer: z.enum(["yes", "no"]), why: z.string() });

function checkPrompt(question: string, guardOutput: string | null): string {
  return [
    "You decide whether a run of an automation starts now. Your working directory is the automation's folder; " +
      "your tools only read: the files of the folder, and the web. Look into what the question needs, then answer it.",
    'End your reply with one line of JSON and nothing after it: {"answer": "yes", "why": "..."} or {"answer": "no", "why": "..."}, ' +
      'where "why" says in a sentence or two what decided it.',
    "# The question",
    question.trim(),
    ...(guardOutput === null ? [] : ["# What the automation's guard found", guardOutput.trim() === "" ? "(no output)" : guardOutput.trim()]),
  ].join("\n\n");
}

/**
 * AUTO-8: a trigger's check: the prompt in the automation's folder (and what its guard found),
 * answered yes or no and why by omp's `tiny` model as the user's omp settings define it, with
 * read-only tools (the folder, the web), in the session image (container/check.ts). Yes passes.
 */
export async function runCheck(options: GateOptions, input: GateInput & { guardOutput: string | null }): Promise<FiringVerdict> {
  const file = join(input.folder, input.path);
  if (!existsSync(file)) return { passed: false, output: `the automation's folder has no ${input.path}` };
  const finished = await inImage(options, {
    name: `am-check-${input.firingId}`,
    folder: input.folder,
    mounts: ["-v", `${options.ompAgentDir}:${CONTAINER_OMP_AGENT}`, "-e", `AGENTMONITOR_OMP_AGENT=${CONTAINER_OMP_AGENT}`],
    command: ["node", "/opt/agentmonitor/check.ts"],
    stdin: checkPrompt(readFileSync(file, "utf8"), input.guardOutput),
    limitMs: CHECK_LIMIT_MS,
    signal: input.signal,
  });
  if (finished.code === 0 && !finished.timedOut) {
    for (const candidate of [...finished.stdout.matchAll(/\{[^{}]*\}/g)].reverse()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(candidate[0]);
      } catch {
        continue;
      }
      const answer = checkAnswer.safeParse(parsed);
      if (answer.success) return { passed: answer.data.answer === "yes", output: answer.data.why };
    }
  }
  return { passed: false, output: `the check gave no answer:\n${failedOutput(finished, CHECK_LIMIT_MS)}` };
}
