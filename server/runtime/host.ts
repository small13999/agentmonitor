import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { writeLaunchFiles, type LaunchInput, type Runtime, type WorkspaceDirs } from "./runtime.ts";

const run = promisify(execFile);

/** host-entry.ts and what it shares with the container image. */
const SOURCE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "container");
/** How long a session's processes get to exit on SIGTERM before SIGKILL. */
const STOP_MS = 5_000;
/** What launch writes next to launch.json: the entry's pid and Tern's port. */
const hostState = z.object({ pid: z.int(), port: z.int() });

async function freePort(): Promise<number> {
  const server = createServer();
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  server.close();
  if (address === null || typeof address === "string") throw new Error("no free loopback port");
  return address.port;
}

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
function sessionEnv(sessionId: string, runDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("AGENTMONITOR_") || key.startsWith("npm_") || key === "INIT_CWD") continue;
    env[key] = value;
  }
  env.PATH = (process.env.PATH ?? "").split(":").filter((dir) => !dir.includes("node_modules")).join(":");
  env.AGENTMONITOR_SESSION = sessionId;
  env.TERN_DAEMON_SOCKET = join(runDir, "tern-daemon.sock");
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
  private readonly options: { stateDir: string; ompAgentDir: string; dirs: (sessionId: string) => WorkspaceDirs };
  private assets: Promise<string> | null = null;

  constructor(options: { stateDir: string; ompAgentDir: string; dirs: (sessionId: string) => WorkspaceDirs }) {
    this.options = options;
  }

  async launch(input: LaunchInput): Promise<void> {
    await this.remove(input.sessionId);
    const ternAssets = await this.ternAssets();
    const port = await freePort();
    writeLaunchFiles(input, { cwd: input.dirs.worktree, ternListen: `127.0.0.1:${port}` });
    const log = openSync(join(input.dirs.run, "host.log"), "a");
    try {
      const entry = spawn(process.execPath, [
        join(SOURCE, "host-entry.ts"), input.dirs.run, join(input.dirs.ompHome, "agent"), this.options.ompAgentDir, ternAssets,
      ], { cwd: input.dirs.worktree, detached: true, stdio: ["ignore", log, log], env: sessionEnv(input.sessionId, input.dirs.run) });
      if (entry.pid === undefined) throw new Error("could not start the host session's entry");
      entry.unref();
      writeFileSync(join(input.dirs.run, "host.json"), JSON.stringify({ pid: entry.pid, port }));
    } finally {
      closeSync(log);
    }
  }

  private state(sessionId: string): { pid: number; port: number } | null {
    const file = join(this.options.dirs(sessionId).run, "host.json");
    return existsSync(file) ? hostState.parse(JSON.parse(readFileSync(file, "utf8"))) : null;
  }

  async running(sessionId: string): Promise<boolean> {
    const state = this.state(sessionId);
    return state !== null && sessionPids(sessionId).includes(state.pid);
  }

  async ternAddress(sessionId: string): Promise<string> {
    const state = this.state(sessionId);
    if (state === null || !sessionPids(sessionId).includes(state.pid)) throw new Error("the host session is not running");
    return `127.0.0.1:${state.port}`;
  }

  async remove(sessionId: string): Promise<void> {
    signal(sessionPids(sessionId), "SIGTERM");
    for (const deadline = Date.now() + STOP_MS; sessionPids(sessionId).length > 0 && Date.now() < deadline;) await sleep(100);
    signal(sessionPids(sessionId), "SIGKILL");
    rmSync(join(this.options.dirs(sessionId).run, "host.json"), { force: true });
  }

  /** Tern's web client for this tern version, stored once per state directory. */
  private ternAssets(): Promise<string> {
    this.assets ??= (async () => {
      const { stdout } = await run("tern", ["--version"], { encoding: "utf8" });
      const dir = join(this.options.stateDir, "tern-web", stdout.trim().replace(/[^\w.-]+/g, "_"));
      if (existsSync(join(dir, "index.html"))) return dir;
      const staging = `${dir}.staging-${process.pid}`;
      rmSync(staging, { recursive: true, force: true });
      await run(process.execPath, [join(SOURCE, "tern-web-assets.ts"), staging], { timeout: 300_000 });
      renameSync(staging, dir);
      return dir;
    })().catch((cause: unknown) => {
      this.assets = null;
      throw cause;
    });
    return this.assets;
  }
}
