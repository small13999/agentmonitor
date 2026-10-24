import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { z } from "zod";
import type { ChatListing, OmpFrame, ServerMessage } from "../../shared/chat.ts";
import { api, storeUrl } from "../api.ts";
import { fileRoute, type FolderOwner } from "../Folder.tsx";
import { Markdown } from "../Markdown.tsx";
import { blobOf, folderPathOf, isPromptImage } from "./attachments.ts";
import { Composer } from "./Composer.tsx";
import { useChatSocket, type ChatConnection } from "./connection.ts";
import { AgentDialog, type DialogAnswer } from "./Dialogs.tsx";
import { useDraft } from "./draft.ts";
import { ChatImages, ToolCall, type ImageUrl } from "./Tools.tsx";
import {
  addNotice, buildItems, EMPTY_CHAT, isRecord, isRunning, num, prependHistory, records, reduceChat, str, strings,
  type ChatState, type ImageBlock, type Item, type Json, type NoticeLevel,
} from "./transcript.ts";

type ChatAction =
  | { kind: "server"; message: ServerMessage }
  | { kind: "notice"; level: NoticeLevel; text: string }
  | { kind: "older"; messages: unknown[]; olderMessages: number };

function chatReducer(chat: ChatState, action: ChatAction): ChatState {
  switch (action.kind) {
    case "server":
      return reduceChat(chat, action.message);
    case "notice":
      return addNotice(chat, action.level, action.text);
    case "older":
      return prependHistory(chat, action.messages, action.olderMessages);
  }
}

const ChatListingSchema = z.object({
  file: z.string(),
  id: z.string(),
  title: z.string().nullable(),
  startedAt: z.number(),
  updatedAt: z.number(),
  current: z.boolean(),
});
const HistorySchema = z.object({ messages: z.array(z.unknown()), olderMessages: z.number() });
/** Images in one prompt stay under what one line to omp was tried with. */
const MAX_PROMPT_IMAGE_BYTES = 15 * 1024 * 1024;
const HISTORY_PAGE = 200;

