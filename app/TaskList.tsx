import { api, type Card, type Project, type StoreListing, type Task, type TaskSummary } from "./api.ts";
import { HostMark, Light } from "./Board.tsx";
import { InlineCreate } from "./InlineCreate.tsx";

/** The project menu's last entries, which open the new-project form, the project's automations, or its settings instead of choosing one. */
const NEW_PROJECT = "new";
const AUTOMATIONS = "automations";
const SETTINGS = "settings";

/**
 * The project menu: chooses the project (STORE-3: grouped by store), creates one (UI-3), and
 * leads to the project's automations (AUTO-15) and its settings.
 */
export function ProjectMenu({ stores, project, onProject, onNewProject }: {
  stores: StoreListing[];
  project: Project;
  onProject: (id: string) => void;
  onNewProject: () => void;
}) {
  return (
    <select
      className="project-menu"
      value={project.id}
      onChange={(event) => {
        if (event.target.value === NEW_PROJECT) onNewProject();
        else if (event.target.value === AUTOMATIONS) window.location.hash = "#/a";
        else if (event.target.value === SETTINGS) window.location.hash = "#/project";
        else onProject(event.target.value);
      }}
      aria-label="Project"
    >
      {stores.length === 1
        ? stores[0].projects.map(projectOption)
        : stores.map((store) => (
          // STORE-3: grouped by store; a hub that cannot be reached says why, its last known projects stay.
          <optgroup key={store.hub ?? ""} label={store.unavailable === null ? store.name : `${store.name} (unavailable)`}>
            {store.projects.map(projectOption)}
            {store.unavailable !== null && <option disabled value="">{`Unavailable: ${store.unavailable}`}</option>}
          </optgroup>
        ))}
      <option value={NEW_PROJECT}>+ Project</option>
      <option value={AUTOMATIONS}>Automations</option>
      <option value={SETTINGS}>Project settings</option>
    </select>
  );
}

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
      <ProjectMenu stores={props.stores} project={props.project} onProject={props.onProject} onNewProject={props.onNewProject} />
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
