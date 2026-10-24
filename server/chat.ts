import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { z } from "zod";
import type { ClientMessage, ServerMessage } from "../shared/chat.ts";
import { validHost, validOrigin, type Auth } from "./auth.ts";
import type { GatewayConfig } from "./config.ts";
import type { Hubs } from "./hubs.ts";
import type { StoreService } from "./store/service.ts";
import { StoreError, type Principal } from "./store/store.ts";

/** The chat host's socket in a session's run directory (container/chat-host.ts). */
export const CHAT_SOCKET = "chat.sock";
/** The largest message either way: a snapshot or a prompt carries images as base64. */
export const CHAT_MESSAGE_BYTES = 64 * 1024 * 1024;
/** How long a started session gets until its chat host answers. */
const CHAT_START_MS = 60_000;
/** How long omp gets to take a prompt the gateway sends (it answers once the prompt is queued or running). */
const PROMPT_MS = 30_000;
/** Unsent bytes toward one side, past which the other side is not read until they are out; the chat host drops a page that falls far behind. */
const HIGH_WATER = 8 * 1024 * 1024;
/** Cloudflare's tunnel closes a socket idle for 100 s; a ping keeps a quiet chat open. */
const PING_MS = 30_000;
/** A WebSocket close reason is at most 123 bytes. */
const REASON_BYTES = 123;

const OWN_CHAT = /^\/api\/store\/sessions\/([0-9a-f-]{36})\/chat$/;
const HUB_CHAT = /^\/api\/hubs\/([^/]+)\/store\/sessions\/([0-9a-f-]{36})\/chat$/;

/** Calls `line` with each `\n`-terminated line the socket reads, without the newline. */
function readLines(socket: Socket, line: (bytes: Buffer) => void): void {
  let pending: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => {
    let start = 0;
    for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
      pending.push(chunk.subarray(start, end));
      const bytes = pending.length === 1 ? pending[0] : Buffer.concat(pending);
      pending = [];
      start = end + 1;
      if (bytes.length > 0) line(bytes);
    }
    if (start < chunk.length) pending.push(chunk.subarray(start));
  });
}

function bytesOf(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
}

/**
 * Closes the page's socket unless it is closing already. 4404 and 4409 are the store's 404 and
 * 409 (an unknown or ended session, a session that cannot start); 1012 says the chat went away and
 * the page connects again.
 */
function closePage(page: WebSocket, code: number, reason: string): void {
  if (page.readyState === WebSocket.CLOSING || page.readyState === WebSocket.CLOSED) return;
  let text = reason;
  while (Buffer.byteLength(text) > REASON_BYTES) text = text.slice(0, -2);
  page.close(code, text);
}

/** The close code for a failure: a store refusal as 4000 + its status, anything else as the gateway's own failure. */
function failureClose(cause: unknown): { code: number; reason: string } {
  if (cause instanceof StoreError) return { code: 4000 + cause.status, reason: cause.message };
  console.error("chat failed", cause);
  return { code: 1011, reason: "internal error" };
}

function sendStatus(page: WebSocket, text: string): void {
  const message: ServerMessage = { type: "status", text };
  if (page.readyState === WebSocket.OPEN) page.send(JSON.stringify(message));
}

/**
 * A page's text message as a line for chat.sock. A message is one JSON object; one with line
 * breaks in it (pretty-printed) is written again on one line, so it stays one line. Binary
 * messages and other text close the page's socket (null).
 */
function chatLine(page: WebSocket, data: RawData, isBinary: boolean): Buffer | null {
  if (isBinary) {
    closePage(page, 1003, "the chat takes text messages only");
    return null;
  }
  const bytes = bytesOf(data);
  if (!bytes.includes(10)) return Buffer.concat([bytes, Buffer.from("\n")]);
  try {
    return Buffer.from(`${JSON.stringify(JSON.parse(bytes.toString("utf8")))}\n`);
  } catch {
    closePage(page, 1007, "a chat message is one JSON object");
    return null;
  }
}

/** Keeps what the page sends until its chat is there; `stop` hands it over and stops keeping. */
function keepEarly(page: WebSocket): { stop(): Buffer[] } {
  const early: Buffer[] = [];
  const keep = (data: RawData, isBinary: boolean) => {
    const line = chatLine(page, data, isBinary);
    if (line !== null) early.push(line);
  };
  page.on("message", keep);
  return {
    stop() {
      page.off("message", keep);
      return early;
    },
  };
}

