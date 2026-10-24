// CHAT-1: the session's chat host. It owns omp's stdio for the session's life: runs omp in RPC
// mode, keeps a mirror of the chat (history, the running run, dialogs, queue, state) so a page
// can connect at any time and draw it whole, and serves shared/chat.ts's protocol to the
// gateway on the run directory's chat.sock, one JSON object per line. launch.ts starts it in the
// session's entry process. Types only from shared/: the session image has no shared/.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { ChatListing, ChatSnapshot, ClientMessage, OmpFrame, ServerMessage, TimedFrame } from "../shared/chat.ts";

export interface ChatHostOptions {
  /** The run directory, where chat.sock goes. */
  run: string;
  /** omp's working directory. */
  cwd: string;
  /** The task's or automation's folder as the agent sees it; null: none. */
  folder: string | null;
  /** omp model for a new chat; null: omp's default. */
  model: string | null;
  /** omp chat (session id or file) to resume; null: a new chat. */
  resume: string | null;
  /** A new chat's first prompt (AUTO-9); null: the chat waits for a person. */
  prompt: string | null;
  /** omp's environment. */
  env: NodeJS.ProcessEnv;
}

/** How many of the newest messages a snapshot carries, and the most a `history` answer holds. */
const PAGE_MESSAGES = 200;
/** A page whose socket holds more unsent bytes than this has stopped reading: dropped. */
const MAX_UNSENT_BYTES = 64 * 1024 * 1024;
/** More omp exits than this within RESTART_WINDOW_MS end the chat host, and so the session. */
const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 60_000;
/** Enough of a session file's head for its title line and session entry. */
const HEAD_BYTES = 64 * 1024;
/** omp's dialogs; its other UI requests (notify, setStatus, setWidget, ...) only pass by. */
const DIALOG_METHODS = new Set(["ask", "select", "confirm", "input", "editor"]);
/** Commands after which omp has another chat open (or the same one on another branch). */
const CHAT_CHANGES = new Set(["switch_session", "new_session", "fork", "branch", "open_session"]);
/** Events after which `get_state` says something new. */
const STATE_EVENTS = new Set(["agent_end", "model_changed", "thinking_level_changed", "auto_compaction_end"]);
/** get_state fields no page draws, each up to hundreds of KiB, left out of the mirror. */
const UNDRAWN_STATE = new Set(["systemPrompt", "dumpTools"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFrame(value: unknown): value is OmpFrame {
  return isRecord(value) && typeof value.type === "string";
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

/** A page's line, or null when it is not a ClientMessage. */
function clientMessage(value: unknown): ClientMessage | null {
  if (!isRecord(value)) return null;
  const { id } = value;
  switch (value.type) {
    case "rpc": {
      const { command } = value;
      return typeof id === "string" && isFrame(command) ? { type: "rpc", id, command } : null;
    }
    case "dialog_response": {
      const { response } = value;
      return isRecord(response) && typeof response.id === "string" ? { type: "dialog_response", response: { ...response, id: response.id } } : null;
    }
    case "list_chats":
      return typeof id === "string" ? { type: "list_chats", id } : null;
    case "history": {
      const { before, limit } = value;
      return typeof id === "string" && isCount(before) && isCount(limit) ? { type: "history", id, before, limit } : null;
    }
    default:
      return null;
  }
}

/** A toolResult message with the time its call started (epoch ms), so a page times it. */
function withStartedAt(message: Record<string, unknown>, startedAt: Map<string, number>): Record<string, unknown> {
  if (message.role !== "toolResult" || typeof message.toolCallId !== "string") return message;
  const at = startedAt.get(message.toolCallId);
  return at === undefined ? message : { ...message, startedAt: at };
}

/** The chat message a session file entry shows, or null for bookkeeping entries. */
function entryMessage(entry: Record<string, unknown>, startedAt: Map<string, number>): Record<string, unknown> | null {
  const timestamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : null;
  switch (entry.type) {
    case "message":
      return isRecord(entry.message) ? withStartedAt(entry.message, startedAt) : null;
    case "custom_message": {
      // As omp streams it: role custom, the entry's own fields, an epoch-ms timestamp.
      const { type: _type, id: _id, parentId: _parentId, runtime: _runtime, ...message } = entry;
      return { ...message, role: "custom", timestamp };
    }
    case "compaction":
      return { role: "compactionSummary", summary: entry.summary, timestamp };
    default:
      return null;
  }
}

/** Every entry of a session file, in order; a torn last line is skipped. */
function fileEntries(file: string): Record<string, unknown>[] {
  if (!existsSync(file)) return [];
  const entries: Record<string, unknown>[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const entry: unknown = JSON.parse(line);
      if (isRecord(entry)) entries.push(entry);
    } catch {
      // A line omp is still writing.
    }
  }
  return entries;
}

/** A chat for the Chats list, from its file's head: the title line, then the session entry. */
function chatListing(file: string, current: boolean): ChatListing {
  const head = Buffer.alloc(HEAD_BYTES);
  const fd = openSync(file, "r");
  let length: number;
  try {
    length = readSync(fd, head, 0, HEAD_BYTES, 0);
  } finally {
    closeSync(fd);
  }
  const { mtimeMs, birthtimeMs } = statSync(file);
  const chat: ChatListing = { file, id: basename(file, ".jsonl"), title: null, startedAt: birthtimeMs, updatedAt: mtimeMs, current };
  for (const line of head.subarray(0, length).toString("utf8").split("\n")) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      break;
    }
    if (!isRecord(entry)) break;
    if (entry.type === "title") {
      if (typeof entry.title === "string" && entry.title.trim() !== "") chat.title = entry.title.trim();
      continue;
    }
    if (entry.type !== "session") break;
    if (typeof entry.id === "string") chat.id = entry.id;
    if (typeof entry.timestamp === "string") chat.startedAt = Date.parse(entry.timestamp);
    if (chat.title === null && typeof entry.title === "string" && entry.title.trim() !== "") chat.title = entry.title.trim();
    break;
  }
  return chat;
}