function formatWhen(at: number): string {
  return new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function formatTokens(tokens: number): string {
  return tokens < 1000 ? String(tokens) : `${Math.round(tokens / 100) / 10}k`;
}

/** A model as `get_state` and `get_available_models` give it: `provider/id`, and a name to show. */
function modelOf(value: unknown): { key: string; provider: string; id: string; name: string } | null {
  if (!isRecord(value)) return null;
  const provider = str(value.provider);
  const id = str(value.id);
  if (provider === null || id === null) return null;
  return { key: `${provider}/${id}`, provider, id, name: str(value.name) ?? id };
}

/** CHAT-7: the session's chats, to go on with one or start a new one. */
function ChatsDialog({ connection, onClose, onError }: { connection: ChatConnection; onClose: () => void; onError: (text: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [chats, setChats] = useState<ChatListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    dialog.current?.showModal();
    connection.request({ type: "list_chats" }).then(
      (response) => {
        const parsed = z.object({ chats: z.array(ChatListingSchema) }).safeParse(response.data);
        if (!response.success || !parsed.success) setError(response.error ?? "The chats could not be listed.");
        else setChats(parsed.data.chats);
      },
      (cause: Error) => setError(cause.message),
    );
  }, []);
  const run = (command: OmpFrame) => {
    onClose();
    connection.request({ type: "rpc", command }).then(
      (response) => { if (!response.success) onError(response.error ?? `${command.type} failed.`); },
      (cause: Error) => onError(cause.message),
    );
  };
  return (
    <dialog ref={dialog} className="chats-dialog" aria-label="Chats" onClose={onClose}>
      <header className="chats-head">
        <h2>Chats</h2>
        <button type="button" className="ghost" onClick={onClose}>Close</button>
      </header>
      {error !== null && <p className="error">{error}</p>}
      {chats === null && error === null && <p className="muted">Loading…</p>}
      {chats !== null && (
        <ul className="chats-list">
          {chats.map((listing) => (
            <li key={listing.file}>
              <button
                type="button"
                className="chat-listing"
                aria-current={listing.current ? "true" : undefined}
                disabled={listing.current}
                onClick={() => run({ type: "switch_session", sessionPath: listing.file })}
              >
                <span className="chat-listing-title">{listing.title ?? formatWhen(listing.startedAt)}</span>
                <span className="muted small">{listing.current ? "open now · " : ""}{formatWhen(listing.updatedAt)}</span>
              </button>
            </li>
          ))}
          {chats.length === 0 && <li className="muted">No chats yet.</li>}
        </ul>
      )}
      <div className="actions">
        <button type="button" className="send" onClick={() => run({ type: "new_session" })}>New chat</button>
      </div>
    </dialog>
  );
}

/** CHAT-3: the chat's title, folder, model, effort and context, and its chats. */
function ChatHeader({ chat, connection, onError }: { chat: ChatState; connection: ChatConnection; onError: (text: string) => void }) {
  const [models, setModels] = useState<Json[] | null>(null);
  const [levels, setLevels] = useState<{ model: string; levels: string[] } | null>(null);
  const [chatsOpen, setChatsOpen] = useState(false);
  const model = modelOf(chat.state.model);
  const ready = connection.connected && chat.loaded;
  // Asked once the chat is there, not as part of its snapshot: discovering models can take a while.
  useEffect(() => {
    if (!ready || models !== null) return;
    connection.request({ type: "rpc", command: { type: "get_available_models" } }).then(
      (response) => { if (response.success && isRecord(response.data)) setModels(records(response.data.models)); },
      () => {},
    );
  }, [ready, models]);
  // The efforts depend on the model.
  useEffect(() => {
    if (!ready || model === null || levels?.model === model.key) return;
    const key = model.key;
    connection.request({ type: "rpc", command: { type: "get_available_thinking_levels" } }).then(
      (response) => { if (response.success && isRecord(response.data)) setLevels({ model: key, levels: strings(response.data.levels) }); },
      () => {},
    );
  }, [ready, model?.key, levels?.model]);
  const rpc = (command: OmpFrame) => {
    connection.request({ type: "rpc", command }).then(
      (response) => { if (!response.success) onError(response.error ?? `${command.type} failed.`); },
      (cause: Error) => onError(cause.message),
    );
  };
  const choices = (models ?? []).map(modelOf).filter((choice) => choice !== null);
  if (model !== null && !choices.some((choice) => choice.key === model.key)) choices.unshift(model);
  const thinking = str(chat.state.thinkingLevel) ?? "off";
  const efforts = levels?.model === model?.key ? [...(levels?.levels ?? [])] : [];
  if (!efforts.includes(thinking)) efforts.unshift(thinking);
  const usage = isRecord(chat.state.contextUsage) ? chat.state.contextUsage : {};
  const percent = num(usage.percent);
  const tokens = num(usage.tokens);
  const window = num(usage.contextWindow);
  const title = str(chat.state.sessionName);
  return (
    <header className="chat-head">
      <div className="chat-heading">
        <h2 className="chat-title">{title ?? (chat.loaded ? "New chat" : "Chat")}</h2>
        {chat.cwd !== "" && <code className="chat-folder" aria-label="Folder" title={chat.cwd}>{chat.cwd}</code>}
      </div>
      <div className="chat-controls">
        <select
          aria-label="Model"
          value={model?.key ?? ""}
          disabled={!ready}
          onChange={(event) => {
            const chosen = choices.find((choice) => choice.key === event.target.value);
            if (chosen !== undefined) rpc({ type: "set_model", provider: chosen.provider, modelId: chosen.id });
          }}
        >
          {model === null && <option value="">Default model</option>}
          {choices.map((choice) => <option key={choice.key} value={choice.key}>{choice.name} ({choice.provider})</option>)}
        </select>
        <select aria-label="Effort" value={thinking} disabled={!ready} onChange={(event) => rpc({ type: "set_thinking_level", level: event.target.value })}>
          {efforts.map((level) => <option key={level} value={level}>{level}</option>)}
        </select>
        <div
          role="meter"
          aria-label="Context"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent ?? 0}
          aria-valuetext={percent === null ? "unknown" : `${Math.round(percent)}% of the context`}
          className={percent !== null && percent >= 80 ? "context-meter full" : "context-meter"}
          title={tokens === null || window === null ? "Context use unknown" : `${formatTokens(tokens)} of ${formatTokens(window)} tokens`}
        >
          <span className="context-bar"><span style={{ width: `${Math.min(100, percent ?? 0)}%` }} /></span>
          <span className="context-text">{percent === null ? "–" : `${Math.round(percent)}%`}</span>
        </div>
        <button type="button" disabled={!ready} onClick={() => setChatsOpen(true)}>Chats</button>
      </div>
      {chatsOpen && <ChatsDialog connection={connection} onClose={() => setChatsOpen(false)} onError={onError} />}
    </header>
  );
}

