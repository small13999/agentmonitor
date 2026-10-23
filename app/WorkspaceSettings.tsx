import { useState, type SubmitEvent } from "react";
import { api, ApiError, type Card, type EndedSession, type Task, type TaskState, type TaskSummary, type Topic } from "./api.ts";
import { HostMark, Light, STATE_LABEL } from "./Board.tsx";
import { InlineCreate } from "./InlineCreate.tsx";
import { TopicName } from "./Topics.tsx";

const UNFINISHED: TaskState[] = ["open", "in_progress", "in_review"];

/** TASK-1: the task's title, description, and state; finishing it is below (TASK-9). */
function TaskPanel({ task, onChanged }: { task: Task; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const update = (body: Partial<Pick<Task, "title" | "description" | "state">>) => {
    setError(null);
    return api<Task>("PATCH", `/tasks/${task.id}`, body).then(onChanged, (cause: Error) => {
      setError(cause.message);
      throw cause;
    });
  };
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    update({ title: String(form.get("title")).trim(), description: String(form.get("description")).trim() })
      .then(() => setEditing(false), () => undefined);
  };
  const finished = !UNFINISHED.includes(task.state);
  return (
    <section className="panel" aria-label="Task">
      <h3>Task</h3>
      {finished
        ? <p className="small">{STATE_LABEL[task.state]}</p>
        : (
          <select value={task.state} aria-label="State" onChange={(event) => {
            const state = UNFINISHED.find((candidate) => candidate === event.target.value);
            if (state !== undefined) update({ state }).catch(() => undefined);
          }}>
            {UNFINISHED.map((state) => <option key={state} value={state}>{STATE_LABEL[state]}</option>)}
          </select>
        )}
      {task.branch !== null && <code className="muted small">{task.branch}</code>}
      {editing ? (
        <form className="edit-task" onSubmit={submit}>
          <input name="title" required defaultValue={task.title} aria-label="Title" />
          <textarea name="description" rows={6} defaultValue={task.description} aria-label="Description" />
          <div className="actions">
            <button type="submit">Save</button>
            <button type="button" className="ghost" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </form>
      ) : (
        <>
          {task.description.trim() === "" ? <p className="muted small">No description.</p> : <p className="description small">{task.description}</p>}
          <button type="button" className="ghost" onClick={() => setEditing(true)}>Edit title and description</button>
        </>
      )}
      {error && <p className="error small">{error}</p>}
    </section>
  );
}

