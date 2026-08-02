import { useEffect, useState } from "react";
import {
  createManagedSession,
  pauseManagedSession,
  requiresForce,
  resumeManagedSession,
  type ManagedSession,
} from "./agentctl";

interface ManagedSessionsProps {
  sessions: ManagedSession[];
  onChanged(): Promise<void>;
  onClose(): void;
  onOpen(id: string): void;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function ManagedSessions({ sessions, onChanged, onClose, onOpen }: ManagedSessionsProps) {
  const [title, setTitle] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [forceId, setForceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void onChanged().catch((cause) => setError(errorMessage(cause)));
  }, [onChanged]);

  const create = async () => {
    const nextTitle = title.trim();
    if (nextTitle.length === 0) return;
    setBusyId("new");
    setError(null);
    try {
      const session = await createManagedSession(nextTitle);
      await onChanged();
      setTitle("");
      onOpen(session.id);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusyId(null);
    }
  };

  const resume = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await resumeManagedSession(id);
      await onChanged();
      onOpen(id);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusyId(null);
    }
  };

  const pause = async (id: string, force = false) => {
    setBusyId(id);
    setError(null);
    try {
      await pauseManagedSession(id, force);
      setForceId(null);
      await onChanged();
    } catch (cause) {
      if (requiresForce(cause)) setForceId(id);
      setError(errorMessage(cause));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        aria-label="Agent sessions"
        aria-modal="true"
        className="machine-manager managed-session-manager"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header>
          <div>
            <p className="eyebrow">AGENTCTL</p>
            <h2>Agent sessions</h2>
          </div>
          <button className="secondary" onClick={onClose} type="button">Close</button>
        </header>
        <div className="managed-session-manager__body">
          <form className="new-session-form" onSubmit={(event) => { event.preventDefault(); void create(); }}>
            <h3>Start a session</h3>
            <label>
              Title
              <input
                autoFocus
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Fix terminal reconnect"
                value={title}
              />
            </label>
            <button disabled={busyId !== null || title.trim() === ""} type="submit">
              {busyId === "new" ? "Starting…" : "Start agent"}
            </button>
          </form>
          <section className="managed-session-list">
            <div>
              <h3>Durable sessions</h3>
              <p>Paused sessions keep their worktree, branch, OMP history, and cmux state.</p>
            </div>
            {sessions.length === 0 && <p className="field-note">No agentctl sessions yet.</p>}
            {sessions.map((session) => {
              const running = session.runtime_state === "running";
              return (
                <article className="managed-session-row" key={session.id}>
                  <div>
                    <strong>{session.title || session.id}</strong>
                    <span>{session.id}</span>
                  </div>
                  <span className={`session-state session-state--${running ? "running" : "paused"}`}>
                    {running ? "running" : "paused"}
                  </span>
                  <div className="managed-session-row__actions">
                    {running ? (
                      <>
                        <button className="secondary" onClick={() => onOpen(session.id)} type="button">Open</button>
                        <button
                          className="secondary"
                          disabled={busyId !== null}
                          onClick={() => void pause(session.id)}
                          type="button"
                        >
                          {busyId === session.id ? "Checking…" : "Pause"}
                        </button>
                        {forceId === session.id && (
                          <button
                            className="danger"
                            disabled={busyId !== null}
                            onClick={() => void pause(session.id, true)}
                            type="button"
                          >
                            Force pause
                          </button>
                        )}
                      </>
                    ) : (
                      <button disabled={busyId !== null} onClick={() => void resume(session.id)} type="button">
                        {busyId === session.id ? "Resuming…" : "Resume"}
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
            {error && <div className="app-error">{error}</div>}
          </section>
        </div>
      </section>
    </div>
  );
}
