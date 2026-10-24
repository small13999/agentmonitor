import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Where a session keeps its state on the gateway's machine. `omp-home` holds its chats and
 * outlives the session; the rest is its workspace. `run` holds what the gateway and the
 * session's processes share: launch.json, task.md, and the sockets (chat.sock, omp.sock, am.sock).
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
  /** FOLDER-3, AUTO-1: the folder of the session's task or automation on this machine; a container gets it at CONTAINER_FOLDER, a host session's agent uses it where it is. */
  folder: string;
  /** omp model for the chat; null: omp's default. */
  model: string | null;
  /** omp chat (omp session id) to resume; null: a new chat. */
  resume: string | null;
  /** AUTO-9: the new chat's first prompt, sent as it starts; null: the chat waits for a person. */
  prompt: string | null;
  /** Point Wrangler at the gateway's Cloudflare broker (the project has Cloudflare tokens). */
  cloudflare: boolean;
  /** TASK-6, AUTO-9: markdown the session adds to the agent's workflow context: its task, or its automation and run, as they are at launch. */
  taskContext: string;
}

/** Where a session's agent runs (HOST-1): each start replaces whatever ran before. */
export interface Runtime {
  launch(input: LaunchInput): Promise<void>;
  running(sessionId: string): Promise<boolean>;
  /** Stops the session's processes; its directories stay. */
  remove(sessionId: string): Promise<void>;
}

/**
 * What every runtime's session start reads from the run directory: the task context, and
 * launch.json (the omp chat, plus where the agent works and finds its folder, as the runtime
 * says) for container/launch.ts.
 */
export function writeLaunchFiles(input: LaunchInput, paths: { cwd: string; agentFolder: string }): void {
  mkdirSync(input.dirs.ompHome, { recursive: true });
  writeFileSync(join(input.dirs.run, "task.md"), input.taskContext);
  writeFileSync(join(input.dirs.run, "launch.json"), JSON.stringify({
    cwd: paths.cwd,
    model: input.model,
    resume: input.resume,
    prompt: input.prompt,
    agentFolder: paths.agentFolder,
    cloudflare: input.cloudflare,
  }));
}
