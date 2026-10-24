import { spawn } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { writeLaunchFiles, type LaunchInput, type Runtime, type WorkspaceDirs } from "./runtime.ts";

/** host-entry.ts and what it shares with the container image. */
const SOURCE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "container");
/** How long a session's processes get to exit on SIGTERM before SIGKILL. */
const STOP_MS = 5_000;
/** What launch writes next to launch.json: the entry's pid. */
const hostState = z.object({ pid: z.int() });

/** Processes started for the session: they all carry its AGENTMONITOR_SESSION. */
function sessionPids(sessionId: string): number[] {
  const marker = `AGENTMONITOR_SESSION=${sessionId}`;
  const pids: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      if (readFileSync(`/proc/${entry}/environ`, "latin1").split("\0").includes(marker)) pids.push(Number(entry));
    } catch {
      // Gone already, or another user's process.
    }
  }
  return pids;
}

function signal(pids: number[], name: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, name);
    } catch {
      // Exited meanwhile.
    }
  }
}

/**
 * The gateway's environment minus what is its own: its AGENTMONITOR_* settings (an agent
 * running Agent Monitor in its worktree would otherwise share the live store) and what
 * `npm run` added.
 */
function sessionEnv(sessionId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("AGENTMONITOR_") || key.startsWith("npm_") || key === "INIT_CWD") continue;
    env[key] = value;
  }
  env.PATH = (process.env.PATH ?? "").split(":").filter((dir) => !dir.includes("node_modules")).join(":");
  env.AGENTMONITOR_SESSION = sessionId;
  env.NODE_NO_WARNINGS = "1";
  return env;
}

/**
 * HOST-2: sessions whose agent runs on this machine as the user, in its own worktree, with
 * the user's credentials and tools and nothing in between. Each session's processes carry
 * its AGENTMONITOR_SESSION, so ending it stops every one of them, servers the agent started
 * included. Like containers, they outlive a gateway restart.
 */
export class HostRuntime implements Runtime {
  private readonly options: { ompAgentDir: string; dirs: (sessionId: string) => WorkspaceDirs };

  constructor(options: { ompAgentDir: string; dirs: (sessionId: string) => WorkspaceDirs }) {
    this.options = options;
  }

  async launch(input: LaunchInput): Promise<void> {
    await this.remove(input.sessionId);
    const cwd = input.checkout ? input.repoPath : input.dirs.worktree;
    writeLaunchFiles(input, { cwd, agentFolder: realpathSync(input.folder) });
    if (input.checkout) {
      // HOST-7: the checkout's chats are the user's, as for omp in a terminal there: /resume
      // lists them, and the session's own chats join them.
      const chats = join(input.dirs.ompHome, "agent", "sessions");
      if (lstatSync(chats, { throwIfNoEntry: false }) === undefined) {
        mkdirSync(join(this.options.ompAgentDir, "sessions"), { recursive: true });
        mkdirSync(dirname(chats), { recursive: true });
        symlinkSync(join(this.options.ompAgentDir, "sessions"), chats);
      }
    }
    const log = openSync(join(input.dirs.run, "host.log"), "a");
    try {
      const entry = spawn(process.execPath, [
        join(SOURCE, "host-entry.ts"), input.dirs.run, join(input.dirs.ompHome, "agent"), this.options.ompAgentDir,
      ], { cwd, detached: true, stdio: ["ignore", log, log], env: sessionEnv(input.sessionId) });
      if (entry.pid === undefined) throw new Error("could not start the host session's entry");
      entry.unref();
      writeFileSync(join(input.dirs.run, "host.json"), JSON.stringify({ pid: entry.pid }));
    } finally {
      closeSync(log);
    }
  }

  async running(sessionId: string): Promise<boolean> {
    const file = join(this.options.dirs(sessionId).run, "host.json");
    if (!existsSync(file)) return false;
    const { pid } = hostState.parse(JSON.parse(readFileSync(file, "utf8")));
    return sessionPids(sessionId).includes(pid);
  }

  async remove(sessionId: string): Promise<void> {
    signal(sessionPids(sessionId), "SIGTERM");
    for (const deadline = Date.now() + STOP_MS; sessionPids(sessionId).length > 0 && Date.now() < deadline;) await sleep(100);
    signal(sessionPids(sessionId), "SIGKILL");
    rmSync(join(this.options.dirs(sessionId).run, "host.json"), { force: true });
  }
}
