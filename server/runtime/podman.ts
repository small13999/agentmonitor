import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { git } from "../git.ts";

const run = promisify(execFile);

/** Built by scripts/build-image.ts. */
export const WORKSPACE_IMAGE = "localhost/agentmonitor-workspace:dev";

/**
 * Where a session keeps its host-side state. `omp-home` holds its chats and outlives the
 * session; the rest is its workspace. `run` is mounted at /run/agentmonitor.
 */
export interface WorkspaceDirs {
  root: string;
  run: string;
  worktree: string;
  ompHome: string;
}

export interface LaunchInput {
  sessionId: string;
  repoPath: string;
  dirs: WorkspaceDirs;
  /** omp model for the chat; null: omp's default. */
  model: string | null;
  /** omp chat (omp session id) to resume; null: a new chat. */
  resume: string | null;
  /** Origin the container's Tern web socket accepts; the gateway's Tern proxy presents it. */
  ternOrigin: string;
  /** Point Wrangler at the gateway's Cloudflare broker (the project has Cloudflare tokens). */
  cloudflare: boolean;
  /** TASK-6: markdown the container adds to the agent's workflow context: the task as it is at launch. */
  taskContext: string;
}

/** The user's git credentials a session container gets: host path under the credentials home → mount point. */
const CREDENTIALS: Array<[string, string]> = [
  [".ssh", "/host-credentials/ssh"],
  [".gitconfig", "/host-credentials/gitconfig"],
  [join(".config", "gh"), "/host-credentials/gh"],
];

/**
 * Session containers run directly under rootless podman, as the host user, with:
 * the worktree at /workspace/<repo>, the repository's .git at its host path (worktree
 * metadata uses absolute paths), the run directory, a per-session omp home, the
 * configured omp agent directory for credentials, and the user's ssh keys, git config and
 * gh login (read-only; the entrypoint copies them). Never podman.
 */
export class PodmanRuntime {
  private readonly options: { memoryMib: number; stateDir: string; ompAgentDir: string; credentialsHome: string };

  constructor(options: { memoryMib: number; stateDir: string; ompAgentDir: string; credentialsHome: string }) {
    this.options = options;
  }

  containerName(sessionId: string): string {
    return `am-${sessionId}`;
  }

  /** Starts the session's container, replacing a stopped one of the same name. */
  async launch(input: LaunchInput): Promise<void> {
    const repoName = basename(resolve(input.repoPath));
    const commonDir = resolve(input.repoPath, await git(input.repoPath, ["rev-parse", "--git-common-dir"]));
    mkdirSync(input.dirs.ompHome, { recursive: true });
    writeFileSync(join(input.dirs.run, "tern-token"), randomBytes(32).toString("hex"), { mode: 0o600 });
    writeFileSync(join(input.dirs.run, "task.md"), input.taskContext);
    writeFileSync(join(input.dirs.run, "launch.json"), JSON.stringify({
      cwd: `/workspace/${repoName}`,
      model: input.model,
      resume: input.resume,
      ternOrigin: input.ternOrigin,
      cloudflare: input.cloudflare,
    }));
    await run("podman", ["rm", "-f", "--ignore", this.containerName(input.sessionId)]);
    await run("podman", [
      "run", "-d", "--init",
      "--name", this.containerName(input.sessionId),
      "--label", `agentmonitor.session=${input.sessionId}`,
      // Names the gateway that owns the container, so a gateway's containers can be found without its store.
      "--label", `agentmonitor.state=${this.options.stateDir}`,
      "--userns=keep-id",
      // Tern panes take HOME from passwd, not from the environment.
      "--passwd-entry", "$USERNAME:*:$UID:$GID::/home/agent:/bin/bash",
      "--memory", `${this.options.memoryMib}m`, "--memory-swap", `${this.options.memoryMib}m`,
      "-p", "127.0.0.1::8377",
      "-v", `${input.dirs.worktree}:/workspace/${repoName}`,
      "-v", `${commonDir}:${commonDir}`,
      "-v", `${input.dirs.run}:/run/agentmonitor`,
      "-v", `${input.dirs.ompHome}:/home/agent/.omp`,
      "-v", `${this.options.ompAgentDir}:/host-omp-agent`,
      ...CREDENTIALS.flatMap(([path, mount]) => {
        const source = join(this.options.credentialsHome, path);
        return existsSync(source) ? ["-v", `${source}:${mount}:ro`] : [];
      }),
      WORKSPACE_IMAGE,
    ]);
  }

  async running(sessionId: string): Promise<boolean> {
    try {
      const { stdout } = await run("podman", ["inspect", "--format", "{{.State.Running}}", this.containerName(sessionId)]);
      return stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  /** The loopback address podman published the container's Tern web client on, e.g. 127.0.0.1:41234. */
  async ternAddress(sessionId: string): Promise<string> {
    const { stdout } = await run("podman", ["port", this.containerName(sessionId), "8377/tcp"], { encoding: "utf8" });
    const address = stdout.trim().split("\n")[0] ?? "";
    if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error(`unexpected Tern address "${address}" for ${this.containerName(sessionId)}`);
    return address;
  }

  async removeContainer(sessionId: string): Promise<void> {
    await run("podman", ["rm", "-f", "--ignore", "-t", "5", this.containerName(sessionId)]);
  }
}