/** A partly received protocol-v2 chunked frame. */
interface Chunks {
  id: string;
  count: number;
  byteLength: number;
  parts: Buffer[];
  size: number;
}

class ChatHost {
  private readonly options: ChatHostOptions;
  private omp: ChildProcessByStdio<Writable, Readable, null> | null = null;
  /** omp answered and the mirror holds its chat; false while it starts (again). */
  private up = false;
  private stopping = false;
  private exits: number[] = [];
  private ready: PromiseWithResolvers<OmpFrame> | null = null;
  private readonly pending = new Map<string, PromiseWithResolvers<OmpFrame>>();
  private requests = 0;
  private chunks: Chunks | null = null;
  private maxFrameBytes = 64 * 1024 * 1024;
  private readonly clients = new Map<string, Socket>();
  private clientCount = 0;

  // The mirror (ChatSnapshot).
  private state: Record<string, unknown> = {};
  private messages: unknown[] = [];
  private run: TimedFrame[] = [];
  /** Where each tool call's newest tool_execution_update sits in `run`. */
  private readonly toolUpdates = new Map<string, number>();
  private dialogs: OmpFrame[] = [];
  private queue: ChatSnapshot["queue"] = { steering: [], followUp: [] };
  private commands: unknown[] = [];
  /** The history was read while a run ran, so the run's messages may be in it: read it again at the run's end instead of adding them. */
  private historyStale = false;

