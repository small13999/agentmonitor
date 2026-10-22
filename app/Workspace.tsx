import { useEffect, useRef, useState, type SubmitEvent } from "react";
import { api, ApiError, usePolled, type Session, type SessionRuntime, type Task, type TaskNotes } from "./api.ts";

export type WorkspaceTab = "chat" | "notes";

/** Typing pauses this long before the notes are saved. */
const SAVE_DELAY_MS = 500;

function GearIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/** UI-2: the task workspace's tabs, Chat and Notes, and at the far right its settings. */
export function WorkspaceTabs({ taskId, tab, settingsOpen, onSettings }: {
  taskId: string;
  tab: WorkspaceTab;
  settingsOpen: boolean;
  onSettings: () => void;
}) {
  const tabs: Array<{ id: WorkspaceTab; label: string; href: string }> = [
    { id: "chat", label: "Chat", href: `#/t/${taskId}` },
    { id: "notes", label: "Notes", href: `#/t/${taskId}/notes` },
  ];
  return (
    <header className="workspace-tabs">
      <nav role="tablist" aria-label="Workspace">
        {tabs.map((entry) => (
          <a key={entry.id} role="tab" className="tab" aria-selected={entry.id === tab} href={entry.href}>{entry.label}</a>
        ))}
      </nav>
      <button type="button" className="icon-button" aria-label="Workspace settings" aria-expanded={settingsOpen} onClick={onSettings}>
        <GearIcon />
      </button>
    </header>
  );
}

/**
 * The Chat tab of a task without a running session (TASK-3): starting one, in a container or,
 * where the project allows it, on the host (HOST-1), also in the main checkout and going on
 * with one of the user's omp chats (HOST-6, HOST-7); or reopening a finished task first.
 */
export function StartSession({ task, hostSessions, onStarted }: { task: Task; hostSessions: boolean; onStarted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState<SessionRuntime | "checkout" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = (call: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    call().then(
      () => { setBusy(false); onStarted(); },
      (cause: Error) => { setBusy(false); setError(cause.message); },
    );
  };
  const start = (kind: SessionRuntime | "checkout", body: Record<string, unknown>) => {
    setStarting(kind);
    run(() => api<Session>("POST", `/tasks/${task.id}/sessions`, body));
  };
  const startInCheckout = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const resume = String(new FormData(event.currentTarget).get("resume")).trim();
    start("checkout", { runtime: "host", checkout: true, ...(resume === "" ? {} : { resume }) });
  };
  const finished = task.state === "done" || task.state === "cancelled";
  return (
    <section className="workspace-page start-session" aria-label="Start session">
      <h2>{task.title}</h2>
      {task.description.trim() !== "" && <p className="description">{task.description}</p>}
      {finished ? (
        <>
          <p className="muted">This task is {task.state === "done" ? "done" : "cancelled"}.</p>
          <button type="button" disabled={busy} onClick={() => run(() => api<Task>("PATCH", `/tasks/${task.id}`, { state: "open" }))}>
            Reopen task
          </button>
        </>
      ) : (
        <>
          <p className="muted">
            No session is running.{task.branch !== null && <> Work continues on <code>{task.branch}</code>.</>}
          </p>
          <div className="actions">
            <button type="button" disabled={busy} onClick={() => start("container", { runtime: "container" })}>
              {busy && starting === "container" ? "Starting…" : "Start session"}
            </button>
            {hostSessions && (
              <button
                type="button"
                className="danger"
                disabled={busy}
                title="The agent runs on this machine as you, without a container"
                onClick={() => start("host", { runtime: "host" })}
              >
                {busy && starting === "host" ? "Starting…" : "Start host session"}
              </button>
            )}
          </div>
          {hostSessions && (
            <form className="actions" aria-label="Main checkout" onSubmit={startInCheckout}>
              <input name="resume" placeholder="omp chat id to go on with (optional)" aria-label="omp chat to resume" disabled={busy} />
              <button
                type="submit"
                className="danger"
                disabled={busy}
                title="A host session in the project's main checkout, the live code, instead of a worktree; one per project"
              >
                {busy && starting === "checkout" ? "Starting…" : "Start in main checkout"}
              </button>
            </form>
          )}
        </>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

/** The notes a refused write found in the store instead of the revision it edited. */
function conflictOf(cause: unknown): TaskNotes | null {
  if (!(cause instanceof ApiError)) return null;
  const { text, currentRevision } = cause.details;
  return typeof text === "string" && typeof currentRevision === "number" ? { text, revision: currentRevision } : null;
}

/**
 * TASK-8: the task's notes, saved as you type. Writes run one at a time, each based on the
 * revision the last one returned; a write that finds someone else's newer revision is
 * refused, and you choose which text to keep. Changes made elsewhere show while you have no
 * unsaved edits.
 */
export function Notes({ taskId, hidden }: { taskId: string; hidden: boolean }) {
  const polled = usePolled<TaskNotes>(`/tasks/${taskId}/notes`, 5_000);
  const [text, setText] = useState("");
  const [saved, setSaved] = useState<TaskNotes | null>(null);
  const [conflict, setConflict] = useState<TaskNotes | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Saves outlive renders, and the last one outlives the component: they read these.
  const latest = useRef({ text, saved, conflict });
  latest.current = { text, saved, conflict };
  const chain = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(true);

  const save = () => {
    chain.current = chain.current.then(async () => {
      const { text: value, saved: base, conflict: open } = latest.current;
      if (base === null || open !== null || value === base.text) return;
      try {
        const next = await api<TaskNotes>("PUT", `/tasks/${taskId}/notes`, { text: value, baseRevision: base.revision });
        latest.current = { ...latest.current, saved: next };
        if (mounted.current) { setSaved(next); setError(null); }
      } catch (cause) {
        if (!mounted.current) return;
        const theirs = conflictOf(cause);
        if (theirs !== null) setConflict(theirs);
        else setError(cause instanceof Error ? cause.message : String(cause));
      }
    });
  };

  // The store's notes: the first read fills the editor, later ones replace it while nothing is unsaved.
  useEffect(() => {
    const data = polled.data;
    const { text: current, saved: base } = latest.current;
    if (data === null || (base !== null && (data.revision <= base.revision || current !== base.text))) return;
    setSaved(data);
    setText(data.text);
  }, [polled.data]);

  useEffect(() => {
    if (saved === null || conflict !== null || text === saved.text) return;
    const timer = setTimeout(save, SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text, saved, conflict]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      save();
    };
  }, []);

  const resolve = (keep: "mine" | "theirs") => {
    if (conflict === null) return;
    setSaved(conflict);
    if (keep === "theirs") setText(conflict.text);
    setConflict(null);
  };

  const state = saved === null ? "Loading…" : conflict !== null ? "Not saved" : text === saved.text ? "Saved" : "Saving…";
  return (
    <section className="notes" aria-label="Notes" hidden={hidden}>
      <textarea
        aria-label="Notes"
        value={text}
        disabled={saved === null}
        placeholder="Notes on this task: plans, links, what to check. Agents can read them with `am notes`."
        onChange={(event) => setText(event.target.value)}
      />
      <footer className="notes-foot">
        <span className="muted small" aria-live="polite">{state}</span>
        {error && <span className="error small">{error}</span>}
        {conflict !== null && (
          <span className="small conflict">
            Someone else changed these notes (revision {conflict.revision}).{" "}
            <button type="button" onClick={() => resolve("mine")}>Keep mine</button>{" "}
            <button type="button" className="ghost" onClick={() => resolve("theirs")}>Use theirs</button>
          </span>
        )}
      </footer>
    </section>
  );
}
