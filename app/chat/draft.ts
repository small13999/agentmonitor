import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { ChatDraft, DraftAttachment } from "../../shared/chat.ts";
import { api } from "../api.ts";

const DraftSchema = z.object({
  text: z.string(),
  attachments: z.array(z.object({ name: z.string(), mimeType: z.string(), data: z.string() })),
  updatedAt: z.number(),
});

const EMPTY_DRAFT: ChatDraft = { text: "", attachments: [], updatedAt: 0 };
/** How long typing pauses before the draft goes to the gateway. */
const SAVE_DELAY_MS = 400;

function storageKey(sessionId: string): string {
  return `am.chat.draft.${sessionId}`;
}

function readLocal(sessionId: string): ChatDraft {
  const stored = localStorage.getItem(storageKey(sessionId));
  if (stored === null) return EMPTY_DRAFT;
  const parsed = DraftSchema.safeParse(JSON.parse(stored));
  return parsed.success ? parsed.data : EMPTY_DRAFT;
}

function writeLocal(sessionId: string, draft: ChatDraft): void {
  if (draft.text === "" && draft.attachments.length === 0) {
    localStorage.removeItem(storageKey(sessionId));
    return;
  }
  try {
    localStorage.setItem(storageKey(sessionId), JSON.stringify(draft));
  } catch {
    // Attachments can outgrow the browser's storage; the text stays here, the files on the gateway.
    localStorage.setItem(storageKey(sessionId), JSON.stringify({ ...draft, attachments: [] }));
  }
}

export interface Draft {
  draft: ChatDraft;
  /** A change the person made; saved at once in the browser, shortly after on the gateway. Attachments may be given as a change of the latest ones, for files that finish reading one after another. */
  change: (change: { text?: string; attachments?: DraftAttachment[] | ((latest: DraftAttachment[]) => DraftAttachment[]) }) => void;
  /** Empties the box once omp took `sent`, unless the person changed the draft since. */
  clear: (sent: ChatDraft) => void;
  /** Why the gateway did not take the last save; null when it did. */
  saveError: string | null;
}

/**
 * CHAT-6: the prompt box's draft for one session, saved as it changes: in the browser's
 * storage, and (debounced) on the gateway for other browsers and after a lost connection. On
 * opening, the newer of the two wins.
 */
export function useDraft(sessionId: string): Draft {
  const [draft, setDraft] = useState<ChatDraft>(() => readLocal(sessionId));
  const [saveError, setSaveError] = useState<string | null>(null);
  const latest = useRef(draft);
  latest.current = draft;
  const timer = useRef<number | undefined>(undefined);
  const unsaved = useRef(false);

  const save = (value: ChatDraft) => {
    window.clearTimeout(timer.current);
    unsaved.current = false;
    api<null>("PUT", `/sessions/${sessionId}/draft`, value).then(
      () => setSaveError(null),
      (cause: Error) => setSaveError(cause.message),
    );
  };

  useEffect(() => {
    let cancelled = false;
    setDraft(readLocal(sessionId));
    api<unknown>("GET", `/sessions/${sessionId}/draft`).then(
      (stored) => {
        const parsed = DraftSchema.nullable().safeParse(stored);
        if (cancelled || !parsed.success || parsed.data === null) return;
        const server = parsed.data;
        // Whatever was typed meanwhile is newer still.
        setDraft((current) => (server.updatedAt > current.updatedAt ? server : current));
        if (server.updatedAt > latest.current.updatedAt) writeLocal(sessionId, server);
      },
      () => {},
    );
    return () => {
      cancelled = true;
      // Leaving the chat saves what is still waiting for the pause.
      if (unsaved.current) save(latest.current);
    };
  }, [sessionId]);

  const update = (next: ChatDraft) => {
    latest.current = next;
    setDraft(next);
    writeLocal(sessionId, next);
  };
  const change = ({ text, attachments }: { text?: string; attachments?: DraftAttachment[] | ((latest: DraftAttachment[]) => DraftAttachment[]) }) => {
    const before = latest.current;
    const next = {
      text: text ?? before.text,
      attachments: attachments === undefined ? before.attachments : typeof attachments === "function" ? attachments(before.attachments) : attachments,
      updatedAt: Date.now(),
    };
    update(next);
    unsaved.current = true;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => save(next), SAVE_DELAY_MS);
  };
  const clear = (sent: ChatDraft) => {
    if (latest.current.updatedAt !== sent.updatedAt) return;
    const empty = { ...EMPTY_DRAFT, updatedAt: Date.now() };
    update(empty);
    save(empty);
  };
  return { draft, change, clear, saveError };
}
