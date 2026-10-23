import { usePolled, type Card, type Person, type Project, type TaskSummary } from "./api.ts";
import { Light, STATE_LABEL } from "./Board.tsx";
import { Avatar } from "./People.tsx";
import { TopicName } from "./Topics.tsx";

/**
 * BOARD-3: every task of the project, done and cancelled too, the most recently changed first;
 * with `query`, the tasks the store's search finds by their words.
 */
export function AllTasks({ project, query, cards, people }: {
  project: Project;
  query: string;
  cards: Map<string, Card>;
  people: Map<string, Person>;
}) {
  const found = usePolled<TaskSummary[]>(`/projects/${project.id}/tasks?q=${encodeURIComponent(query)}`, 5_000);
  const shown = found.data?.toSorted((a, b) => b.task.updatedAt - a.task.updatedAt) ?? null;
  return (
    <section className="all-tasks" aria-label="All tasks">
      <header className="all-tasks-head">
        <h2>{query === "" ? "All tasks" : `Tasks matching “${query}”`}</h2>
        {query !== "" && <a href="#/all">Show all tasks</a>}
      </header>
      {found.error !== null && <p className="error">{found.error}</p>}
      {shown === null && found.error === null && <p className="muted">Loading…</p>}
      {shown?.length === 0 && <p className="muted">{query === "" ? "This project has no tasks yet." : "No task matches."}</p>}
      <ul className="all-tasks-list">
        {shown?.map((summary) => {
          const card = summary.sessionId === null ? undefined : cards.get(summary.sessionId);
          const assignee = summary.task.assigneeId === null ? undefined : people.get(summary.task.assigneeId);
          return (
            <li key={summary.task.id} className="all-tasks-row" data-task={summary.task.title}>
              {card === undefined ? <span className="light light-none" aria-label="No session" title="No session" /> : <Light turn={card.turn} />}
              <a className="name" href={`#/t/${summary.task.id}`}>{summary.task.title}</a>
              <span className="meta">{summary.topics.map((topic) => <TopicName key={topic.id} topic={topic} />)}</span>
              <span className="state">{STATE_LABEL[summary.task.state]}</span>
              <span className="assignee">{assignee !== undefined && <Avatar person={assignee} />}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