/** Pipes the page's socket and the chat host's socket, line for message, both ways; reads from either side wait while the other is behind. */
function pipeChat(page: WebSocket, chat: Socket, early: Buffer[]): void {
  for (const line of early) chat.write(line);
  page.on("message", (data, isBinary) => {
    const line = chatLine(page, data, isBinary);
    if (line !== null && !chat.write(line)) page.pause();
  });
  chat.on("drain", () => page.resume());
  let unsent = 0;
  readLines(chat, (line) => {
    unsent += line.length;
    if (unsent > HIGH_WATER) chat.pause();
    page.send(line, { binary: false }, () => {
      unsent -= line.length;
      if (unsent <= HIGH_WATER && chat.isPaused()) chat.resume();
    });
  });
  // An error on the chat host's socket is followed by its close.
  chat.on("error", () => undefined);
  chat.on("close", () => closePage(page, 1012, "the agent's chat closed"));
  page.on("close", () => chat.destroy());
}

/** One direction between two WebSockets (a page and a hub's chat), message for message; `from` waits while `to` is behind. */
function relay(from: WebSocket, to: WebSocket): void {
  let unsent = 0;
  from.on("message", (data, isBinary) => {
    const bytes = bytesOf(data);
    unsent += bytes.length;
    if (unsent > HIGH_WATER) from.pause();
    to.send(bytes, { binary: isBinary }, () => {
      unsent -= bytes.length;
      if (unsent <= HIGH_WATER && from.isPaused) from.resume();
    });
  });
}

