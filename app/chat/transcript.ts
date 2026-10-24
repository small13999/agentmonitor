/**
 * CHAT-1: a session's chat as a page holds it, folded from the chat host's messages
 * (shared/chat.ts): the open chat's finished messages, the running run as its frames arrive,
 * and what omp shows beside them (dialogs, the queue, its state). omp's own objects are
 * narrowed where they are read. Plain functions without React, so a script can fold
 * captured frames the way the page does.
 */
import type { ChatSnapshot, OmpFrame, ServerMessage } from "../../shared/chat.ts";

export type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function records(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export type NoticeLevel = "info" | "warning" | "error";

/** One line of the transcript as the page keeps it: an omp message, or a line the page or omp's events add. */
export type Entry =
  | { kind: "message"; message: Json; streaming: boolean; messageId: string | null }
  | { kind: "notice"; key: string; level: NoticeLevel; text: string };

/** A tool call's execution as this page saw it, times as the chat host received its frames. */
export interface ToolRun {
  name: string;
  args: unknown;
  startedAt: number;
  endedAt: number | null;
  /** The newest `tool_execution_update`'s cumulative result. */
  partial: Json | null;
  result: Json | null;
  isError: boolean;
}

export interface ChatQueue {
  steering: string[];
  followUp: string[];
}

export interface ChatState {
  /** Whether the chat host's snapshot came; until then the page says what it waits on (SESSION-13). */
  loaded: boolean;
  /** The gateway's line about what the page waits on. */
  status: string | null;
  cwd: string;
  folder: string | null;
  /** omp's `get_state` data. */
  state: Json;
  history: Entry[];
  olderMessages: number;
  /** The running run's lines since `agent_start`; null while none runs. */
  live: Entry[] | null;
  tools: ReadonlyMap<string, ToolRun>;
  /** Subagents of `task` calls by the call's id, each by its index, from `subagent_*` frames. */
  subagents: ReadonlyMap<string, ReadonlyMap<number, Json>>;
  dialogs: OmpFrame[];
  queue: ChatQueue;
  commands: Json[];
  ompRunning: boolean;
  /** Numbers the page's own lines. */
  seq: number;
}

export const EMPTY_CHAT: ChatState = {
  loaded: false,
  status: null,
  cwd: "",
  folder: null,
  state: {},
  history: [],
  olderMessages: 0,
  live: null,
  tools: new Map(),
  subagents: new Map(),
  dialogs: [],
  queue: { steering: [], followUp: [] },
  commands: [],
  ompRunning: true,
  seq: 0,
};

/** Dialog methods the page answers; omp's other UI requests only decorate a terminal. */
const DIALOG_METHODS = new Set(["ask", "select", "confirm", "input", "editor"]);

/** A turn runs: its frames arrive, or omp says it streams. */
export function isRunning(chat: ChatState): boolean {
  return chat.live !== null || chat.state.isStreaming === true;
}

export function addNotice(chat: ChatState, level: NoticeLevel, text: string): ChatState {
  const notice: Entry = { kind: "notice", key: `notice-${chat.seq}`, level, text };
  return chat.live === null
    ? { ...chat, seq: chat.seq + 1, history: [...chat.history, notice] }
    : { ...chat, seq: chat.seq + 1, live: [...chat.live, notice] };
}

function messageEntries(messages: unknown[]): Entry[] {
  return messages.filter(isRecord).map((message) => ({ kind: "message", message, streaming: false, messageId: null }));
}

/** Older messages from a `history` answer, before the ones the page has. */
export function prependHistory(chat: ChatState, messages: unknown[], olderMessages: number): ChatState {
  return { ...chat, history: [...messageEntries(messages), ...chat.history], olderMessages };
}

function fromSnapshot(previous: ChatState, snapshot: ChatSnapshot): ChatState {
  let chat: ChatState = {
    ...EMPTY_CHAT,
    loaded: true,
    seq: previous.seq,
    cwd: snapshot.cwd,
    folder: snapshot.folder,
    state: snapshot.state,
    history: messageEntries(snapshot.messages),
    olderMessages: snapshot.olderMessages,
    dialogs: snapshot.dialogs,
    queue: snapshot.queue,
    commands: records(snapshot.commands),
    ompRunning: snapshot.ompRunning,
  };
  for (const { at, frame } of snapshot.run) chat = applyFrame(chat, at, frame);
  return chat;
}

function withTool(chat: ChatState, id: string, change: (run: ToolRun | undefined) => ToolRun): ChatState {
  const tools = new Map(chat.tools);
  tools.set(id, change(tools.get(id)));
  return { ...chat, tools };
}

function withSubagent(chat: ChatState, payload: Json, fields: Json): ChatState {
  const parent = str(payload.parentToolCallId);
  const index = num(payload.index);
  if (parent === null || index === null) return chat;
  const all = new Map(chat.subagents);
  const ofCall = new Map(all.get(parent) ?? []);
  ofCall.set(index, { ...ofCall.get(index), ...fields });
  all.set(parent, ofCall);
  return { ...chat, subagents: all };
}

/** A finished run's messages join the history; a tool result keeps when its call started, as the chat host's mirror does. */
function endRun(chat: ChatState): ChatState {
  if (chat.live === null) return chat;
  const finished = chat.live.flatMap((entry): Entry[] => {
    if (entry.kind === "notice") return [entry];
    if (entry.streaming) return [];
    const { message } = entry;
    const callId = str(message.toolCallId);
    const run = callId === null ? undefined : chat.tools.get(callId);
    const stamped = message.role === "toolResult" && message.startedAt === undefined && run !== undefined ? { ...message, startedAt: run.startedAt } : message;
    return [{ kind: "message", message: stamped, streaming: false, messageId: null }];
  });
  return { ...chat, history: [...chat.history, ...finished], live: null };
}

function updateMessage(chat: ChatState, frame: OmpFrame, done: boolean): ChatState {
  const message = isRecord(frame.message) ? frame.message : null;
  if (message === null) return chat;
  const messageId = str(frame.messageId);
  if (chat.live === null) {
    // A message outside a run (a hidden companion, a bash run by a person) shows once it ends.
    return done ? { ...chat, history: [...chat.history, { kind: "message", message, streaming: false, messageId: null }] } : chat;
  }
  const entry: Entry = { kind: "message", message, streaming: !done, messageId };
  const at = messageId === null ? -1 : chat.live.findIndex((line) => line.kind === "message" && line.messageId === messageId);
  if (at === -1) return { ...chat, live: [...chat.live, entry] };
  const live = [...chat.live];
  live[at] = entry;
  return { ...chat, live };
}

function noticeOf(frame: OmpFrame): { level: NoticeLevel; text: string } | null {
  const level = (value: unknown): NoticeLevel => (value === "error" ? "error" : value === "warning" ? "warning" : "info");
  switch (frame.type) {
    case "notice":
      return { level: level(frame.level), text: str(frame.message) ?? "" };
    case "auto_retry_start": {
      const seconds = Math.round((num(frame.delayMs) ?? 0) / 1000);
      return { level: "warning", text: `Retrying (attempt ${num(frame.attempt) ?? "?"} of ${num(frame.maxAttempts) ?? "?"}) in ${seconds}s: ${str(frame.errorMessage) ?? "the request failed"}` };
    }
    case "auto_retry_end":
      return frame.success === true ? null : { level: "error", text: `Retrying failed: ${str(frame.finalError) ?? "the request failed"}` };
    case "auto_compaction_start":
      return { level: "info", text: "Compacting the context…" };
    case "auto_compaction_end":
      if (str(frame.errorMessage) !== null) return { level: "error", text: `Compacting failed: ${str(frame.errorMessage)}` };
      return frame.aborted === true ? { level: "warning", text: "Compacting stopped." } : null;
    case "retry_fallback_applied":
      return { level: "warning", text: `Switched from ${str(frame.from) ?? "?"} to ${str(frame.to) ?? "?"}${str(frame.reason) === null ? "" : `: ${str(frame.reason)}`}` };
    case "extension_error":
      return { level: "error", text: `${str(frame.extensionPath) ?? "An extension"} failed: ${str(frame.error) ?? ""}` };
    case "rpc_frame_error":
      return { level: "error", text: `omp dropped a ${str(frame.originalType) ?? "frame"} too large to send: ${str(frame.error) ?? ""}` };
    case "command_output":
      return { level: "info", text: str(frame.text) ?? "" };
    case "prompt_result": {
      if (frame.status !== "error") return null;
      const error = isRecord(frame.error) ? frame.error : {};
      return { level: "error", text: str(error.message) ?? "The prompt failed." };
    }
    case "extension_ui_request":
      return frame.method === "notify" ? { level: level(frame.notifyType), text: str(frame.message) ?? "" } : null;
    default:
      return null;
  }
}

/** One omp frame, received by the chat host at `at`. */
export function applyFrame(chat: ChatState, at: number, frame: OmpFrame): ChatState {
  const notice = noticeOf(frame);
  if (notice !== null && notice.text !== "") chat = addNotice(chat, notice.level, notice.text);
  switch (frame.type) {
    case "agent_start":
      return chat.live === null ? { ...chat, live: [] } : chat;
    case "agent_end":
      return endRun(chat);
    case "message_start":
    case "message_update":
      return updateMessage(chat, frame, false);
    case "message_end":
      return updateMessage(chat, frame, true);
    case "tool_execution_start": {
      const id = str(frame.toolCallId);
      if (id === null) return chat;
      return withTool(chat, id, () => ({ name: str(frame.toolName) ?? "tool", args: frame.args, startedAt: at, endedAt: null, partial: null, result: null, isError: false }));
    }
    case "tool_execution_update": {
      const id = str(frame.toolCallId);
      if (id === null) return chat;
      const partial = isRecord(frame.partialResult) ? frame.partialResult : null;
      return withTool(chat, id, (run) => ({ ...(run ?? { name: str(frame.toolName) ?? "tool", args: frame.args, startedAt: at, endedAt: null, result: null, isError: false }), partial }));
    }
    case "tool_execution_end": {
      const id = str(frame.toolCallId);
      if (id === null) return chat;
      const result = isRecord(frame.result) ? frame.result : null;
      return withTool(chat, id, (run) => ({
        ...(run ?? { name: str(frame.toolName) ?? "tool", args: undefined, startedAt: at, partial: null }),
        endedAt: at,
        result,
        isError: frame.isError === true,
      }));
    }
    case "auto_compaction_end": {
      // The divider a reload shows for the compaction (the session file's `compaction` entry).
      const summary = isRecord(frame.result) ? str(frame.result.summary) : null;
      if (summary === null) return chat;
      const entry: Entry = { kind: "message", message: { role: "compactionSummary", summary, timestamp: at }, streaming: false, messageId: null };
      return chat.live === null ? { ...chat, history: [...chat.history, entry] } : { ...chat, live: [...chat.live, entry] };
    }
    case "queue_update":
      return { ...chat, queue: { steering: strings(frame.steering), followUp: strings(frame.followUp) } };
    case "available_commands_update":
      return { ...chat, commands: records(frame.commands) };
    case "session_info_update":
      return str(frame.title) === null ? chat : { ...chat, state: { ...chat.state, sessionName: frame.title } };
    case "thinking_level_changed":
      return { ...chat, state: { ...chat.state, thinkingLevel: frame.thinkingLevel } };
    case "extension_ui_request": {
      const id = str(frame.id);
      if (frame.method === "cancel") return { ...chat, dialogs: chat.dialogs.filter((dialog) => dialog.id !== frame.targetId) };
      if (id === null || typeof frame.method !== "string" || !DIALOG_METHODS.has(frame.method) || chat.dialogs.some((dialog) => dialog.id === id)) return chat;
      return { ...chat, dialogs: [...chat.dialogs, frame] };
    }
    case "subagent_lifecycle":
    case "subagent_progress": {
      const payload = isRecord(frame.payload) ? frame.payload : null;
      if (payload === null) return chat;
      return frame.type === "subagent_progress"
        ? withSubagent(chat, payload, { agent: payload.agent, task: payload.task, progress: payload.progress })
        : withSubagent(chat, payload, { agent: payload.agent, id: payload.id, description: payload.description, status: payload.status });
    }
    default:
      return chat;
  }
}

/** One message from the chat host or the gateway; `response`s go to whoever asked and change nothing here. */
export function reduceChat(chat: ChatState, message: ServerMessage): ChatState {
  switch (message.type) {
    case "snapshot":
      return fromSnapshot(chat, message.snapshot);
    case "frame":
      return applyFrame(chat, message.at, message.frame);
    case "state":
      return { ...chat, state: message.state };
    case "dialog_closed":
      return { ...chat, dialogs: chat.dialogs.filter((dialog) => dialog.id !== message.id) };
    case "omp_exited":
      return addNotice({ ...endRun(chat), ompRunning: false }, "warning", `The agent stopped${message.code === null ? "" : ` (exit code ${message.code})`}; it starts again on this chat.`);
    case "status":
      return { ...chat, status: message.text };
    case "response":
      return chat;
  }
}

export interface ImageBlock {
  mimeType: string;
  data: string;
}

/** A tool call as the transcript shows it: its input, and its output so far. */
export interface ToolView {
  id: string;
  name: string;
  args: Json;
  /** What the agent said it does with the call (omp's `intent`). */
  intent: string | null;
  /** Epoch ms; null when unknown (a call from before the page or the chat host timed it). */
  startedAt: number | null;
  endedAt: number | null;
  running: boolean;
  /** The result, or while it runs the newest partial result: `{content, details}`. */
  output: Json | null;
  isError: boolean;
  subagents: Json[];
}

export type Item =
  | { kind: "user"; key: string; text: string; images: ImageBlock[] }
  | { kind: "thinking"; key: string; text: string; streaming: boolean }
  | { kind: "reply"; key: string; text: string; images: ImageBlock[]; streaming: boolean }
  | { kind: "tool"; key: string; tool: ToolView }
  | { kind: "notice"; key: string; level: NoticeLevel; text: string }
  | { kind: "compaction"; key: string; summary: string }
  | { kind: "note"; key: string; label: string; text: string };

/** Text and images of a message's content: a string, or text and image blocks. */
export function contentOf(content: unknown): { text: string; images: ImageBlock[] } {
  if (typeof content === "string") return { text: content, images: [] };
  const blocks = records(content);
  return {
    text: blocks.flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : [])).join("\n"),
    images: blocks.flatMap((block) => {
      const data = str(block.data);
      const mimeType = str(block.mimeType);
      return block.type === "image" && data !== null && mimeType !== null ? [{ data, mimeType }] : [];
    }),
  };
}

