import { useState, type SubmitEvent } from "react";
import { api, type Card, type Project, type Task, type TaskState, type TaskSummary } from "./api.ts";

export const LIGHT_LABEL: Record<Card["turn"], string> = {
  blocked: "Waiting on you",
  working: "Working",
  done: "Turn done",
  stopped: "Stopped",
};

export const STATE_LABEL: Record<TaskState, string> = {
  open: "Open",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  cancelled: "Cancelled",
};

export function Light({ turn }: { turn: Card["turn"] }) {
  return <span className={`light light-${turn}`} title={LIGHT_LABEL[turn]} aria-label={LIGHT_LABEL[turn]} />;
}

/** HOST-3: a session whose agent runs on this machine without a container. */
export function HostMark({ card }: { card: Card | null | undefined }) {
  if (card?.session.runtime !== "host") return null;
  return <span className="host-mark" title="Runs on this machine as you, without a container">Host</span>;
}

function GitLine({ card }: { card: Card }) {
  const parts: string[] = [];
  if (card.git !== null) {
    if (card.git.uncommitted.length > 0) parts.push(`${card.git.uncommitted.length} uncommitted`);
    if (card.git.unpushed > 0) parts.push(`${card.git.unpushed} unpushed`);
  }
  return (
    <div className="git-line">
      {parts.length === 0 && (card.pullRequests ?? []).length === 0 && <span className="muted">Nothing unsaved</span>}
      {parts.length > 0 && <span className="unsaved">{parts.join(" · ")}</span>}
      {(card.pullRequests ?? []).map((pr) => (
        <a key={pr.number} href={pr.url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
          PR #{pr.number}
        </a>
      ))}
    </div>
  );
}

/** BOARD-1: the task's title and topics, and its running session's light, last messages, and changes. */
function TaskCard({ summary, card }: { summary: TaskSummary; card: Card | null }) {
  const { task } = summary;
  return (
    <a className={`card${card === null ? "" : ` card-${card.turn}`}`} href={`#/t/${task.id}`} data-task={task.title}>
      <header>
        {card !== null && <Light turn={card.turn} />}
        <strong>{task.title}</strong>
        <HostMark card={card} />
        <span className="state">{card === null ? (task.state === "cancelled" ? "Cancelled" : "No session") : LIGHT_LABEL[card.turn]}</span>
      </header>
      {summary.topics.length > 0 && (
        <div className="meta">{summary.topics.map((topic) => <span key={topic.id} className="chip">{topic.name}</span>)}</div>
      )}
      {card !== null && (
        <>
          {card.lastUserMessage !== null && <p className="said you"><b>You</b> {card.lastUserMessage}</p>}
          {card.lastReply !== null && <p className="said agent"><b>Agent</b> {card.lastReply}</p>}
          {card.lastUserMessage === null && card.lastReply === null && <p className="muted">No conversation yet</p>}
          <GitLine card={card} />
          {card.overlaps.map((overlap) => (
            <p key={overlap.sessionId} className="overlap">
              Also changed in <b>{overlap.name}</b>: {overlap.files.join(", ")}
            </p>
          ))}
        </>
      )}
      {card === null && task.description.trim() !== "" && <p className="said agent">{task.description}</p>}
    </a>
  );
}

/** TASK-3: a task is created with a title and an optional description; no session starts. */
function NewTask({ project, onCreated }: { project: Project; onCreated: (task: Task) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open) return <button type="button" className="ghost" onClick={() => setOpen(true)}>+ New task</button>;
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    api<Task>("POST", `/projects/${project.id}/tasks`, {
      title: String(form.get("title")).trim(),
      description: String(form.get("description")).trim(),
    }).then(
      (task) => { setBusy(false); setOpen(false); onCreated(task); },
      (cause: Error) => { setBusy(false); setError(cause.message); },
    );
  };
  return (
    <form className="panel new-task" onSubmit={submit} aria-label="New task">
      <input name="title" required autoFocus placeholder="Title" aria-label="Title" disabled={busy} />
      <textarea name="description" rows={4} placeholder="Description: what should be done, and how you will check it" aria-label="Description" disabled={busy} />
      {error && <p className="error small">{error}</p>}
      <div className="actions">
        <button type="submit" disabled={busy}>Create task</button>
        <button type="button" className="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}

const COLUMNS: Array<{ label: string; states: TaskState[] }> = [
  { label: "Open", states: ["open"] },
  { label: "In progress", states: ["in_progress"] },
  { label: "In review", states: ["in_review"] },
  { label: "Done", states: ["done", "cancelled"] },
];

/** Finished tasks the Done column shows; the newest. */
const DONE_SHOWN = 20;

/**
 * BOARD-1/BOARD-2: the project's tasks in columns by state. Tasks waiting on you come first in
 * their column; the rest keep the order they were created in, so cards stay put as their
 * lights change. Done shows the most recently finished.
 */
export function Board({ project, tasks, cards, onChanged }: {
  project: Project;
  tasks: TaskSummary[] | null;
  cards: Map<string, Card>;
  onChanged: () => void;
}) {
  if (tasks === null) return <p className="muted">Loading…</p>;
  const cardOf = (summary: TaskSummary) => (summary.sessionId === null ? null : cards.get(summary.sessionId) ?? null);
  const waiting = (summary: TaskSummary) => (cardOf(summary)?.turn === "blocked" ? 0 : 1);
  return (
    <section className="board" aria-label="Board">
      {COLUMNS.map((column) => {
        const finished = column.states.includes("done");
        const shown = tasks
          .filter((summary) => column.states.includes(summary.task.state))
          .toSorted((a, b) => finished
            ? b.task.updatedAt - a.task.updatedAt
            : waiting(a) - waiting(b) || a.task.createdAt - b.task.createdAt)
          .slice(0, finished ? DONE_SHOWN : undefined);
        return (
          <section key={column.label} className="column" aria-label={column.label}>
            <h2>{column.label} <span className="muted small">{shown.length}</span></h2>
            {column.states.includes("open") && (
              <NewTask project={project} onCreated={onChanged} />
            )}
            {shown.map((summary) => <TaskCard key={summary.task.id} summary={summary} card={cardOf(summary)} />)}
          </section>
        );
      })}
    </section>
  );
}
