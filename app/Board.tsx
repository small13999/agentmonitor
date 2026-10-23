import { useState, type SubmitEvent } from "react";
import { api, type Card, type Person, type Project, type Task, type TaskState, type TaskSummary } from "./api.ts";
import { AgentAvatar, PersonAvatar } from "./People.tsx";
import { TopicName } from "./Topics.tsx";

export const LIGHT_LABEL: Record<Card["turn"], string> = {
  blocked: "Waiting on you",
  working: "Working",
  done: "Idle",
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

/** CARD-1: the running session's light and its state in words, as one pill. */
export function TurnPill({ turn }: { turn: Card["turn"] }) {
  return <span className={`turn turn-${turn}`}><Light turn={turn} />{LIGHT_LABEL[turn]}</span>;
}

/** HOST-3: a session whose agent runs on this machine without a container; HOST-6: in the main checkout. */
export function HostMark({ card }: { card: Card | null | undefined }) {
  if (card?.session.runtime !== "host") return null;
  if (card.session.checkout) return <span className="host-mark" title="Runs on this machine as you, in the main checkout: the live code">Host · main</span>;
  return <span className="host-mark" title="Runs on this machine as you, without a container">Host</span>;
}

/** BOARD-2 and UI-5: its running session waits on a person, and the task is yours or nobody's. */
export function waitsOnYou(summary: TaskSummary, card: Card | null | undefined, meId: string | null): boolean {
  return card?.turn === "blocked" && (summary.task.assigneeId === null || summary.task.assigneeId === meId);
}

/** CARD-4: the other running tasks that changed any of the same files. */
function OverlapMark({ card }: { card: Card }) {
  if (card.overlaps.length === 0) return null;
  const others = card.overlaps.map((overlap) => `${overlap.name} (${overlap.files.join(", ")})`).join("; ");
  return <span className="overlap-mark" title={`Same files changed in ${others}`}>Overlaps</span>;
}

/**
 * BOARD-1: the task's title, topic names, and assignee, and its running session's light (CARD-1)
 * and machine. The whole card opens the task's page.
 */
function TaskCard({ summary, card, assignee }: { summary: TaskSummary; card: Card | null; assignee: Person | null }) {
  const { task } = summary;
  return (
    <article className={`card${card === null ? "" : ` card-${card.turn}`}`} aria-label={task.title} data-task={task.title}>
      <header>
        <a className="card-link" href={`#/t/${task.id}`}>{task.title}</a>
        {assignee !== null && <PersonAvatar person={assignee} alone />}
      </header>
      {summary.topics.length > 0 && (
        <div className="meta">{summary.topics.map((topic) => <TopicName key={topic.id} topic={topic} />)}</div>
      )}
      <footer className="card-session">
        {card === null && <span className="muted">{summary.sessionId === null ? "No session" : "Starting…"}</span>}
        {card !== null && (
          <>
            <AgentAvatar sessionId={card.session.id} />
            <TurnPill turn={card.turn} />
            {card.session.machine !== null && <span className="machine" title="Machine">{card.session.machine}</span>}
            <HostMark card={card} />
            <OverlapMark card={card} />
          </>
        )}
      </footer>
    </article>
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

/** BOARD-1: active work only; done and cancelled tasks are found by search and the All tasks list (BOARD-3). */
const COLUMNS: Array<{ label: string; state: TaskState }> = [
  { label: "Open", state: "open" },
  { label: "In progress", state: "in_progress" },
  { label: "In review", state: "in_review" },
];

/** A column's glyph: an open ring, a half-filled one for work under way, an eye for review. */
function ColumnIcon({ state }: { state: TaskState }) {
  return (
    <svg className="column-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
      {state === "open" && <circle cx="12" cy="12" r="8.5" strokeDasharray="3.2 3.4" />}
      {state === "in_progress" && <><circle cx="12" cy="12" r="8.5" /><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" /></>}
      {state === "in_review" && <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" /></>}
    </svg>
  );
}

/**
 * BOARD-1/BOARD-2: the project's active tasks in columns by state. Tasks waiting on you come
 * first in their column; the rest keep the order they were created in, so cards stay put as
 * their lights change.
 */
export function Board({ project, tasks, cards, people, meId, onChanged }: {
  project: Project;
  tasks: TaskSummary[] | null;
  cards: Map<string, Card>;
  people: Map<string, Person>;
  meId: string | null;
  onChanged: () => void;
}) {
  if (tasks === null) return <p className="muted">Loading…</p>;
  const cardOf = (summary: TaskSummary) => (summary.sessionId === null ? null : cards.get(summary.sessionId) ?? null);
  const waiting = (summary: TaskSummary) => (waitsOnYou(summary, cardOf(summary), meId) ? 0 : 1);
  return (
    <section className="board" aria-label="Board">
      {COLUMNS.map((column) => {
        const shown = tasks
          .filter((summary) => summary.task.state === column.state)
          .toSorted((a, b) => waiting(a) - waiting(b) || a.task.createdAt - b.task.createdAt);
        const needs = shown.filter((summary) => waiting(summary) === 0).length;
        return (
          <section key={column.label} className={`column column-${column.state}`} aria-label={column.label}>
            <header className="column-head">
              <h2><ColumnIcon state={column.state} />{column.label} <span className="count">{shown.length}</span></h2>
              {needs > 0 && <span className="needs-count">{needs} need{needs === 1 ? "s" : ""} you</span>}
            </header>
            {column.state === "open" && <NewTask project={project} onCreated={onChanged} />}
            {shown.map((summary) => (
              <TaskCard
                key={summary.task.id}
                summary={summary}
                card={cardOf(summary)}
                assignee={summary.task.assigneeId === null ? null : people.get(summary.task.assigneeId) ?? null}
              />
            ))}
          </section>
        );
      })}
    </section>
  );
}
