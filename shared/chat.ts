/**
 * CHAT-1: the chat's wire protocol. The chat host (container/chat-host.ts) runs omp in RPC
 * mode inside the session and serves this protocol on the run directory's `chat.sock`, one
 * JSON object per line. The gateway (server/chat.ts) passes the same objects, unchanged, as
 * the text messages of the browser's WebSocket (app/chat/). omp's own frames travel inside
 * `frame` and `snapshot` as omp wrote them (omp://rpc.md); readers narrow what they use.
 * The chat host imports this file for its types only: the session image has no shared/.
 */

/** One frame omp wrote on stdout (an event, a UI request, a prompt_result), as JSON. */
export interface OmpFrame {
  type: string;
  [key: string]: unknown;
}

/** A frame with the time the chat host received it (epoch ms), so a page that connects later times running tool calls as one that watched them start. */
export interface TimedFrame {
  at: number;
  frame: OmpFrame;
}

/** One chat (omp session file) a session can go on with (CHAT-7). */
export interface ChatListing {
  /** The session file, for omp's `switch_session` `sessionPath`. */
  file: string;
  /** omp's id of the chat. */
  id: string;
  title: string | null;
  /** Epoch ms. */
  startedAt: number;
  /** Epoch ms: the file's last change. */
  updatedAt: number;
  /** The chat omp has open now. */
  current: boolean;
}

/** What a page needs to draw the chat from scratch; sent on connect and after the chat changes (another chat opened, omp restarted). */
export interface ChatSnapshot {
  /** omp's working directory, as the agent sees it (a container's `/workspace/<repo>`). */
  cwd: string;
  /** The task's or automation's folder as the agent sees it (FOLDER-3); null when the session has none. */
  folder: string | null;
  /** omp's `get_state` data: model, thinkingLevel, isStreaming, sessionFile, sessionId, sessionName, contextUsage, queuedMessages, ... */
  state: Record<string, unknown>;
  /**
   * The open chat's finished messages before the running run, oldest first, as omp's session
   * file holds them on its current branch (pre-compaction ones included): AgentMessage objects
   * (`role` user, assistant, toolResult, custom, ...). Only the newest 200 are sent.
   */
  messages: unknown[];
  /** How many older messages precede `messages`; a page asks for them with `history`. */
  olderMessages: number;
  /** Every frame since the running run's `agent_start`, in order; empty while no run runs. */
  run: TimedFrame[];
  /** Open dialogs: omp's `extension_ui_request` frames whose method is ask, select, confirm, input, or editor. */
  dialogs: OmpFrame[];
  /** omp's displayable queue (`queue_update`). */
  queue: { steering: string[]; followUp: string[] };
  /** omp's slash commands (`available_commands_update`). */
  commands: unknown[];
  /** False while omp is down and the chat host starts it again. */
  ompRunning: boolean;
}

/** From the chat host (or the gateway) to a page. */
export type ServerMessage =
  | { type: "snapshot"; snapshot: ChatSnapshot }
  /** Every omp frame the chat host received, except responses (each goes to the page that asked, as `response`), `ready`, and `rpc_chunk` (reassembled first). A `prompt_result` goes only to the page whose prompt it completes, with that page's id. */
  | { type: "frame"; at: number; frame: OmpFrame }
  /** The answer to this page's `rpc`, `list_chats`, or `history`, with the page's own id. */
  | { type: "response"; id: string; command: string; success: boolean; data?: unknown; error?: string }
  /** omp's state changed (after a run, a model or effort change, a compaction): `get_state` data. */
  | { type: "state"; state: Record<string, unknown> }
  /** A dialog was answered (from any page) or cancelled by omp. */
  | { type: "dialog_closed"; id: string }
  /** omp exited; the chat host starts it again on the same chat, then sends a snapshot. */
  | { type: "omp_exited"; code: number | null }
  /** Only from the gateway, before the chat host answers: what the page waits on (SESSION-13). */
  | { type: "status"; text: string };

/** From a page (or the gateway's own prompts, DEPLOY-1) to the chat host. */
export type ClientMessage =
  /** Any omp RPC command (omp://rpc.md), e.g. `{type:"prompt", message, images, streamingBehavior}`, `abort`, `set_model`, `switch_session`. */
  | { type: "rpc"; id: string; command: OmpFrame }
  /** The answer to an open dialog, as omp's `extension_ui_response` without its `type`: `{id, value}`, `{id, confirmed}`, `{id, cancelled: true}`, or `{id, answers}`. */
  | { type: "dialog_response"; response: { id: string; [key: string]: unknown } }
  /** The session's chats; answered with `data: { chats: ChatListing[] }`. */
  | { type: "list_chats"; id: string }
  /** Older messages of the open chat: up to `limit` (the chat host sends at most 200) before index `before`; answered with `data: { messages, olderMessages }`. */
  | { type: "history"; id: string; before: number; limit: number };

/** One file in a prompt box's draft; `data` is base64. */
export interface DraftAttachment {
  name: string;
  mimeType: string;
  data: string;
}

/** CHAT-6: a person's unsent prompt in one session's prompt box, as the gateway keeps it. */
export interface ChatDraft {
  text: string;
  attachments: DraftAttachment[];
  /** Epoch ms of the change it holds, so a page takes the newer of the gateway's and its own. */
  updatedAt: number;
}
