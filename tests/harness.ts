import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, watch as watchDir, writeFileSync } from "node:fs";
import { watch } from "node:fs/promises";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import httpProxy from "http-proxy";
import { WebSocket } from "ws";
import type { ClientMessage, OmpFrame, ServerMessage } from "../shared/chat.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// `node --test` runs each test file in its own process, all children of one runner. Each
// building dist/ itself would empty it under the gateways of the others, so the first one
// builds, under a lock, and stamps the build with the runner's pid; the others wait for it.
const buildDir = join(tmpdir(), `agentmonitor-build-${root.replaceAll(/[^a-zA-Z0-9]/g, "_")}`);
const stampFile = join(buildDir, "stamp");
const lockDir = join(buildDir, "lock");
const lockRun = join(lockDir, "run");
let built: Promise<void> | null = null;

/** Build the web app into dist/, which the gateway serves; once per test run. */
export function buildApp(): Promise<void> {
  built ??= buildOnce(String(process.ppid));
  return built;
}

async function buildOnce(run: string): Promise<void> {
  mkdirSync(buildDir, { recursive: true });
  const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : null);
  for (;;) {
    if (read(stampFile) === run) return;
    try {
      mkdirSync(lockDir);
    } catch {
      const holder = read(lockRun);
      // A lock of another run is left by one that died while building.
      if (holder !== null && holder !== run) rmSync(lockDir, { recursive: true, force: true });
      else await untilChanged(() => read(stampFile) === run || !existsSync(lockDir));
      continue;
    }
    try {
      writeFileSync(lockRun, run);
      const result = spawnSync(process.execPath, [join(root, "node_modules", "vite", "bin", "vite.js"), "build", "--logLevel", "error"], {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
      });
      if (result.status !== 0) throw new Error(`vite build failed:\n${result.stdout}${result.stderr}`);
      writeFileSync(stampFile, run);
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }
    return;
  }
}

/** Resolves once `done` holds, checked on every change in the build directory. */
function untilChanged(done: () => boolean): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const watcher = watchDir(buildDir, { recursive: true }, () => {
    if (done()) resolve();
  });
  if (done()) resolve();
  return promise.finally(() => watcher.close());
}

/** A `#rrggbb` colour (a topic's, a person's) as `getComputedStyle` reports it. */
export function rgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

/** The session image's tag in tests (AGENTMONITOR_WORKSPACE_IMAGE), so no test replaces the live one. */
export const TEST_IMAGE = "localhost/agentmonitor-workspace:test";

/** Builds the session image under the test tag; imported only now, as the tag is read when the runtime module loads. */
export async function buildTestImage(): Promise<void> {
  process.env.AGENTMONITOR_WORKSPACE_IMAGE = TEST_IMAGE;
  const { buildImage } = await import("../scripts/build-image.ts");
  buildImage({ quiet: true });
}

/** A 2×1 PNG: a red pixel and a blue one. */
export function png(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 0, 0, 255]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
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

/**
 * AUTO-2: `clock` is the time the gateway's clock (AGENTMONITOR_CLOCK_FILE) stands at when it
 * starts; by default the real time then. It stands still until a test moves it with `setClock`,
 * so no test fires a trigger by the real clock, and runs' time limits (AUTO-14) hold.
 */
export type GatewayOptions = { runtime: "podman" | "none"; env?: Record<string, string>; stateDir?: string; hub?: boolean; clock?: string };

/** A real gateway process with its own state directory, driven the way the UI and agents drive it. */
export class Gateway {
  readonly stateDir: string;
  readonly url: string;
  private child: ChildProcess;
  private readonly env: NodeJS.ProcessEnv;
  /** Everything the gateway printed so far, across restarts. */
  private log = "";
  private logWaiters: Array<{ pattern: RegExp; resolve: (line: string) => void }> = [];

  private constructor(stateDir: string, url: string, child: ChildProcess, env: NodeJS.ProcessEnv) {
    this.stateDir = stateDir;
    this.url = url;
    this.child = child;
    this.env = env;
  }

