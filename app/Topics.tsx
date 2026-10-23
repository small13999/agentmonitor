import { createContext, useContext, useEffect } from "react";
import { usePolled, type TaskSummary, type Topic, type TopicLink } from "./api.ts";
import { STATE_LABEL } from "./Board.tsx";
import { Markdown } from "./Markdown.tsx";

/** UI-4: opens a topic's panel; the app provides it around everything that shows topic names. */
export const OpenTopic = createContext<((topicId: string) => void) | null>(null);

/** UI-4: a topic's name, the same everywhere, in the topic's own colour; clicking it opens the topic's panel. */
export function TopicName({ topic }: { topic: Topic }) {
  const open = useContext(OpenTopic);
  if (open === null) throw new Error("TopicName needs an OpenTopic provider");
  return (
    <button
      type="button"
      className="topic-name"
      style={{ color: topic.color }}
      onClick={(event) => {
        // A topic on a card must not follow the card's link.
        event.preventDefault();
        event.stopPropagation();
        open(topic.id);
      }}
    >
      {topic.name}
    </button>
  );
}

/** UI-4: a topic's rendered status and the tasks linked to it, over the right of the page. */
export function TopicPanel({ topicId, tasks, onClose }: { topicId: string; tasks: TaskSummary[]; onClose: () => void }) {
  const detail = usePolled<{ topic: Topic; tasks: TopicLink[] }>(`/topics/${topicId}`, 5_000);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const topic = detail.data?.topic ?? null;
  const linked = (detail.data?.tasks ?? []).flatMap((link) => tasks.filter((summary) => summary.task.id === link.taskId));
  return (
    <aside className="topic-panel" aria-label={topic === null ? "Topic" : `Topic ${topic.name}`}>
      <header className="settings-head">
        {topic !== null && <h2 style={{ color: topic.color }}>{topic.name}</h2>}
        <button type="button" className="ghost close" aria-label="Close topic" onClick={onClose}>×</button>
      </header>
      {detail.error !== null && <p className="error small">{detail.error}</p>}
      {topic === null && detail.error === null && <p className="muted">Loading…</p>}
      {topic !== null && (
        <>
          <section className="status" aria-label="Status">
            <h3>Status <span className="small">rev {topic.statusRevision}</span></h3>
            {topic.status.trim() === "" ? <p className="muted small">No status yet.</p> : <Markdown text={topic.status} />}
          </section>
          <section className="status" aria-label="Linked tasks">
            <h3>Tasks</h3>
            {linked.length === 0 && <p className="muted small">No tasks are linked to this topic.</p>}
            {linked.map((summary) => (
              <a key={summary.task.id} className="task-link" href={`#/t/${summary.task.id}`} onClick={onClose}>
                <span className="name">{summary.task.title}</span>
                <span className="muted small">{STATE_LABEL[summary.task.state]}</span>
              </a>
            ))}
          </section>
        </>
      )}
    </aside>
  );
}