/** The model's thinking: open while it streams, folded once the message is done. */
function Thinking({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(streaming);
  useEffect(() => setOpen(streaming), [streaming]);
  return (
    <details className="thinking" aria-label="Thinking" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Thinking</summary>
      <p className="thinking-text">{text}</p>
    </details>
  );
}

function ItemView({ item, resolveUrl, imageUrl }: { item: Item; resolveUrl: (url: string, kind: "image" | "link") => string | null; imageUrl: ImageUrl }) {
  switch (item.kind) {
    case "user":
      return (
        <article className="msg-user" aria-label="Your message">
          {item.text !== "" && <p className="msg-text">{item.text}</p>}
          <ChatImages images={item.images} imageUrl={imageUrl} />
        </article>
      );
    case "thinking":
      return <Thinking text={item.text} streaming={item.streaming} />;
    case "reply":
      return (
        <article className={item.streaming ? "msg-reply streaming" : "msg-reply"} aria-label="Reply">
          {item.text !== "" && <Markdown text={item.text} resolveUrl={resolveUrl} />}
          <ChatImages images={item.images} imageUrl={imageUrl} />
        </article>
      );
    case "tool":
      return <ToolCall tool={item.tool} imageUrl={imageUrl} />;
    case "notice":
      return <p className={`chat-notice notice-${item.level}`}>{item.text}</p>;
    case "compaction":
      return (
        <details className="chat-divider">
          <summary>Context compacted</summary>
          <Markdown text={item.summary} />
        </details>
      );
    case "note":
      return (
        <details className="chat-note">
          <summary>{item.label}</summary>
          <pre>{item.text}</pre>
        </details>
      );
  }
}

/** Distance from the bottom within which the log follows new lines. */
const STICK_PX = 48;

/** CHAT-1: the transcript; it follows new lines only while it is scrolled to the bottom. */
function Transcript({ chat, items, sessionId, onLoadEarlier }: { chat: ChatState; items: Item[]; sessionId: string; onLoadEarlier: () => Promise<void> }) {
  const log = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // Where the log last scrolled itself; a scroll event can land after content grew again, which alone would read as the person scrolling up.
  const autoTop = useRef(Number.POSITIVE_INFINITY);
  const fromBottom = useRef<number | null>(null);
  const [loading, setLoading] = useState(false);
  const toBottom = () => {
    const element = log.current;
    if (element === null || !stick.current) return;
    element.scrollTop = element.scrollHeight;
    autoTop.current = element.scrollTop;
  };
  useLayoutEffect(() => {
    const element = log.current;
    if (element !== null && fromBottom.current !== null) {
      // Earlier messages came in above: keep what was in view where it was.
      element.scrollTop = element.scrollHeight - fromBottom.current;
      autoTop.current = Number.POSITIVE_INFINITY;
      fromBottom.current = null;
      return;
    }
    toBottom();
  }, [items]);
  // Images and opened cards change the height after rendering.
  useEffect(() => {
    if (content.current === null) return;
    const observer = new ResizeObserver(toBottom);
    observer.observe(content.current);
    return () => observer.disconnect();
  }, []);
  const resolveUrl = (url: string, kind: "image" | "link"): string | null => {
    if (kind === "image" && /^data:image\//i.test(url)) return url;
    const path = /^file:\/\//i.test(url) ? decodeURIComponent(url.slice("file://".length)) : url;
    // Web addresses, anchors and omp's own schemes (local://, artifact://) are not workspace files.
    if (path === "" || path.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
    return storeUrl(`/sessions/${sessionId}/file?path=${encodeURIComponent(path)}`);
  };
  const imageUrl = (image: ImageBlock): string => {
    const blob = /^blob:sha256:([0-9a-f]{64})$/.exec(image.data);
    return blob === null ? `data:${image.mimeType};base64,${image.data}` : storeUrl(`/sessions/${sessionId}/blob/${blob[1]}`);
  };
  const loadEarlier = () => {
    const element = log.current;
    if (element !== null) fromBottom.current = element.scrollHeight - element.scrollTop;
    setLoading(true);
    void onLoadEarlier().finally(() => setLoading(false));
  };
  return (
    <div
      ref={log}
      className="chat-log"
      role="log"
      aria-label="Conversation"
      onScroll={() => {
        const element = log.current;
        if (element !== null) stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_PX || element.scrollTop >= autoTop.current - 1;
      }}
    >
      <div ref={content} className="chat-items">
        {chat.olderMessages > 0 && (
          <button type="button" className="ghost load-earlier" disabled={loading} onClick={loadEarlier}>
            {loading ? "Loading…" : `Load earlier (${chat.olderMessages})`}
          </button>
        )}
        {chat.loaded && items.length === 0 && <p className="chat-empty muted">No messages yet.</p>}
        {items.map((item) => <ItemView key={item.key} item={item} resolveUrl={resolveUrl} imageUrl={imageUrl} />)}
        {isRunning(chat) && <p className="chat-working" aria-hidden="true">Working…</p>}
      </div>
    </div>
  );
}

/**
 * CHAT-1..9: one session's chat, drawn from what its chat host sends through the gateway:
 * the transcript, the open dialogs, and the prompt box with its queue.
 */
function Chat({ sessionId, stopped, folderOwner }: { sessionId: string; stopped: boolean; folderOwner: FolderOwner | null }) {
  const [chat, dispatch] = useReducer(chatReducer, EMPTY_CHAT);
  const connection = useChatSocket(sessionId, (message) => dispatch({ kind: "server", message }));
  const draft = useDraft(sessionId);
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const [sending, setSending] = useState<"no" | "waiting" | "sending">("no");
  const [error, setError] = useState<string | null>(null);
  const items = buildItems(chat);
  const running = isRunning(chat);
  const ready = connection.connected && chat.loaded;
  const notify = (text: string) => dispatch({ kind: "notice", level: "error", text });

  const sendNow = async () => {
    const sent = draft.draft;
    const images = sent.attachments.filter(isPromptImage);
    const files = sent.attachments.filter((attachment) => !isPromptImage(attachment));
    if (files.length > 0 && (chat.folder === null || folderOwner === null)) {
      setError("This session has no folder, so only images can go with a prompt; remove the other files.");
      setSending("no");
      return;
    }
    if (images.reduce((total, image) => total + image.data.length, 0) > MAX_PROMPT_IMAGE_BYTES) {
      setError("The images are too large for one prompt; send fewer at a time.");
      setSending("no");
      return;
    }
    setSending("sending");
    try {
      const at = new Date();
      const paths: string[] = [];
      for (const file of files) {
        const path = folderPathOf(file.name, at);
        if (folderOwner !== null) await api("PUT", fileRoute(folderOwner, path), blobOf(file));
        paths.push(`${chat.folder}/${path}`);
      }
      const message = [sent.text, paths.map((path) => `Attached file: ${path}`).join("\n")].filter((part) => part !== "").join("\n\n");
      const response = await connection.request({
        type: "rpc",
        command: {
          type: "prompt",
          message,
          ...(images.length === 0 ? {} : { images: images.map((image) => ({ type: "image", mimeType: image.mimeType, data: image.data })) }),
          ...(running ? { streamingBehavior: "steer" } : {}),
        },
      });
      if (response.success) draft.clear(sent);
      else setError(response.error ?? "The agent did not take the prompt.");
    } catch (cause) {
      setError(`${cause instanceof Error ? cause.message : String(cause)} The message stays in the box; send it again if it does not show in the chat.`);
    } finally {
      setSending("no");
    }
  };
  const send = () => {
    if (sending !== "no" || (draft.draft.text.trim() === "" && draft.draft.attachments.length === 0)) return;
    setError(null);
    if (ready) void sendNow();
    else setSending("waiting");
  };
  // CHAT-6: a prompt sent while the chat was away goes once it is back.
  useEffect(() => {
    if (sending === "waiting" && ready) void sendNow();
  }, [sending, ready]);

  const answer = (dialog: OmpFrame, response: DialogAnswer) => {
    const id = str(dialog.id);
    if (id === null) return;
    if (connection.send({ type: "dialog_response", response: { ...response, id } })) setAnswered(new Set([...answered, id]));
    else notify("The chat is not connected; answer again once it is back.");
  };
  const stop = () => {
    connection.request({ type: "rpc", command: { type: "abort" } }).then(
      (response) => { if (!response.success) notify(response.error ?? "The turn could not be stopped."); },
      (cause: Error) => notify(cause.message),
    );
  };
  const removeQueued = (message: string, queue: "steering" | "followUp") => {
    connection.request({ type: "rpc", command: { type: "remove_queued_message", message, queue } }).then(
      (response) => {
        if (!response.success) notify(response.error ?? "The queued message could not be removed.");
        else if (isRecord(response.data) && response.data.removed === false) notify("The agent already took that message.");
      },
      (cause: Error) => notify(cause.message),
    );
  };
  const loadEarlier = async () => {
    try {
      const response = await connection.request({ type: "history", before: chat.olderMessages, limit: HISTORY_PAGE });
      const parsed = HistorySchema.safeParse(response.data);
      if (!response.success || !parsed.success) notify(response.error ?? "Earlier messages could not be loaded.");
      else dispatch({ kind: "older", messages: parsed.data.messages, olderMessages: parsed.data.olderMessages });
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : String(cause));
    }
  };

  // SESSION-13: what the page waits on.
  const status = connection.refused
    ?? (!chat.loaded
      ? connection.problem ?? chat.status ?? (stopped ? "Starting the session's container…" : "Connecting to the agent…")
      : !connection.connected
        ? `Reconnecting…${connection.problem === null ? "" : ` (${connection.problem})`}${sending === "waiting" ? " The message goes once the chat is back." : ""}`
        : !chat.ompRunning
          ? "The agent is starting again…"
          : sending === "sending" ? "Sending…" : "");
  const dialogs = chat.dialogs.filter((dialog) => typeof dialog.id !== "string" || !answered.has(dialog.id));

  return (
    <section className="chat" aria-label="Chat">
      <ChatHeader chat={chat} connection={connection} onError={notify} />
      <Transcript chat={chat} items={items} sessionId={sessionId} onLoadEarlier={loadEarlier} />
      {dialogs.length > 0 && (
        <div className="agent-dialogs">
          {dialogs.map((dialog) => <AgentDialog key={str(dialog.id) ?? ""} dialog={dialog} onAnswer={(response) => answer(dialog, response)} />)}
        </div>
      )}
      <p className={["chat-status", chat.loaded ? "" : "waiting", connection.refused === null ? "" : "error"].filter((name) => name !== "").join(" ")} role="status">{status}</p>
      {error !== null && <p className="chat-error error">{error}</p>}
      <Composer
        draft={draft}
        running={running}
        commands={chat.commands}
        queue={chat.queue}
        canAttachFiles={!chat.loaded || chat.folder !== null}
        onSend={send}
        onStop={stop}
        onRemoveQueued={removeQueued}
        onError={setError}
      />
    </section>
  );
}

/**
 * UI-2, SESSION-13: the current session's chat in the workspace. Only that session's chat is
 * mounted (and connected); it first connects when its Chat tab shows, so a task's page does not
 * start a stopped container, and then stays while another tab covers it, keeping its place.
 */
export function SessionChat({ current, covered, running, stopped, folderOwner }: {
  current: string | null;
  covered: boolean;
  /** The running sessions; null while they load. */
  running: ReadonlySet<string> | null;
  stopped: ReadonlySet<string>;
  /** Whose folder pasted files go to (CHAT-4): the task's or the automation's. */
  folderOwner: FolderOwner | null;
}) {
  const [opened, setOpened] = useState<string | null>(null);
  useEffect(() => {
    setOpened((before) => (!covered ? current : before === current ? before : null));
  }, [current, covered]);
  const shown = current !== null && opened === current && (running === null || running.has(current)) ? current : null;
  return (
    <div className={covered ? "session-chat covered" : "session-chat"} hidden={current === null}>
      {shown !== null && <Chat key={shown} sessionId={shown} stopped={stopped.has(shown)} folderOwner={folderOwner} />}
    </div>
  );
}
