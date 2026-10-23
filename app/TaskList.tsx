import { api, type Card, type Project, type StoreListing, type Task, type TaskSummary } from "./api.ts";
import { HostMark, Light } from "./Board.tsx";
import { InlineCreate } from "./InlineCreate.tsx";

/** The project menu's last entry, which opens the new-project form instead of choosing one. */
const NEW_PROJECT = "new";

/**
 * UI-1: the project's open and in-progress tasks (in review included), in the order they
 * were created so rows stay put as their lights change, and creating a new one. The
 * project menu also creates projects (UI-3).
 */
export function TaskList(props: {
  stores: StoreListing[];
  project: Project;
  onProject: (id: string) => void;
  onNewProject: () => void;
  tasks: TaskSummary[];
  cards: Map<string, Card>;
  selected: string | null;
  onChanged: () => void;
}) {
  const active = props.tasks.filter((summary) => summary.task.state !== "done" && summary.task.state !== "cancelled");
  return (
    <nav className="task-list" aria-label="Tasks">
      <select
        value={props.project.id}
        onChange={(event) => (event.target.value === NEW_PROJECT ? props.onNewProject() : props.onProject(event.target.value))}
        aria-label="Project"
      >
        {props.stores.length === 1
          ? props.stores[0].projects.map(projectOption)
          : props.stores.map((store) => (
            // STORE-3: grouped by store; a hub that cannot be reached says why, its last known projects stay.
            <optgroup key={store.hub ?? ""} label={store.unavailable === null ? store.name : `${store.name} (unavailable)`}>
              {store.projects.map(projectOption)}
              {store.unavailable !== null && <option disabled value="">{`Unavailable: ${store.unavailable}`}</option>}
            </optgroup>
          ))}
        <option value={NEW_PROJECT}>+ Project</option>
      </select>
      <InlineCreate
        label="Task"
        placeholder="Task title"
        submit={async (title) => {
          const created = await api<Task>("POST", `/projects/${props.project.id}/tasks`, { title });
          props.onChanged();
          window.location.hash = `#/t/${created.id}`;
        }}
      />
      {active.length === 0 && <p className="muted small">No open tasks</p>}
      {active.map((summary) => {
        const card = summary.sessionId === null ? undefined : props.cards.get(summary.sessionId);
        return (
          <a
            key={summary.task.id}
            className="task-link"
            href={`#/t/${summary.task.id}`}
            title={summary.task.title}
            aria-current={summary.task.id === props.selected ? "page" : undefined}
          >
            {card === undefined ? <span className="light light-none" aria-label="No session" title="No session" /> : <Light turn={card.turn} />}
            <span className="name">{summary.task.title}</span>
            <HostMark card={card} />
          </a>
        );
      })}
    </nav>
  );
}

function projectOption(project: Project) {
  return <option key={project.id} value={project.id}>{project.name}</option>;
}
