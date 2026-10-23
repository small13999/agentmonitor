import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { watch } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let built = false;

/** Build the web app into dist/, which the gateway serves; once per test process. */
export function buildApp(): void {
  if (built) return;
  const result = spawnSync(process.execPath, [join(root, "node_modules", "vite", "bin", "vite.js"), "build", "--logLevel", "error"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status !== 0) throw new Error(`vite build failed:\n${result.stdout}${result.stderr}`);
  built = true;
}

/** A `#rrggbb` colour (a topic's, a person's) as `getComputedStyle` reports it. */
export function rgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

export interface ApiResult {
  status: number;
  body: { ok: boolean; data?: unknown; error?: string; [key: string]: unknown };
}

export interface AmResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function freePort(): Promise<number> {
  const server = createServer();
  const { promise, resolve } = Promise.withResolvers<number>();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => resolve(typeof address === "object" && address !== null ? address.port : 0));
  });
  return promise;
}

/** A real gateway process with its own state directory, driven the way the UI and agents drive it. */
export class Gateway {
  readonly stateDir: string;
  readonly url: string;
  private readonly child: ChildProcess;

  private constructor(stateDir: string, url: string, child: ChildProcess) {
    this.stateDir = stateDir;
    this.url = url;
    this.child = child;
  }

  /**
   * `runtime: "none"` keeps sessions as store records only: store claims do not need
   * containers, and starting one per session would cost seconds per test. `stateDir` starts
   * the gateway on an existing state directory, e.g. a store from an older version.
   */
  static async start(
    options: { runtime: "podman" | "none"; env?: Record<string, string>; stateDir?: string } = { runtime: "none" },
  ): Promise<Gateway> {
    const stateDir = options.stateDir ?? mkdtempSync(join(tmpdir(), "am-gw-"));
    const port = await freePort();
    const child = spawn(process.execPath, [join(root, "server", "index.ts")], {
      cwd: root,
      env: {
        ...process.env,
        AGENTMONITOR_PORT: String(port),
        AGENTMONITOR_STATE_DIR: stateDir,
        AGENTMONITOR_AUTH_MODE: "local",
        AGENTMONITOR_WORKSPACE_RUNTIME: options.runtime,
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    const { promise: listening, resolve, reject } = Promise.withResolvers<void>();
    child.stdout?.on("data", (chunk) => {
      log += chunk;
      if (log.includes("agentmonitor gateway")) resolve();
    });
    child.stderr?.on("data", (chunk) => { log += chunk; });
    child.once("exit", (code) => reject(new Error(`gateway exited with ${code}:\n${log}`)));
    const gateway = new Gateway(stateDir, `http://127.0.0.1:${port}`, child);
    try {
      await listening;
    } catch (error) {
      await gateway.stop();
      throw error;
    }
    return gateway;
  }

  async stop(): Promise<void> {
    if (this.child.exitCode === null) {
      const { promise, resolve } = Promise.withResolvers<void>();
      this.child.once("exit", () => resolve());
      this.child.kill();
      await promise;
    }
    const listed = spawnSync("podman", ["ps", "-aq", "--filter", `label=agentmonitor.state=${this.stateDir}`], { encoding: "utf8" });
    const containers = (listed.stdout ?? "").split("\n").filter(Boolean);
    if (containers.length > 0) spawnSync("podman", ["rm", "-f", "-t", "0", ...containers]);
    // Host sessions outlive the gateway; theirs find Tern's daemon in this state directory.
    for (const entry of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
      try {
        if (readFileSync(`/proc/${entry}/environ`, "latin1").split("\0").some((line) => line.startsWith(`TERN_DAEMON_SOCKET=${this.stateDir}/`))) {
          process.kill(Number(entry), "SIGKILL");
        }
      } catch {
        // Gone already, or another user's process.
      }
    }
    rmSync(this.stateDir, { recursive: true, force: true });
  }

  /** A human request through the gateway, as the web UI makes it. */
  async api(method: string, path: string, body?: unknown): Promise<ApiResult> {
    const response = await fetch(`${this.url}/api/store${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as ApiResult["body"] };
  }

  /** Like `api`, but fails the test unless the request succeeded, and returns its data. */
  async data<T>(method: string, path: string, body?: unknown): Promise<T> {
    const result = await this.api(method, path, body);
    if (!result.body.ok) throw new Error(`${method} ${path} -> ${result.status} ${result.body.error}`);
    return result.body.data as T;
  }

  /** Run the agent CLI as it runs inside the session's container: through that session's socket. */
  am(sessionId: string, args: string[], stdin = ""): AmResult {
    const result = spawnSync(process.execPath, [join(root, "container", "am.ts"), ...args], {
      input: stdin,
      encoding: "utf8",
      env: { ...process.env, AM_SOCKET: join(this.stateDir, "sessions", sessionId, "run", "am.sock") },
    });
    return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  /** The gateway's channel into a session's live omp chat, once omp has started it. */
  async omp(sessionId: string): Promise<OmpChannel> {
    return OmpChannel.open(join(this.stateDir, "sessions", sessionId, "run"));
  }
}

type ChannelMessage = Record<string, unknown>;

/** JSON-lines client for the omp extension socket: requests with ids, plus pushed events. */
export class OmpChannel {
  private readonly socket: Socket;
  private nextId = 1;
  private readonly replies = new Map<number, (message: ChannelMessage) => void>();
  private readonly waiters = new Set<{ match: (event: ChannelMessage) => boolean; resolve: (event: ChannelMessage) => void }>();

  private constructor(socket: Socket) {
    this.socket = socket;
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const message = JSON.parse(line) as ChannelMessage;
        if (typeof message.id === "number") {
          this.replies.get(message.id)?.(message);
          this.replies.delete(message.id);
          continue;
        }
        for (const waiter of this.waiters) {
          if (!waiter.match(message)) continue;
          this.waiters.delete(waiter);
          waiter.resolve(message);
        }
      }
    });
  }

  /** Resolves once omp's session has started: the extension creates its socket in session_start. */
  static async open(runDir: string): Promise<OmpChannel> {
    const path = join(runDir, "omp.sock");
    // Watch first, then check, so a socket created in between is not missed.
    const events = watch(runDir, { signal: AbortSignal.timeout(120_000) });
    if (!existsSync(path)) {
      for await (const event of events) {
        if (event.filename === "omp.sock" && existsSync(path)) break;
      }
    }
    const socket = connect(path);
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    socket.once("connect", () => resolve());
    socket.once("error", reject);
    await promise;
    return new OmpChannel(socket);
  }

  async request(op: string, fields: Record<string, unknown> = {}): Promise<ChannelMessage> {
    const id = this.nextId++;
    const { promise, resolve } = Promise.withResolvers<ChannelMessage>();
    this.replies.set(id, resolve);
    this.socket.write(`${JSON.stringify({ ...fields, id, op })}\n`);
    const reply = await promise;
    if (reply.ok !== true) throw new Error(`omp channel refused ${op}: ${String(reply.error)}`);
    return reply;
  }

  /** The next pushed event matching `match`; register before causing it. */
  event(match: (event: ChannelMessage) => boolean): Promise<ChannelMessage> {
    const { promise, resolve } = Promise.withResolvers<ChannelMessage>();
    this.waiters.add({ match, resolve });
    return promise;
  }

  close(): void {
    this.socket.destroy();
  }
}
