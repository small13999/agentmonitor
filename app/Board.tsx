import { useState, type SubmitEvent } from "react";
import { api, type Card, type Person, type Project, type Task, type TaskState, type TaskSummary } from "./api.ts";
import { Avatar } from "./People.tsx";
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
        {assignee !== null && <Avatar person={assignee} />}
      </header>
      {summary.topics.length > 0 && (
        <div className="meta">{summary.topics.map((topic) => <TopicName key={topic.id} topic={topic} />)}</div>
      )}
      <footer className="card-session">
        {card === null && <span className="muted">{summary.sessionId === null ? "No session" : "Starting…"}</span>}
        {card !== null && (
          <>
            <Light turn={card.turn} />
            <span>{LIGHT_LABEL[card.turn]}</span>
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
        return (
          <section key={column.label} className="column" aria-label={column.label}>
            <h2>{column.label} <span className="muted small">{shown.length}</span></h2>
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
