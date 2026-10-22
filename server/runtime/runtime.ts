import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Where a session keeps its state on the gateway's machine. `omp-home` holds its chats and
 * outlives the session; the rest is its workspace. `run` holds what the gateway and the
 * session's processes share: launch.json, sockets, Tern's token.
 */
export interface WorkspaceDirs {
  root: string;
  run: string;
  worktree: string;
  ompHome: string;
}

export interface LaunchInput {
  /** HOST-6: the agent works in repoPath itself, the main checkout, instead of dirs.worktree; host sessions only. */
  checkout: boolean;
  sessionId: string;
  repoPath: string;
  dirs: WorkspaceDirs;
  /** omp model for the chat; null: omp's default. */
  model: string | null;
  /** omp chat (omp session id) to resume; null: a new chat. */
  resume: string | null;
  /** Origin the session's Tern web socket accepts; the gateway's Tern proxy presents it. */
  ternOrigin: string;
  /** Point Wrangler at the gateway's Cloudflare broker (the project has Cloudflare tokens). */
  cloudflare: boolean;
  /** TASK-6: markdown the session adds to the agent's workflow context: the task as it is at launch. */
  taskContext: string;
}

/** Where a session's agent runs (HOST-1): each start replaces whatever ran before. */
export interface Runtime {
  launch(input: LaunchInput): Promise<void>;
  running(sessionId: string): Promise<boolean>;
  /** The loopback address the session's Tern web client listens on, e.g. 127.0.0.1:41234. */
  ternAddress(sessionId: string): Promise<string>;
  /** Stops the session's processes; its directories stay. */
  remove(sessionId: string): Promise<void>;
}

/**
 * What every runtime's session start reads from the run directory: Tern's token, the task
 * context, and launch.json (the omp chat and Tern's origin, plus what the runtime adds).
 */
export function writeLaunchFiles(input: LaunchInput, launch: Record<string, unknown>): void {
  mkdirSync(input.dirs.ompHome, { recursive: true });
  writeFileSync(join(input.dirs.run, "tern-token"), randomBytes(32).toString("hex"), { mode: 0o600 });
  writeFileSync(join(input.dirs.run, "task.md"), input.taskContext);
  writeFileSync(join(input.dirs.run, "launch.json"), JSON.stringify({
    model: input.model,
    resume: input.resume,
    ternOrigin: input.ternOrigin,
    cloudflare: input.cloudflare,
    ...launch,
  }));
}