/** TASK-7: what the task's agents last wrote about where the work stands. */
function StatusPanel({ task }: { task: Task }) {
  return (
    <section className="panel" aria-label="Status">
      <h3>Status <span className="muted small">rev {task.statusRevision}</span></h3>
      {task.status.trim() === "" ? <p className="muted small">No status yet. The task's agents write it.</p> : <pre>{task.status}</pre>}
    </section>
  );
}

/** TASK-2: the task's topic links come with the task list, so they show as soon as the settings open. */
function TopicsPanel({ summary, topics, onChanged }: { summary: TaskSummary; topics: Topic[]; onChanged: () => void }) {
  const taskId = summary.task.id;
  const [error, setError] = useState<string | null>(null);
  const linked = summary.topics;
  const change = (method: "PUT" | "DELETE", topicId: string) => {
    setError(null);
    api(method, `/tasks/${taskId}/topics/${topicId}`).then(onChanged, (cause: Error) => setError(cause.message));
  };
  const available = topics.filter((topic) => !linked.some((candidate) => candidate.id === topic.id));
  return (
    <section className="panel">
      <h3>Topics</h3>
      <div className="chips">
        {linked.length === 0 && <span className="muted small">This task has no topics.</span>}
        {linked.map((topic) => (
          <span key={topic.id} className="chip">
            <TopicName topic={topic} />
            <button type="button" className="chip-x" aria-label={`Unlink ${topic.name}`} onClick={() => change("DELETE", topic.id)}>×</button>
          </span>
        ))}
      </div>
      {available.length > 0 && (
        <select value="" onChange={(event) => change("PUT", event.target.value)} aria-label="Link topic">
          <option value="">Link a topic…</option>
          {available.map((topic) => <option key={topic.id} value={topic.id}>{topic.name}</option>)}
        </select>
      )}
      {error && <p className="error small">{error}</p>}
      <InlineCreate
        label="New topic"
        placeholder="Topic name"
        submit={async (name) => {
          const created = await api<Topic>("POST", `/projects/${summary.task.projectId}/topics`, { name });
          await api("PUT", `/tasks/${taskId}/topics/${created.id}`);
          onChanged();
        }}
      />
    </section>
  );
}

function ChangesPanel({ card }: { card: Card }) {
  return (
    <section className="panel">
      <h3>Changes</h3>
      {card.git === null && <p className="muted small">The worktree cannot be read.</p>}
      {card.git !== null && (
        <>
          <p className="small">{card.git.unpushed} unpushed commit{card.git.unpushed === 1 ? "" : "s"}</p>
          {card.git.uncommitted.length === 0
            ? <p className="muted small">No uncommitted files.</p>
            : <ul className="files">{card.git.uncommitted.map((file) => <li key={file}><code>{file}</code></li>)}</ul>}
        </>
      )}
      {card.pullRequests === null && <p className="muted small">Pull requests unavailable.</p>}
      {card.pullRequests?.map((pr) => (
        <p key={pr.number} className="small"><a href={pr.url} target="_blank" rel="noreferrer">PR #{pr.number}</a> {pr.title}</p>
      ))}
      {card.overlaps.length > 0 && <h4>Same files changed in</h4>}
      {card.overlaps.map((overlap) => (
        <p key={overlap.sessionId} className="overlap small">{overlap.name}: {overlap.files.join(", ")}</p>
      ))}
    </section>
  );
}

/** CLOUDFLARE-2: the agent reads the project's Cloudflare account; it writes only while allowed here. */
function CloudflarePanel({ card, onChanged }: { card: Card; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const cloudflare = card.cloudflare;
  if (cloudflare === null) return null;
  const change = (method: "POST" | "DELETE") => {
    setError(null);
    api(method, `/sessions/${card.session.id}/cloudflare-writes`).then(onChanged, (cause: Error) => setError(cause.message));
  };
  const until = cloudflare.writesUntil;
  return (
    <section className="panel" aria-label="Cloudflare">
      <h3>Cloudflare</h3>
      {!cloudflare.canWrite && <p className="muted small">The agent can read. This project has no write token.</p>}
      {cloudflare.canWrite && until === null && (
        <>
          <p className="muted small">The agent can read. Writes are off.</p>
          <button type="button" onClick={() => change("POST")}>Allow writes for 10 min</button>
        </>
      )}
      {cloudflare.canWrite && until !== null && (
        <>
          <p className="small">
            Writes allowed until {new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{" "}
            ({Math.max(1, Math.ceil((until - Date.now()) / 60_000))} min left).
          </p>
          <button type="button" onClick={() => change("POST")}>Reset to 10 min</button>{" "}
          <button type="button" className="ghost" onClick={() => change("DELETE")}>Revoke</button>
        </>
      )}
      {error && <p className="error small">{error}</p>}
    </section>
  );
}

/** SESSION-8/SESSION-9: ending loses nothing, so it asks once and then says what it kept. */
function EndSession({ card, onEnded }: { card: Card; onEnded: (ended: EndedSession) => void }) {
  const [step, setStep] = useState<"idle" | "confirm" | "busy">("idle");
  const [error, setError] = useState<string | null>(null);
  if (step === "idle") return <button type="button" className="ghost danger" onClick={() => setStep("confirm")}>End session</button>;
  const end = () => {
    setStep("busy");
    setError(null);
    api<EndedSession>("POST", `/sessions/${card.session.id}/end`, {}).then(onEnded, (cause: Error) => {
      setError(cause.message);
      setStep("confirm");
    });
  };
  return (
    <section className="panel end-session" aria-label="End session">
      <p className="small">
        Ending the session deletes its container and worktree. The task, its branch, and the chats stay;
        uncommitted files are kept for the task's next session.
      </p>
      {error && <p className="error small">{error}</p>}
      <div className="actions">
        <button type="button" className="danger" disabled={step === "busy"} onClick={end}>End session</button>
        <button type="button" className="ghost" disabled={step === "busy"} onClick={() => setStep("idle")}>Cancel</button>
      </div>
    </section>
  );
}

/** The commits an unconfirmed finish was refused for; null for any other failure. */
function unpushedOf(cause: Error): string[] | null {
  if (!(cause instanceof ApiError) || !Array.isArray(cause.details.unpushed)) return null;
  return cause.details.unpushed.filter((commit) => typeof commit === "string");
}

/**
 * TASK-9: marking the task done or cancelled ends its session and deletes its branch here;
 * when the branch has commits no remote has, the gateway refuses and they are listed before
 * asking again.
 */
function FinishTask({ task, onFinished }: { task: Task; onFinished: () => void }) {
  const [state, setState] = useState<"done" | "cancelled" | null>(null);
  const [busy, setBusy] = useState(false);
  const [unpushed, setUnpushed] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!UNFINISHED.includes(task.state)) return null;
  const finish = (target: "done" | "cancelled", confirm: boolean) => {
    setState(target);
    setBusy(true);
    setError(null);
    api<Task>("POST", `/tasks/${task.id}/finish`, { state: target, ...(confirm ? { confirm } : {}) }).then(
      () => { setBusy(false); onFinished(); },
      (cause: Error) => {
        setBusy(false);
        const commits = unpushedOf(cause);
        if (commits !== null) setUnpushed(commits);
        else setError(cause.message);
      },
    );
  };
  return (
    <section className="panel end-session" aria-label="Finish task">
      {unpushed === null ? (
        <div className="actions">
          <button type="button" disabled={busy} onClick={() => finish("done", false)}>Mark done</button>
          <button type="button" className="ghost danger" disabled={busy} onClick={() => finish("cancelled", false)}>Cancel task</button>
        </div>
      ) : (
        <>
          <p className="error small">No remote has these commits; finishing deletes them with the branch:</p>
          <ul className="files unpushed">{unpushed.map((commit) => <li key={commit}><code>{commit}</code></li>)}</ul>
          <div className="actions">
            <button type="button" className="danger" disabled={busy} onClick={() => state !== null && finish(state, true)}>
              {state === "done" ? "Mark done" : "Cancel task"} and delete them
            </button>
            <button type="button" className="ghost" disabled={busy} onClick={() => setUnpushed(null)}>Keep working</button>
          </div>
        </>
      )}
      {error && <p className="error small">{error}</p>}
    </section>
  );
}

/**
 * UI-2: the task workspace's settings, over the right of its tabs' content: the task's state,
 * topic links, and status; its running session's changes, Cloudflare writes, and ending it;
 * and finishing the task.
 */
export function WorkspaceSettings({ summary, card, topics, onChanged, onClose }: {
  summary: TaskSummary;
  card: Card | null;
  topics: Topic[];
  onChanged: () => void;
  onClose: () => void;
}) {
  const [ended, setEnded] = useState<EndedSession | null>(null);
  return (
    <aside className="workspace-settings" aria-label="Workspace settings">
      <header className="settings-head">
        {card !== null && <Light turn={card.turn} />}
        <h2>{summary.task.title}</h2>
        <HostMark card={card} />
        <button type="button" className="ghost close" aria-label="Close settings" onClick={onClose}>×</button>
      </header>
      <TaskPanel task={summary.task} onChanged={onChanged} />
      <StatusPanel task={summary.task} />
      <TopicsPanel summary={summary} topics={topics} onChanged={onChanged} />
      {card !== null && <ChangesPanel card={card} />}
      {card !== null && <CloudflarePanel card={card} onChanged={onChanged} />}
      {card !== null && <EndSession card={card} onEnded={(result) => { setEnded(result); onChanged(); }} />}
      {ended !== null && (
        <p className="small" role="status">
          Session ended.{" "}
          {ended.kept.length === 0
            ? "Nothing was uncommitted."
            : `${ended.kept.length} uncommitted file${ended.kept.length === 1 ? " was" : "s were"} kept for the task's next session.`}
        </p>
      )}
      <FinishTask task={summary.task} onFinished={onChanged} />
    </aside>
  );
}