/** A key for a message that stays when it moves from the run into the history, and over reconnects. */
function keyer(): (message: Json) => string {
  const used = new Map<string, number>();
  return (message) => {
    const base = `${str(message.role) ?? "message"}-${num(message.timestamp) ?? "x"}`;
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };
}

/** The transcript's lines, in order, from what the page holds. */
export function buildItems(chat: ChatState): Item[] {
  const entries = [...chat.history, ...(chat.live ?? [])];
  const results = new Map<string, Json>();
  for (const entry of entries) {
    if (entry.kind === "message" && !entry.streaming && entry.message.role === "toolResult" && typeof entry.message.toolCallId === "string") {
      results.set(entry.message.toolCallId, entry.message);
    }
  }
  const shown = new Set<string>();
  const runEnded = chat.live === null;
  const tool = (id: string, name: string, args: unknown, intent: string | null): ToolView => {
    const run = chat.tools.get(id);
    const result = results.get(id);
    const ofCall = chat.subagents.get(id);
    const startedAt = run?.startedAt ?? num(result?.startedAt);
    const endedAt = run?.endedAt ?? (result === undefined ? null : num(result.timestamp));
    const output = run?.result ?? (result === undefined ? null : { content: result.content, details: result.details }) ?? run?.partial ?? null;
    return {
      id,
      name,
      args: isRecord(args) ? args : isRecord(run?.args) ? run.args : {},
      intent,
      startedAt,
      endedAt,
      running: run !== undefined && run.endedAt === null && result === undefined && !runEnded,
      output,
      isError: run?.result !== undefined && run.result !== null ? run.isError : result?.isError === true,
      subagents: ofCall === undefined ? [] : [...ofCall.entries()].sort(([a], [b]) => a - b).map(([, subagent]) => subagent),
    };
  };
  const key = keyer();
  const items: Item[] = [];
  for (const entry of entries) {
    if (entry.kind === "notice") {
      items.push(entry);
      continue;
    }
    const { message, streaming } = entry;
    const at = key(message);
    switch (message.role) {
      case "user": {
        const { text, images } = contentOf(message.content);
        items.push({ kind: "user", key: at, text, images });
        break;
      }
      case "assistant": {
        const blocks = records(message.content);
        blocks.forEach((block, index) => {
          if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim() !== "") {
            items.push({ kind: "thinking", key: `${at}-${index}`, text: block.thinking, streaming });
          } else if ((block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") || block.type === "image") {
            const { text, images } = contentOf([block]);
            const last = items.at(-1);
            // Text blocks in a row are one reply.
            if (last?.kind === "reply" && last.key.startsWith(`${at}-`)) items[items.length - 1] = { ...last, text: [last.text, text].filter((part) => part !== "").join("\n\n"), images: [...last.images, ...images] };
            else items.push({ kind: "reply", key: `${at}-${index}`, text, images, streaming });
          } else if (block.type === "toolCall" && typeof block.id === "string") {
            shown.add(block.id);
            items.push({ kind: "tool", key: `tool-${block.id}`, tool: tool(block.id, str(block.name) ?? "tool", block.arguments, str(block.intent)) });
          }
        });
        if (message.stopReason === "error") items.push({ kind: "notice", key: `${at}-error`, level: "error", text: str(message.errorMessage) ?? "The model's request failed." });
        if (message.stopReason === "aborted") items.push({ kind: "notice", key: `${at}-aborted`, level: "info", text: "Stopped." });
        break;
      }
      case "toolResult": {
        const id = str(message.toolCallId);
        // Shown with its call; a result without one (its call is in an older page) shows alone.
        if (id !== null && !shown.has(id)) {
          shown.add(id);
          items.push({ kind: "tool", key: `tool-${id}`, tool: tool(id, str(message.toolName) ?? "tool", undefined, null) });
        }
        break;
      }
      case "bashExecution":
        items.push({
          kind: "tool",
          key: at,
          tool: {
            id: at,
            name: "bash",
            args: { command: str(message.command) ?? "" },
            intent: null,
            startedAt: null,
            endedAt: null,
            running: false,
            output: { content: [{ type: "text", text: str(message.output) ?? "" }], details: { exitCode: message.exitCode } },
            isError: num(message.exitCode) !== null && message.exitCode !== 0,
            subagents: [],
          },
        });
        break;
      case "compactionSummary":
      case "branchSummary":
        items.push({ kind: "compaction", key: at, summary: str(message.summary) ?? "" });
        break;
      case "custom":
        items.push({ kind: "note", key: at, label: str(message.customType) ?? "note", text: contentOf(message.content).text });
        break;
      default:
        items.push({ kind: "note", key: at, label: str(message.role) ?? "message", text: contentOf(message.content).text });
    }
  }
  return items;
}
