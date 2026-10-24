import { useState, type ReactNode } from "react";
import { api, type Session, type SessionRuntime, type Task } from "./api.ts";

export type WorkspaceTab = "page" | "chat" | "settings";

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

function GearIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Icon>
  );
}

/**
 * UI-2: a task's or an automation's tabs: its Page, its Chat, and at the far right, with the
 * gear, its Settings. Each tab is a link, so a tab has its own address: the page at `base`,
 * settings at `<base>/settings`, the chat at `chat`; null: no chat to show, so no Chat tab.
 * PREVIEW-1: `preview` is the task's preview host while its session shows a port; it opens in
 * a tab of its own, being another origin (PREVIEW-2).
 */
export function WorkspaceTabs({ base, tab, chat, preview }: { base: string; tab: WorkspaceTab; chat: string | null; preview: string | null }) {
  return (
    <header className="workspace-tabs">
      <nav role="tablist" aria-label="Workspace">
        <a role="tab" className="tab" aria-selected={tab === "page"} href={base}>
          <Icon><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></Icon>Page
        </a>
        {chat !== null && (
          <a role="tab" className="tab" aria-selected={tab === "chat"} href={chat}>
            <Icon><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" /></Icon>Chat
          </a>
        )}
        {preview !== null && (
          <a className="tab" href={preview} target="_blank" rel="noreferrer">
            <Icon><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></Icon>Preview
          </a>
        )}
        <a role="tab" className="tab settings-tab" aria-selected={tab === "settings"} href={`${base}/settings`}>
          <GearIcon />Settings
        </a>
      </nav>
    </header>
  );
}

/**
 * The Chat tab of a task without a running session (TASK-3): starting one, in a container or,
 * where the project allows it, on the host (HOST-1), also in the main checkout among the user's
 * omp chats (HOST-6, HOST-7); or reopening a finished task first.
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
            {hostSessions && (
              <button
                type="button"
                className="danger"
                disabled={busy}
                title="A host session in the project's main checkout, the live code, with your omp chats there to go on with (/resume); one per project"
                onClick={() => start("checkout", { runtime: "host", checkout: true })}
              >
                {busy && starting === "checkout" ? "Starting…" : "Start in main checkout"}
              </button>
            )}
          </div>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