  constructor(options: ChatHostOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.on(signal, () => {
        this.stopping = true;
        if (this.omp === null) process.exit(0);
        this.omp.kill(signal);
      });
    }
    await this.bringUp(this.options.resume, this.options.model);
    if (this.options.resume === null && this.options.prompt !== null) {
      this.request({ type: "prompt", message: this.options.prompt }).then((response) => {
        if (response.success !== true) console.error(`chat host: the first prompt failed: ${String(response.error)}`);
      }, () => {});
    }
    // Listening only now: a page's first line is a snapshot of a chat omp has open.
    const socketPath = join(this.options.run, "chat.sock");
    rmSync(socketPath, { force: true });
    const server = createServer((socket) => this.connect(socket));
    const listening = Promise.withResolvers<void>();
    server.once("error", listening.reject);
    server.listen(socketPath, listening.resolve);
    await listening.promise;
  }

  /** Starts omp until it answers; one that dies first is started again on its chat. */
  private async bringUp(resume: string | null, model: string | null): Promise<void> {
    for (let next = { resume, model }; ;) {
      try {
        await this.launch(next.resume, next.model);
        return;
      } catch (cause) {
        console.error(`chat host: omp did not come up: ${cause instanceof Error ? cause.message : String(cause)}`);
        next = this.resumption();
      }
    }
  }

  /** How omp starts again: on the chat it had open, once omp wrote it; its saved model comes with it. */
  private resumption(): { resume: string | null; model: string | null } {
    const file = this.state.sessionFile;
    const resume = typeof file === "string" && existsSync(file) ? file : this.options.resume;
    return { resume, model: resume === null ? this.options.model : null };
  }

  private async launch(resume: string | null, model: string | null): Promise<void> {
    // --auto-approve keeps the TUI's default of not asking before tool calls. AGENTMONITOR_CHAT
    // names this process as the chat omp's parent, so its extension takes the session's channel
    // and no omp the agent starts does (omp-extension.ts).
    const args = ["--mode", "rpc-ui", "--auto-approve"];
    if (model !== null) args.push("--model", model);
    if (resume !== null) args.push("--resume", resume);
    this.ready = Promise.withResolvers<OmpFrame>();
    const omp = spawn("omp", args, {
      cwd: this.options.cwd,
      env: { ...this.options.env, AGENTMONITOR_CHAT: String(process.pid) },
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.omp = omp;
    let gone = false;
    const exited = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (gone) return;
      gone = true;
      this.exited(code, signal);
    };
    omp.on("error", (error) => {
      console.error(`chat host: omp: ${error.message}`);
      if (omp.pid === undefined) exited(null, null);
    });
    // `close` comes after every line omp wrote was read.
    omp.on("close", exited);
    // omp gone: its close starts it again.
    omp.stdin.on("error", () => {});
    createInterface({ input: omp.stdout, crlfDelay: Infinity })
      .on("line", (line) => this.line(line))
      .on("error", () => {});

    const ready = await this.ready.promise;
    if (isCount(ready.maxReassembledFrameBytes)) this.maxFrameBytes = ready.maxReassembledFrameBytes;
    // Without v2 omp elides what does not fit a 1 MiB line; with it, it sends rpc_chunk frames.
    const negotiated = await this.request({ type: "negotiate_protocol", protocolVersion: 2 });
    if (negotiated.success !== true) console.error(`chat host: omp kept protocol v1: ${String(negotiated.error)}`);
    await this.request({ type: "set_ask_dialog", enabled: true });
    await this.request({ type: "set_subagent_subscription", level: "progress" });
    await this.reload();
    this.up = true;
  }

  private exited(code: number | null, signal: NodeJS.Signals | null): void {
    const wasUp = this.up;
    this.omp = null;
    this.up = false;
    this.chunks = null;
    const gone = new Error(`omp exited with ${code ?? signal}`);
    this.ready?.reject(gone);
    for (const request of this.pending.values()) request.reject(gone);
    this.pending.clear();
    if (this.stopping) process.exit(0);
    console.error(`chat host: ${gone.message}`);
    const now = Date.now();
    this.exits = [...this.exits.filter((at) => now - at < RESTART_WINDOW_MS), now];
    if (this.exits.length > MAX_RESTARTS) {
      console.error(`chat host: omp exited ${this.exits.length} times within ${RESTART_WINDOW_MS / 1000} s; giving up`);
      process.exit(1);
    }
    // While omp comes up, bringUp starts it again.
    if (!wasUp) return;
    this.run = [];
    this.toolUpdates.clear();
    this.dialogs = [];
    this.broadcast({ type: "omp_exited", code });
    const next = this.resumption();
    void this.bringUp(next.resume, next.model).then(() => this.broadcastSnapshot());
  }

  /** Sends a command of the chat host's own to omp; resolves with omp's response. */
  private request(command: Record<string, unknown>): Promise<OmpFrame> {
    const id = `host:${++this.requests}`;
    const answer = Promise.withResolvers<OmpFrame>();
    this.pending.set(id, answer);
    this.toOmp({ ...command, id });
    return answer.promise;
  }

  private toOmp(command: Record<string, unknown>): void {
    this.omp?.stdin.write(`${JSON.stringify(command)}\n`);
  }

  /** Re-reads state and history: on start, and when omp opened another chat. */
  private async reload(): Promise<void> {
    await this.refreshState();
    await this.reloadHistory();
  }

  private async refreshState(): Promise<void> {
    const response = await this.request({ type: "get_state" });
    if (response.success !== true || !isRecord(response.data)) {
      console.error(`chat host: get_state failed: ${String(response.error)}`);
      return;
    }
    this.state = Object.fromEntries(Object.entries(response.data).filter(([key]) => !UNDRAWN_STATE.has(key)));
  }

  /**
   * The open chat's current branch: the session file, plus what omp holds but has not written
   * yet (`get_entries` after the file's last entry), from omp's leaf back to the root.
   */
  private async reloadHistory(): Promise<void> {
    const file = this.state.sessionFile;
    const entries = typeof file === "string" ? fileEntries(file) : [];
    const last = entries.findLast((entry) => typeof entry.id === "string");
    let leaf = typeof last?.id === "string" ? last.id : null;
    const tail = await this.request(leaf === null ? { type: "get_entries" } : { type: "get_entries", since: leaf });
    if (tail.success === true && isRecord(tail.data)) {
      if (Array.isArray(tail.data.entries)) entries.push(...tail.data.entries.filter(isRecord));
      if (typeof tail.data.leafId === "string" || tail.data.leafId === null) leaf = tail.data.leafId;
    } else {
      console.error(`chat host: get_entries failed: ${String(tail.error)}`);
    }
    const byId = new Map<string, Record<string, unknown>>();
    const startedAt = new Map<string, number>();
    for (const entry of entries) {
      if (typeof entry.id === "string") byId.set(entry.id, entry);
      const { data } = entry;
      if (entry.type === "custom" && entry.customType === "tool_execution_start" && isRecord(data)
        && typeof data.toolCallId === "string" && typeof data.startedAt === "string") {
        startedAt.set(data.toolCallId, Date.parse(data.startedAt));
      }
    }
    const branch: Record<string, unknown>[] = [];
    for (let id = leaf; id !== null;) {
      const entry = byId.get(id);
      if (entry === undefined) break;
      byId.delete(id);
      branch.push(entry);
      id = typeof entry.parentId === "string" ? entry.parentId : null;
    }
    this.messages = branch.reverse().flatMap((entry) => entryMessage(entry, startedAt) ?? []);
    this.historyStale = this.run.length > 0;
  }

  private snapshot(): ChatSnapshot {
    const older = Math.max(0, this.messages.length - PAGE_MESSAGES);
    return {
      cwd: this.options.cwd,
      folder: this.options.folder,
      state: this.state,
      messages: this.messages.slice(older),
      olderMessages: older,
      run: this.run,
      dialogs: this.dialogs,
      queue: this.queue,
      commands: this.commands,
      ompRunning: this.up,
    };
  }

  private broadcastSnapshot(): void {
    this.broadcast({ type: "snapshot", snapshot: this.snapshot() });
  }

  /** After omp's state changed: re-read it and tell every page. */
  private stateChanged(): void {
    this.refreshState().then(() => this.broadcast({ type: "state", state: this.state }), () => {});
  }

  /** After omp's history changed under the mirror (a compaction): re-read it and send every page a snapshot. */
  private historyChanged(): void {
    if (this.run.length > 0) {
      this.historyStale = true;
      return;
    }
    this.reloadHistory().then(() => this.broadcastSnapshot(), () => {});
  }

  // omp → chat host

  private line(text: string): void {
    if (text.trim() === "") return;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      console.error(`chat host: omp wrote a line that is no JSON: ${text.slice(0, 200)}`);
      return;
    }
    if (!isFrame(value)) return;
    if (value.type === "rpc_chunk") {
      const frame = this.chunk(value);
      if (frame !== null) this.frame(frame);
      return;
    }
    if (this.chunks !== null) {
      console.error(`chat host: omp interrupted chunked frame ${this.chunks.id}; dropped`);
      this.chunks = null;
    }
    this.frame(value);
  }

  /** Adds one rpc_chunk; returns the whole frame with its last chunk. A broken sequence is dropped. */
  private chunk(chunk: OmpFrame): OmpFrame | null {
    const { chunkId, index, count, byteLength, data } = chunk;
    const broken = (why: string): null => {
      console.error(`chat host: dropped chunked frame ${String(chunkId)}: ${why}`);
      this.chunks = null;
      return null;
    };
    if (typeof chunkId !== "string" || !isCount(index) || !isCount(count) || !isCount(byteLength) || typeof data !== "string") return broken("malformed chunk");
    if (index === 0) {
      if (this.chunks !== null) broken(`interrupted by ${chunkId}`);
      if (count === 0 || byteLength > this.maxFrameBytes) return broken(`${count} chunks, ${byteLength} bytes`);
      this.chunks = { id: chunkId, count, byteLength, parts: [], size: 0 };
    }
    const chunks = this.chunks;
    if (chunks === null || chunks.id !== chunkId || chunks.parts.length !== index || chunks.count !== count || chunks.byteLength !== byteLength) {
      return broken(`chunk ${index} of ${count} out of sequence`);
    }
    const part = Buffer.from(data, "base64");
    chunks.size += part.length;
    if (chunks.size > byteLength) return broken(`more than ${byteLength} bytes`);
    chunks.parts.push(part);
    if (chunks.parts.length < count) return null;
    this.chunks = null;
    if (chunks.size !== byteLength) return broken(`${chunks.size} bytes instead of ${byteLength}`);
    let frame: unknown;
    try {
      frame = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks.parts)));
    } catch (cause) {
      return broken(cause instanceof Error ? cause.message : String(cause));
    }
    return isFrame(frame) ? frame : broken("not a frame");
  }

  private frame(frame: OmpFrame): void {
    const at = Date.now();
    switch (frame.type) {
      case "ready":
        this.ready?.resolve(frame);
        return;
      case "response":
        this.response(frame);
        return;
      case "prompt_result": {
        const route = this.route(frame.id);
        if (route !== null) this.send(route.client, { type: "frame", at, frame: { ...frame, id: route.id } });
        return;
      }
      case "extension_ui_request":
        if (frame.method === "cancel") {
          this.closeDialog(frame.targetId);
          return;
        }
        if (typeof frame.method === "string" && DIALOG_METHODS.has(frame.method)) this.dialogs.push(frame);
        this.broadcast({ type: "frame", at, frame });
        return;
      case "queue_update":
        this.queue = { steering: strings(frame.steering), followUp: strings(frame.followUp) };
        this.broadcast({ type: "frame", at, frame });
        return;
      case "available_commands_update":
        this.commands = Array.isArray(frame.commands) ? frame.commands : [];
        this.broadcast({ type: "frame", at, frame });
        return;
    }
    if (frame.type === "agent_start") {
      this.run = [];
      this.toolUpdates.clear();
    }
    if (frame.type === "agent_start" || this.run.length > 0) this.record({ at, frame });
    else if (frame.type === "message_end" && isRecord(frame.message)) this.messages.push(frame.message);
    this.broadcast({ type: "frame", at, frame });
    if (frame.type === "agent_end") this.endRun();
    if (STATE_EVENTS.has(frame.type)) this.stateChanged();
    if (frame.type === "auto_compaction_end") this.historyChanged();
  }

  /** Adds a frame to the running run; cumulative updates replace the one before. */
  private record(timed: TimedFrame): void {
    const { frame } = timed;
    if (frame.type === "message_update") {
      const last = this.run.at(-1);
      if (last !== undefined && last.frame.type === "message_update" && last.frame.messageId === frame.messageId) {
        this.run[this.run.length - 1] = timed;
        return;
      }
    }
    if (frame.type === "tool_execution_update" && typeof frame.toolCallId === "string") {
      const index = this.toolUpdates.get(frame.toolCallId);
      if (index !== undefined) {
        this.run[index] = timed;
        return;
      }
      this.toolUpdates.set(frame.toolCallId, this.run.length);
    }
    this.run.push(timed);
  }

  /** agent_end: the run's finished messages join the history; tool results with their call's start. */
  private endRun(): void {
    const run = this.run;
    this.run = [];
    this.toolUpdates.clear();
    if (this.historyStale) {
      this.historyStale = false;
      this.historyChanged();
      return;
    }
    const startedAt = new Map<string, number>();
    for (const { at, frame } of run) {
      if (frame.type === "tool_execution_start" && typeof frame.toolCallId === "string") startedAt.set(frame.toolCallId, at);
      if (frame.type === "message_end" && isRecord(frame.message)) this.messages.push(withStartedAt(frame.message, startedAt));
    }
  }

  private closeDialog(id: unknown): boolean {
    const index = this.dialogs.findIndex((dialog) => dialog.id === id);
    if (index === -1 || typeof id !== "string") return false;
    this.dialogs.splice(index, 1);
    this.broadcast({ type: "dialog_closed", id });
    return true;
  }

  private response(frame: OmpFrame): void {
    const { id } = frame;
    if (typeof id !== "string") {
      console.error(`chat host: omp could not read a command: ${String(frame.error)}`);
      return;
    }
    const request = this.pending.get(id);
    if (request !== undefined) {
      this.pending.delete(id);
      request.resolve(frame);
      return;
    }
    const route = this.route(id);
    if (route === null) return;
    const command = typeof frame.command === "string" ? frame.command : "";
    const reply: ServerMessage = {
      type: "response",
      id: route.id,
      command,
      success: frame.success === true,
      ...(frame.data === undefined ? {} : { data: frame.data }),
      ...(typeof frame.error === "string" ? { error: frame.error } : {}),
    };
    if (frame.success === true && CHAT_CHANGES.has(command)) {
      // The page that asked gets its answer after the snapshot of the chat it opened.
      this.reload().then(() => this.broadcastSnapshot(), () => {}).finally(() => this.send(route.client, reply));
      return;
    }
    if (frame.success === true && command === "compact") this.historyChanged();
    this.send(route.client, reply);
  }

  /** The page and its own id behind an id the chat host gave omp (`<client>:<id>`). */
  private route(id: unknown): { client: string; id: string } | null {
    if (typeof id !== "string") return null;
    const colon = id.indexOf(":");
    const client = id.slice(0, colon);
    return colon === -1 || !this.clients.has(client) ? null : { client, id: id.slice(colon + 1) };
  }

  // pages → chat host

  private connect(socket: Socket): void {
    const client = `c${++this.clientCount}`;
    this.clients.set(client, socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => this.clients.delete(client));
    this.send(client, { type: "snapshot", snapshot: this.snapshot() });
    // readline passes the socket's errors on; a page that went away is only gone.
    createInterface({ input: socket, crlfDelay: Infinity })
      .on("line", (line) => this.clientLine(client, line))
      .on("error", () => socket.destroy());
  }

  private clientLine(client: string, line: string): void {
    if (line.trim() === "") return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      value = null;
    }
    const message = clientMessage(value);
    if (message === null) {
      console.error(`chat host: ignored a page's line: ${line.slice(0, 200)}`);
      return;
    }
    switch (message.type) {
      case "rpc":
        if (!this.up) {
          this.send(client, { type: "response", id: message.id, command: message.command.type, success: false, error: "omp is not running" });
          return;
        }
        this.toOmp({ ...message.command, id: `${client}:${message.id}` });
        return;
      case "dialog_response":
        // The first answer from any page closes the dialog; later ones are too late.
        if (this.closeDialog(message.response.id)) this.toOmp({ ...message.response, type: "extension_ui_response" });
        return;
      case "list_chats":
        this.send(client, { type: "response", id: message.id, command: "list_chats", success: true, data: { chats: this.chats() } });
        return;
      case "history": {
        const before = Math.min(message.before, this.messages.length);
        const start = Math.max(0, before - Math.min(message.limit, PAGE_MESSAGES));
        this.send(client, {
          type: "response", id: message.id, command: "history", success: true,
          data: { messages: this.messages.slice(start, before), olderMessages: start },
        });
        return;
      }
    }
  }

  /**
   * CHAT-7: the chats in the open chat's folder (omp's folder for this cwd; for a checkout
   * session the user's chats of the checkout, HOST-7), newest first.
   */
  private chats(): ChatListing[] {
    const current = this.state.sessionFile;
    if (typeof current !== "string") return [];
    const dir = dirname(current);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    return names.filter((name) => name.endsWith(".jsonl")).flatMap((name) => {
      const file = join(dir, name);
      try {
        return [chatListing(file, file === current)];
      } catch {
        // Deleted meanwhile.
        return [];
      }
    }).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private send(client: string, message: ServerMessage): void {
    this.write(client, `${JSON.stringify(message)}\n`);
  }

  private broadcast(message: ServerMessage): void {
    const line = `${JSON.stringify(message)}\n`;
    for (const client of this.clients.keys()) this.write(client, line);
  }

  private write(client: string, line: string): void {
    const socket = this.clients.get(client);
    if (socket === undefined || socket.destroyed) return;
    socket.write(line);
    if (socket.writableLength > MAX_UNSENT_BYTES) {
      console.error(`chat host: dropped ${client}: more than ${MAX_UNSENT_BYTES} bytes unsent`);
      this.clients.delete(client);
      socket.destroy();
    }
  }
}

/**
 * Runs omp for the session and serves its chat on `<run>/chat.sock`; resolves once pages can
 * connect. omp is started again when it exits; if it keeps exiting, the process exits 1.
 */
export async function startChatHost(options: ChatHostOptions): Promise<void> {
  await new ChatHost(options).start();
}
