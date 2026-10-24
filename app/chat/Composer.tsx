import { useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { sizeOf } from "../Folder.tsx";
import { attachmentOf, isPromptImage } from "./attachments.ts";
import type { Draft } from "./draft.ts";
import { isRecord, str, strings, type ChatQueue, type Json } from "./transcript.ts";

/** Slash commands whose name (or alias) starts with what follows the typed `/`. */
function suggestionsFor(text: string, commands: Json[]): Json[] {
  const typed = /^\/(\S*)$/.exec(text)?.[1];
  if (typed === undefined) return [];
  return commands
    .filter((command) => [str(command.name) ?? "", ...strings(command.aliases)].some((name) => name.startsWith(typed)))
    .filter((command) => str(command.name) !== typed)
    .slice(0, 8);
}

/**
 * CHAT-4, CHAT-6, CHAT-8: the prompt box. Enter sends, Shift+Enter breaks the line; while a
 * turn runs, Send steers it and Stop stops it. Images and files come by Attach, pasting, or
 * dropping; `/` suggests omp's commands. Everything typed stays in the draft until omp took it.
 */
export function Composer({ draft, running, commands, queue, canAttachFiles, onSend, onStop, onRemoveQueued, onError }: {
  draft: Draft;
  running: boolean;
  commands: Json[];
  queue: ChatQueue;
  /** False when the session has no folder: then only images can go with a prompt. */
  canAttachFiles: boolean;
  onSend: () => void;
  onStop: () => void;
  onRemoveQueued: (message: string, queue: keyof ChatQueue) => void;
  onError: (message: string) => void;
}) {
  const { text, attachments } = draft.draft;
  const picker = useRef<HTMLInputElement>(null);
  const [highlight, setHighlight] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const suggestions = dismissed === text ? [] : suggestionsFor(text, commands);
  const chosen = suggestions[Math.min(highlight, suggestions.length - 1)];

  const addFiles = async (files: File[]) => {
    const refused = files.filter((file) => !canAttachFiles && !isPromptImage({ mimeType: file.type }));
    if (refused.length > 0) onError(`This session has no folder, so only images can go with a prompt: ${refused.map((file) => file.name).join(", ")} not attached.`);
    const taken = files.filter((file) => !refused.includes(file));
    if (taken.length === 0) return;
    try {
      const added = await Promise.all(taken.map(attachmentOf));
      draft.change({ attachments: (latest) => [...latest, ...added] });
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const complete = (command: Json) => {
    draft.change({ text: `/${str(command.name) ?? ""} ` });
    setHighlight(0);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (chosen !== undefined) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setHighlight((Math.min(highlight, suggestions.length - 1) + (event.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length);
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault();
        complete(chosen);
        return;
      }
      if (event.key === "Escape") {
        setDismissed(text);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSend();
    }
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files];
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(files);
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    setDragging(false);
    const files = [...event.dataTransfer.files];
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(files);
  };
  const queued = [
    ...queue.steering.map((message) => ({ message, queue: "steering" as const })),
    ...queue.followUp.map((message) => ({ message, queue: "followUp" as const })),
  ];

  return (
    <div
      className={dragging ? "composer dragging" : "composer"}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {queued.length > 0 && (
        <ul className="chat-queue" aria-label="Queued">
          {queued.map((item, index) => (
            <li key={`${item.queue}-${index}`}>
              <span className="queued-mark">{item.queue === "steering" ? "Steering" : "Next"}</span>
              <span className="queued-text">{item.message}</span>
              <button type="button" className="ghost" onClick={() => onRemoveQueued(item.message, item.queue)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      {suggestions.length > 0 && (
        <ul className="command-suggestions" role="listbox" aria-label="Commands">
          {suggestions.map((command, index) => (
            <li
              key={str(command.name) ?? index}
              role="option"
              aria-selected={command === chosen}
              onMouseDown={(event) => { event.preventDefault(); complete(command); }}
            >
              <code>/{str(command.name)}</code>
              {isRecord(command.input) && str(command.input.hint) !== null && <span className="muted"> {str(command.input.hint)}</span>}
              {str(command.description) !== null && <span className="muted small"> {str(command.description)}</span>}
            </li>
          ))}
        </ul>
      )}
      {attachments.length > 0 && (
        <ul className="attachments" aria-label="Attachments">
          {attachments.map((attachment, index) => (
            <li key={`${attachment.name}-${index}`} className="attachment">
              {isPromptImage(attachment)
                ? <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt="" />
                : <span className="attachment-file" aria-hidden="true">▤</span>}
              <span className="attachment-name">{attachment.name}</span>
              <span className="muted small">{sizeOf(Math.floor((attachment.data.length * 3) / 4))}</span>
              <button
                type="button"
                className="ghost"
                aria-label={`Remove ${attachment.name}`}
                onClick={() => draft.change({ attachments: attachments.filter((_, at) => at !== index) })}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="composer-box">
        <textarea
          aria-label="Message"
          placeholder={running ? "Steer the agent… (Enter sends)" : "Message the agent… (Enter sends, Shift+Enter for a new line)"}
          rows={3}
          value={text}
          onChange={(event) => {
            draft.change({ text: event.target.value });
            setHighlight(0);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <div className="composer-actions">
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              void addFiles([...(event.target.files ?? [])]);
              event.target.value = "";
            }}
          />
          <button type="button" className="ghost" onClick={() => picker.current?.click()}>Attach</button>
          {running && <button type="button" className="danger" onClick={onStop}>Stop</button>}
          <button type="button" className="send" onClick={onSend}>Send</button>
        </div>
      </div>
      {draft.saveError !== null && <p className="muted small">Not saved on the gateway: {draft.saveError}</p>}
    </div>
  );
}
