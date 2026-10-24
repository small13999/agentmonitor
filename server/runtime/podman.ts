import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { git } from "../git.ts";
import { writeLaunchFiles, type LaunchInput, type Runtime } from "./runtime.ts";

const run = promisify(execFile);

/**
 * Built by scripts/build-image.ts. AGENTMONITOR_WORKSPACE_IMAGE names another tag, so tests
 * build and run their own image and never replace the one the live gateway runs.
 */
export const WORKSPACE_IMAGE = process.env.AGENTMONITOR_WORKSPACE_IMAGE ?? "localhost/agentmonitor-workspace:dev";

/** FOLDER-3: where a session container has its task's folder: beside the worktree, outside git. */
export const CONTAINER_FOLDER = "/task-folder";

/** The user's git credentials a session container gets: host path under the credentials home → mount point. */
const CREDENTIALS: Array<[string, string]> = [
  [".ssh", "/host-credentials/ssh"],
  [".gitconfig", "/host-credentials/gitconfig"],
  [join(".config", "gh"), "/host-credentials/gh"],
];

/**
 * Session containers run directly under rootless podman, as the host user, with:
 * the worktree at /workspace/<repo>, the repository's .git at its host path (worktree
 * metadata uses absolute paths), the run directory, the task's folder, a per-session omp home, the
 * configured omp agent directory for credentials, and the user's ssh keys, git config and
 * gh login (read-only; the entrypoint copies them). Never podman.
 */
export class PodmanRuntime implements Runtime {
  private readonly options: { memoryMib: number; stateDir: string; ompAgentDir: string; credentialsHome: string };

  constructor(options: { memoryMib: number; stateDir: string; ompAgentDir: string; credentialsHome: string }) {
    this.options = options;
  }

  containerName(sessionId: string): string {
    return `am-${sessionId}`;
  }

  /** Starts the session's container, replacing a stopped one of the same name. */
  async launch(input: LaunchInput): Promise<void> {
    if (input.checkout) throw new Error("a container works in a worktree, never the main checkout");
    const repoName = basename(resolve(input.repoPath));
    const commonDir = resolve(input.repoPath, await git(input.repoPath, ["rev-parse", "--git-common-dir"]));
    writeLaunchFiles(input, { cwd: `/workspace/${repoName}`, agentFolder: CONTAINER_FOLDER });
    await run("podman", ["rm", "-f", "--ignore", this.containerName(input.sessionId)]);
    await run("podman", [
      "run", "-d", "--init",
      "--name", this.containerName(input.sessionId),
      "--label", `agentmonitor.session=${input.sessionId}`,
      // Names the gateway that owns the container, so a gateway's containers can be found without its store.
      "--label", `agentmonitor.state=${this.options.stateDir}`,
      "--userns=keep-id",
      // ssh takes the home from passwd, not from the environment.
      "--passwd-entry", "$USERNAME:*:$UID:$GID::/home/agent:/bin/bash",
      "--memory", `${this.options.memoryMib}m`, "--memory-swap", `${this.options.memoryMib}m`,
      "-v", `${input.dirs.worktree}:/workspace/${repoName}`,
      "-v", `${commonDir}:${commonDir}`,
      "-v", `${input.dirs.run}:/run/agentmonitor`,
      "-v", `${input.folder}:${CONTAINER_FOLDER}`,
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

  async remove(sessionId: string): Promise<void> {
    await run("podman", ["rm", "-f", "--ignore", "-t", "5", this.containerName(sessionId)]);
  }
}
