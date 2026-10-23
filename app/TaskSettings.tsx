import { useState } from "react";
import { api, usePolled, type Card, type ChangedFile, type EndedSession, type TaskChanges, type TaskSummary } from "./api.ts";
import { HostMark, Light } from "./Board.tsx";

type Subtab = "changes" | "cloudflare" | "end";

const SUBTABS: Array<{ id: Subtab; label: string }> = [
  { id: "changes", label: "Changes" },
  { id: "cloudflare", label: "Cloudflare" },
  { id: "end", label: "End session" },
];

const FILE_STATUS: Record<ChangedFile["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
};

/**
 * CARD-3: what the task's branch changed against the default branch, its uncommitted files,
 * and its open pull requests; CARD-4: the other running tasks that changed the same files.
 */
function Changes({ taskId }: { taskId: string }) {
  const changes = usePolled<TaskChanges>(`/tasks/${taskId}/changes`, 5_000);
  if (changes.data === null) return <p className="muted small">{changes.error ?? "Loading…"}</p>;
  const { branch, baseRef, committed, uncommitted, pullRequests, overlaps } = changes.data;
  return (
    <section className="settings-body" aria-label="Changes">
      {branch === null
        ? <p className="muted small">The task has no branch yet; its first session creates it.</p>
        : <p className="small">Branch <code>{branch}</code>{baseRef !== null && <> against <code>{baseRef}</code></>}</p>}
      <h3>Committed on the branch</h3>
      {committed === null && branch !== null && <p className="muted small">The branch cannot be read here.</p>}
      {committed !== null && committed.files.length === 0 && <p className="muted small">The branch has no changes against the default branch.</p>}
      {committed !== null && committed.files.length > 0 && (
        <>
          <ul className="files commits">{committed.commits.map((commit) => <li key={commit}><code>{commit}</code></li>)}</ul>
          <ul className="files changed-files">
            {committed.files.map((file) => (
              <li key={file.path}><span className={`file-status file-${file.status}`} title={file.status}>{FILE_STATUS[file.status]}</span> <code>{file.path}</code></li>
            ))}
          </ul>
        </>
      )}
      <h3>Uncommitted</h3>
      {uncommitted === null && <p className="muted small">No session is running; an ended session's uncommitted files wait for the next one.</p>}
      {uncommitted?.length === 0 && <p className="muted small">No uncommitted files.</p>}
      {uncommitted !== null && uncommitted.length > 0 && (
        <ul className="files uncommitted">{uncommitted.map((file) => <li key={file}><code>{file}</code></li>)}</ul>
      )}
      <h3>Pull requests</h3>
      {pullRequests === null && <p className="muted small">Pull requests unavailable.</p>}
      {pullRequests?.length === 0 && <p className="muted small">No open pull requests.</p>}
      {pullRequests?.map((pr) => (
        <p key={pr.number} className="small"><a href={pr.url} target="_blank" rel="noreferrer">PR #{pr.number}</a> {pr.title}</p>
      ))}
      {overlaps.length > 0 && (
        <>
          <h3>Same files changed in</h3>
          {overlaps.map((overlap) => (
            <p key={overlap.taskId} className="overlap small"><a href={`#/t/${overlap.taskId}`}>{overlap.title}</a>: {overlap.files.join(", ")}</p>
          ))}
        </>
      )}
    </section>
  );
}

/** CLOUDFLARE-2: the agent reads the project's Cloudflare account; it writes only while allowed here. */
function Cloudflare({ card, onChanged }: { card: Card; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const cloudflare = card.cloudflare;
  if (cloudflare === null) {
    return <section className="settings-body" aria-label="Cloudflare"><p className="muted small">This project has no Cloudflare tokens in Agent Monitor.</p></section>;
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
 * UI-2: the task's Settings tab, for its session: the branch's changes, the agent's Cloudflare
 * writes, and ending the session. Task fields live on the task's page. HOST-3: a host session
 * is marked here too.
 */
export function TaskSettings({ summary, card, onChanged }: { summary: TaskSummary; card: Card | null; onChanged: () => void }) {
  const [subtab, setSubtab] = useState<Subtab>("changes");
  const [ended, setEnded] = useState<EndedSession | null>(null);
  const noSession = <p className="muted small">{summary.sessionId === null ? "No session is running." : "Loading the session…"}</p>;
  return (
    <section className="workspace-page task-settings" aria-label="Settings">
      <header className="settings-head">
        {card !== null && <Light turn={card.turn} />}
        <h2>{summary.task.title}</h2>
        <HostMark card={card} />
      </header>
      <nav role="tablist" aria-label="Settings" className="subtabs">
        {SUBTABS.map((entry) => (
          <button key={entry.id} type="button" role="tab" className="subtab" aria-selected={entry.id === subtab} onClick={() => setSubtab(entry.id)}>
            {entry.label}
          </button>
        ))}
      </nav>
      {subtab === "changes" && <Changes taskId={summary.task.id} />}
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