  /**
   * `runtime: "none"` keeps sessions as store records only: store claims do not need
   * containers, and starting one per session would cost seconds per test. `stateDir` starts
   * the gateway on an existing state directory, e.g. a store from an older version. `hub`
   * names its hosts as a hub's (shared/hosts.ts) under `localhost`: its UI, which `url` names,
   * is `http://am.localhost:<port>`.
   */
  static async start(options: GatewayOptions = { runtime: "none" }): Promise<Gateway> {
    const stateDir = options.stateDir ?? mkdtempSync(join(tmpdir(), "am-gw-"));
    const clock = join(stateDir, "test-clock");
    if (!existsSync(clock)) writeFileSync(clock, options.clock ?? new Date().toISOString());
    const port = await freePort();
    const url = options.hub === true ? `http://am.localhost:${port}` : `http://127.0.0.1:${port}`;
    const env = {
      ...process.env,
      AGENTMONITOR_PORT: String(port),
      AGENTMONITOR_STATE_DIR: stateDir,
      AGENTMONITOR_AUTH_MODE: "local",
      AGENTMONITOR_WORKSPACE_RUNTIME: options.runtime,
      AGENTMONITOR_WORKSPACE_IMAGE: TEST_IMAGE,
      // Never the user's settings, e.g. the hubs of their hubs.json (STORE-3).
      AGENTMONITOR_CONFIG_DIR: join(stateDir, "config"),
      AGENTMONITOR_CLOCK_FILE: clock,
      ...(options.hub === true ? { AGENTMONITOR_PUBLIC_ORIGIN: url } : {}),
      ...options.env,
    };
    const child = spawn(process.execPath, [join(root, "server", "index.ts")], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    const gateway = new Gateway(stateDir, url, child, env);
    try {
      await gateway.listening();
    } catch (error) {
      await gateway.stop();
      throw error;
    }
    return gateway;
  }

  /** Takes in what the gateway's current process prints; resolves once it says it listens, fails if it exits first. */
  private async listening(): Promise<void> {
    const started = this.log.length;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const append = (chunk: string) => {
      this.log += chunk;
      if (this.log.slice(started).includes("agentmonitor gateway")) resolve();
      this.logWaiters = this.logWaiters.filter(({ pattern, resolve: found }) => {
        const line = this.loggedLine(pattern);
        if (line !== undefined) found(line);
        return line === undefined;
      });
    };
    this.child.stdout?.setEncoding("utf8").on("data", append);
    this.child.stderr?.setEncoding("utf8").on("data", append);
    // Once it listens, its exit (a stop, a restart) settles nothing.
    this.child.once("exit", (code) => reject(new Error(`gateway exited with ${code}:\n${this.log.slice(started)}`)));
    await promise;
  }

  private loggedLine(pattern: RegExp): string | undefined {
    return this.log.split("\n").find((line) => pattern.test(line));
  }

  /** Resolves with the first line the gateway printed, so far or from now on, that `pattern` matches. */
  logged(pattern: RegExp): Promise<string> {
    const line = this.loggedLine(pattern);
    if (line !== undefined) return Promise.resolve(line);
    const { promise, resolve } = Promise.withResolvers<string>();
    this.logWaiters.push({ pattern, resolve });
    return promise;
  }

  /** AUTO-2: moves the time the gateway's scheduler reads, which it fires on at once (written whole, by a rename). */
  setClock(iso: string): void {
    const clock = join(this.stateDir, "test-clock");
    writeFileSync(`${clock}.new`, iso);
    renameSync(`${clock}.new`, clock);
  }

  private async kill(): Promise<void> {
    // A gateway already stopped (by a test, then again after it) exited on its signal: no exit code.
    if (this.child.exitCode === null && this.child.signalCode === null) {
      const { promise, resolve } = Promise.withResolvers<void>();
      this.child.once("exit", () => resolve());
      this.child.kill();
      await promise;
    }
  }

  /**
   * Stops the gateway's process and starts it again on the same state, port, and settings;
   * sessions go on running meanwhile. `clock`: the time it is when it is back (AUTO-2: downtime).
   */
  async restart(clock?: string): Promise<void> {
    await this.kill();
    if (clock !== undefined) this.setClock(clock);
    this.child = spawn(process.execPath, [join(root, "server", "index.ts")], { cwd: root, env: this.env, stdio: ["ignore", "pipe", "pipe"] });
    await this.listening();
  }

  async stop(): Promise<void> {
    await this.kill();
    const listed = spawnSync("podman", ["ps", "-aq", "--filter", `label=agentmonitor.state=${this.stateDir}`], { encoding: "utf8" });
    const containers = (listed.stdout ?? "").split("\n").filter(Boolean);
    if (containers.length > 0) spawnSync("podman", ["rm", "-f", "-t", "0", ...containers]);
    // Host sessions outlive the gateway; each of their processes carries its session's id.
    const sessionsDir = join(this.stateDir, "sessions");
    const markers = new Set(existsSync(sessionsDir) ? readdirSync(sessionsDir).map((id) => `AGENTMONITOR_SESSION=${id}`) : []);
    for (const entry of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
      try {
        if (readFileSync(`/proc/${entry}/environ`, "latin1").split("\0").some((line) => markers.has(line))) {
          process.kill(Number(entry), "SIGKILL");
        }
      } catch {
        // Gone already, or another user's process.
      }
    }
    rmSync(this.stateDir, { recursive: true, force: true });
  }

  /** A human request through the gateway, as the web UI makes it; `headers` carry e.g. an Access token. */
  async api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResult> {
    const response = await fetch(`${this.url}/api/store${path}`, {
      method,
      headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as ApiResult["body"] };
  }

  /** Like `api`, but fails the test unless the request succeeded, and returns its data. */
  async data<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const result = await this.api(method, path, body, headers);
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

  /**
   * CHAT-1: a page's socket on the session's chat, through the gateway, from the UI's origin
   * unless `origin` says another; resolves once the chat's snapshot arrived.
   */
  async chat(sessionId: string, options: { origin?: string; headers?: Record<string, string> } = {}): Promise<ChatClient> {
    const url = `${this.url.replace(/^http/, "ws")}/api/store/sessions/${sessionId}/chat`;
    const chat = await ChatClient.open(url, options.origin ?? this.url, options.headers ?? {});
    try {
      await chat.seen((message) => message.type === "snapshot");
    } catch (error) {
      chat.close();
      throw error;
    }
    return chat;
  }
}

/**
 * Cloudflare's tunnel in front of a hub, as the browser and the gateway see it: TLS ends before
 * the gateway, which gets the browser's Host and, with `edge`, the headers Access's edge adds
 * (its token). Chromium reaches it under the hub's names with `chromeArgs`, in a context that
 * accepts its self-signed certificate (`ignoreHTTPSErrors`).
 */
export class Tunnel {
  readonly port: number;
  private readonly server: HttpsServer;

  private constructor(port: number, server: HttpsServer) {
    this.port = port;
    this.server = server;
  }

  static async start(gateway: Gateway, edge: () => Record<string, string> = () => ({})): Promise<Tunnel> {
    const dir = mkdtempSync(join(tmpdir(), "am-tunnel-"));
    const made = spawnSync("openssl", [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1",
      "-subj", "/CN=tunnel", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
    ], { encoding: "utf8" });
    if (made.status !== 0) throw new Error(`openssl failed:\n${made.stderr}`);
    const tls = { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) };
    rmSync(dir, { recursive: true, force: true });
    const proxy = httpProxy.createProxyServer({ target: `http://127.0.0.1:${new URL(gateway.url).port}` });
    const server = createHttpsServer(tls, (request, response) => proxy.web(request, response, { headers: edge() }));
    server.on("upgrade", (request, socket, head) => proxy.ws(request, socket, head, { headers: edge() }));
    const { promise, resolve } = Promise.withResolvers<number>();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
    return new Tunnel(await promise, server);
  }

  /** Chromium's arguments that send every name under `zone` to the tunnel. */
  chromeArgs(zone: string): string[] {
    return [`--host-resolver-rules=MAP *.${zone} 127.0.0.1:${this.port}`];
  }

  async stop(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.server.close(() => resolve());
    this.server.closeAllConnections();
    await promise;
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

type ChatResponse = Extract<ServerMessage, { type: "response" }>;

function isServerMessage(value: unknown): value is ServerMessage {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

/** A page's WebSocket on a session's chat (shared/chat.ts): what it sent, what it received, and waits on both. */
export class ChatClient {
  /** Every message received so far, in order. */
  readonly received: ServerMessage[] = [];
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly waiters = new Set<{ match: (message: ServerMessage) => boolean; resolve: (message: ServerMessage) => void; reject: (error: Error) => void }>();
  private closedWith: Error | null = null;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (data) => {
      const message: unknown = JSON.parse(data.toString());
      if (!isServerMessage(message)) throw new Error(`not a chat message: ${data.toString()}`);
      this.received.push(message);
      for (const waiter of this.waiters) {
        if (!waiter.match(message)) continue;
        this.waiters.delete(waiter);
        waiter.resolve(message);
      }
    });
    socket.on("close", (code, reason) => {
      this.closedWith = new Error(`the chat closed with ${code} ${reason.toString()}`);
      for (const waiter of this.waiters) waiter.reject(this.closedWith);
      this.waiters.clear();
    });
  }

  /** Resolves once the socket is open; a refused upgrade fails with its status, e.g. "chat refused: 403". */
  static async open(url: string, origin: string, headers: Record<string, string>): Promise<ChatClient> {
    const socket = new WebSocket(url, { origin, headers });
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    socket.once("open", () => resolve());
    socket.once("unexpected-response", (request, response) => {
      request.destroy();
      reject(new Error(`chat refused: ${response.statusCode}`));
    });
    socket.once("error", reject);
    await promise;
    return new ChatClient(socket);
  }

  /** The next message from now on that matches; register before causing it. Fails if the chat closes first. */
  next(match: (message: ServerMessage) => boolean): Promise<ServerMessage> {
    if (this.closedWith !== null) return Promise.reject(this.closedWith);
    const { promise, resolve, reject } = Promise.withResolvers<ServerMessage>();
    this.waiters.add({ match, resolve, reject });
    return promise;
  }

  /** The first message, received so far or from now on, that matches. */
  seen(match: (message: ServerMessage) => boolean): Promise<ServerMessage> {
    const found = this.received.find(match);
    return found === undefined ? this.next(match) : Promise.resolve(found);
  }

  send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  /** Sends an omp RPC command as the page would; resolves with its response, failing if omp refused it. */
  async rpc(command: OmpFrame): Promise<ChatResponse> {
    const id = `test-${this.nextId++}`;
    const answered = this.next((message) => message.type === "response" && message.id === id);
    this.send({ type: "rpc", id, command });
    const response = await answered;
    if (response.type !== "response" || !response.success) throw new Error(`omp refused ${command.type}: ${JSON.stringify(response)}`);
    return response;
  }

  close(): void {
    this.socket.close();
  }
}
