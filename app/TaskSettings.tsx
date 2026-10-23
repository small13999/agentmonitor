import { useState } from "react";
import { api, type Card, type EndedSession, type TaskSummary } from "./api.ts";
import { HostMark, TurnPill } from "./Board.tsx";

type Subtab = "cloudflare" | "end";

const SUBTABS: Array<{ id: Subtab; label: string }> = [
  { id: "cloudflare", label: "Cloudflare" },
  { id: "end", label: "End session" },
];

/** CLOUDFLARE-2: the agent reads the project's Cloudflare account; it writes only while allowed here. */
function Cloudflare({ card, onChanged }: { card: Card; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const cloudflare = card.cloudflare;
  if (cloudflare === null) {
    return (
      <section className="settings-body" aria-label="Cloudflare">
        <p className="muted small">This project has no Cloudflare tokens in Agent Monitor. The store's owner sets them in the <a href="#/project">project settings</a>.</p>
      </section>
    );
  }
  const change = (method: "POST" | "DELETE") => {
    setError(null);
    api(method, `/sessions/${card.session.id}/cloudflare-writes`).then(onChanged, (cause: Error) => setError(cause.message));
  };
  const until = cloudflare.writesUntil;
  return (
    <section className="settings-body" aria-label="Cloudflare">
      {!cloudflare.canWrite && <p className="muted small">The agent can read. This project has no write token.</p>}
      {cloudflare.canWrite && until === null && (
        <>
          <p className="muted small">The agent can read. Writes are off.</p>
          <div className="actions"><button type="button" onClick={() => change("POST")}>Allow writes for 10 min</button></div>
        </>
      )}
      {cloudflare.canWrite && until !== null && (
        <>
          <p className="small">
            Writes allowed until {new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{" "}
            ({Math.max(1, Math.ceil((until - Date.now()) / 60_000))} min left).
          </p>
          <div className="actions">
            <button type="button" onClick={() => change("POST")}>Reset to 10 min</button>
            <button type="button" className="ghost" onClick={() => change("DELETE")}>Revoke</button>
          </div>
        </>
      )}
      {error && <p className="error small">{error}</p>}
    </section>
  );
}

/** SESSION-8/SESSION-9: ending loses nothing; the subtab says what ending does, and then what it kept. */
function EndSession({ card, onEnded }: { card: Card; onEnded: (ended: EndedSession) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = () => {
    setBusy(true);
    setError(null);
    api<EndedSession>("POST", `/sessions/${card.session.id}/end`, {}).then(onEnded, (cause: Error) => {
      setError(cause.message);
      setBusy(false);
    });
  };
  return (
    <section className="settings-body end-session" aria-label="End session">
      <p className="small">
        Ending the session deletes its container and worktree. The task, its branch, and the chats stay;
        uncommitted files are kept for the task's next session.
      </p>
      {error && <p className="error small">{error}</p>}
      <div className="actions">
        <button type="button" className="danger" disabled={busy} onClick={end}>{busy ? "Ending…" : "End session"}</button>
      </div>
    </section>
  );
}

/**
 * UI-2: the task's Settings tab, for its session: the agent's Cloudflare writes and ending the
 * session. Task fields and the branch's work live on the task's page. HOST-3: a host session is
 * marked here too.
 */
export function TaskSettings({ summary, card, onChanged }: { summary: TaskSummary; card: Card | null; onChanged: () => void }) {
  const [subtab, setSubtab] = useState<Subtab>("cloudflare");
  const [ended, setEnded] = useState<EndedSession | null>(null);
  const noSession = <p className="muted small">{summary.sessionId === null ? "No session is running." : "Loading the session…"}</p>;
  return (
    <section className="workspace-page task-settings" aria-label="Settings">
      <header className="settings-head">
        <h2>{summary.task.title}</h2>
        {card !== null && <TurnPill turn={card.turn} />}
        <HostMark card={card} />
      </header>
      <nav role="tablist" aria-label="Settings" className="subtabs">
        {SUBTABS.map((entry) => (
          <button key={entry.id} type="button" role="tab" className="subtab" aria-selected={entry.id === subtab} onClick={() => setSubtab(entry.id)}>
            {entry.label}
          </button>
        ))}
      </nav>
      {subtab === "cloudflare" && (card === null ? noSession : <Cloudflare card={card} onChanged={onChanged} />)}
      {subtab === "end" && ended !== null && (
        <p className="small" role="status">
          Session ended.{" "}
          {ended.kept.length === 0
            ? "Nothing was uncommitted."
            : `${ended.kept.length} uncommitted file${ended.kept.length === 1 ? " was" : "s were"} kept for the task's next session.`}
        </p>
      )}
      {subtab === "end" && ended === null && (card === null ? noSession : <EndSession card={card} onEnded={(result) => { setEnded(result); onChanged(); }} />)}
    </section>
  );
}