function reject(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** Connects to a chat host's socket; rejects when nothing listens there. */
async function connectChat(path: string): Promise<Socket> {
  const socket = connect(path);
  const { promise, resolve, reject: fail } = Promise.withResolvers<Socket>();
  socket.once("connect", () => resolve(socket));
  socket.once("error", fail);
  try {
    return await promise;
  } finally {
    socket.off("error", fail);
  }
}

/** Whether a chat host answers on `path` within `timeoutMs`: it sends its snapshot as soon as a client connects. */
async function chatAnswersOnce(path: string, timeoutMs: number): Promise<boolean> {
  const socket = connect(path);
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const timer = setTimeout(() => resolve(false), timeoutMs);
  socket.on("error", () => resolve(false));
  socket.on("close", () => resolve(false));
  socket.on("data", (chunk: Buffer) => {
    if (chunk.includes(10)) resolve(true);
  });
  return promise.finally(() => {
    clearTimeout(timer);
    socket.destroy();
  });
}

/** Waits until the chat host in `runDir` answers; fails once the session stops (`running` false) or the time is up. */
export async function chatAnswers(runDir: string, running: () => Promise<boolean>): Promise<void> {
  const path = join(runDir, CHAT_SOCKET);
  for (const deadline = Date.now() + CHAT_START_MS; ;) {
    if (await chatAnswersOnce(path, Math.max(deadline - Date.now(), 1_000))) return;
    if (!(await running())) throw new Error("the session stopped while starting");
    if (Date.now() > deadline) throw new Error(`the session's chat did not answer within ${CHAT_START_MS / 1000} s`);
    await sleep(200);
  }
}

const promptAnswer = z.object({ type: z.literal("response"), id: z.string(), success: z.boolean(), error: z.string().optional() });

/**
 * DEPLOY-1: sends `text` to the session's agent as a person's prompt through its chat host, so
 * every page open on the chat shows it (CHAT-9); queued as a follow-up when a turn runs.
 * Resolves once omp has taken it.
 */
export async function sendPrompt(runDir: string, text: string): Promise<void> {
  const id = `am-${randomBytes(6).toString("hex")}`;
  const message: ClientMessage = { type: "rpc", id, command: { type: "prompt", message: text, streamingBehavior: "followUp" } };
  const socket = connect(join(runDir, CHAT_SOCKET));
  const { promise, resolve, reject: fail } = Promise.withResolvers<void>();
  const timer = setTimeout(() => fail(new Error(`the chat did not take the prompt within ${PROMPT_MS / 1000} s`)), PROMPT_MS);
  socket.on("error", (cause) => fail(new Error(`the chat is unavailable: ${cause.message}`)));
  socket.on("close", () => fail(new Error("the chat closed before it took the prompt")));
  readLines(socket, (line) => {
    // Only the answer names the prompt's id; the snapshot first on every connection can be large.
    if (!line.includes(id)) return;
    const answer = promptAnswer.safeParse(JSON.parse(line.toString("utf8")));
    if (!answer.success || answer.data.id !== id) return;
    if (answer.data.success) resolve();
    else fail(new Error(answer.data.error ?? "omp refused the prompt"));
  });
  socket.write(`${JSON.stringify(message)}\n`);
  return promise.finally(() => {
    clearTimeout(timer);
    socket.destroy();
  });
}

export interface ChatDeps {
  config: Pick<GatewayConfig, "publicOrigin">;
  auth: Auth;
  store: StoreService;
  hubs: Hubs;
}

/**
 * CHAT-1: a session's chat for the browser, the WebSocket `<store API>/sessions/<id>/chat`. The
 * gateway checks who the browser is (AUTH-1), that it may read the session's project, and that
 * the page is the UI's own (another site's page must not drive a session from the user's
 * browser), then pipes the page's messages and the chat host's lines unchanged (shared/chat.ts).
 * A hub's session (STORE-3) is the hub's socket, reached with the client's Access token.
 */
export class ChatSockets {
  private readonly deps: ChatDeps;
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: CHAT_MESSAGE_BYTES });

  constructor(deps: ChatDeps) {
    this.deps = deps;
  }

  /** Takes a chat socket's upgrade; false for every other path. */
  async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    const own = OWN_CHAT.exec(pathname);
    const viaHub = own === null ? HUB_CHAT.exec(pathname) : null;
    if (own === null && viaHub === null) return false;
    const { publicOrigin } = this.deps.config;
    if (!validHost(request, publicOrigin)) {
      reject(socket, 404, "Not Found");
      return true;
    }
    const visitor = await this.deps.auth.identify(request);
    if (visitor.kind === "refused") {
      reject(socket, visitor.status, "Refused");
      return true;
    }
    if (!validOrigin(request, publicOrigin)) {
      reject(socket, 403, "Forbidden");
      return true;
    }
    this.server.handleUpgrade(request, socket, head, (page) => {
      // A socket error (a message over the limit) is followed by its close.
      page.on("error", () => undefined);
      const ping = setInterval(() => page.ping(), PING_MS);
      page.on("close", () => clearInterval(ping));
      if (own !== null) void this.serveOwn(page, visitor.principal, own[1]);
      else if (viaHub !== null) void this.serveHub(page, decodeURIComponent(viaHub[1]), viaHub[2]);
    });
    return true;
  }

  /** The page says what it waits on (SESSION-13) while a stopped session starts again (SESSION-10). */
  private async serveOwn(page: WebSocket, principal: Principal, sessionId: string): Promise<void> {
    const early = keepEarly(page);
    let path: string;
    try {
      path = await this.deps.store.chatSocket(principal, sessionId, (text) => sendStatus(page, text));
    } catch (cause) {
      const { code, reason } = failureClose(cause);
      closePage(page, code, reason);
      return;
    }
    if (page.readyState !== WebSocket.OPEN) return;
    sendStatus(page, "Connecting to the agent…");
    let chat: Socket;
    try {
      chat = await connectChat(path);
    } catch {
      // The chat host has gone since: the page connects again, which starts the session again.
      closePage(page, 1012, "the session's chat is unavailable");
      return;
    }
    if (page.readyState !== WebSocket.OPEN) {
      chat.destroy();
      return;
    }
    pipeChat(page, chat, early.stop());
  }

  private async serveHub(page: WebSocket, hubName: string, sessionId: string): Promise<void> {
    const early = keepEarly(page);
    const found = await this.deps.hubs.chatSocket(hubName, `/sessions/${sessionId}/chat`);
    if (!found.ok) {
      closePage(page, found.code, found.reason);
      return;
    }
    const hub = found.socket;
    if (page.readyState !== WebSocket.OPEN) {
      hub.terminate();
      return;
    }
    // Kept as received: a hub's chat takes lines as this gateway's does.
    for (const line of early.stop()) hub.send(line.subarray(0, -1), { binary: false });
    relay(page, hub);
    relay(hub, page);
    // The hub's own closes (4404, 4409, 1012) reach the page; a lost connection to the hub is the chat going away.
    hub.on("close", (code, reason) => closePage(page, code >= 4000 || code === 1012 ? code : 1012, reason.toString("utf8") || "the hub's chat closed"));
    page.on("close", () => hub.close());
    hub.resume();
  }
}
