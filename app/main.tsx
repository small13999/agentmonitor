import { StrictMode, useEffect, useState, type SubmitEvent } from "react";
import { createRoot } from "react-dom/client";
import { AllTasks } from "./AllTasks.tsx";
import { api, usePolled, type Card, type Person, type Project, type TaskSummary, type Topic } from "./api.ts";
import { Board, waitsOnYou } from "./Board.tsx";
import { SessionFrames } from "./SessionFrames.tsx";
import { TaskList } from "./TaskList.tsx";
import { TaskPage } from "./TaskPage.tsx";
import { TaskSettings } from "./TaskSettings.tsx";
import { OpenTopic, TopicPanel } from "./Topics.tsx";
import { StartSession, WorkspaceTabs, type WorkspaceTab } from "./Workspace.tsx";
import "./app.css";

interface Route {
  page: "board" | "tasks" | "all";
  taskId: string | null;
  tab: WorkspaceTab;
  /** BOARD-3: the All tasks list's search words. */
  query: string;
}

/**
 * `#/` is the board, `#/t` the task list, `#/t/<task id>` a task's page (TASK-12),
 * `#/t/<task id>/chat` its chat, `#/t/<task id>/settings` its settings (UI-2), `#/all` every
 * task, and `#/all?q=<words>` the tasks a search finds (BOARD-3).
 */
function readRoute(): Route {
  const all = /^#\/all(?:\?q=(.*))?$/.exec(window.location.hash);
  if (all !== null) return { page: "all", taskId: null, tab: "page", query: decodeURIComponent(all[1] ?? "") };
  const match = /^#\/t(?:\/([0-9a-f-]{36})(?:\/(chat|settings))?)?$/.exec(window.location.hash);
  if (match === null) return { page: "board", taskId: null, tab: "page", query: "" };
  return { page: "tasks", taskId: match[1] ?? null, tab: match[2] === "chat" ? "chat" : match[2] === "settings" ? "settings" : "page", query: "" };
}

function useRoute(): Route {
  const [route, setRoute] = useState(readRoute);
  useEffect(() => {
    const onChange = () => setRoute(readRoute());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

/** UI-3: a new project; host sessions only where the user allows them (HOST-1). */
function NewProject({ onCreated, onCancel }: { onCreated: (project: Project) => void; onCancel: (() => void) | null }) {
  const [error, setError] = useState<string | null>(null);
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const repoPath = String(form.get("repoPath")).trim();
    api<Project>("POST", "/projects", {
      name: String(form.get("name")).trim(),
      ...(repoPath === "" ? {} : { repoPath }),
      hostSessions: form.get("hostSessions") === "on",
    }).then(onCreated, (cause: Error) => setError(cause.message));
  };
  return (
    <form className="panel new-project" onSubmit={submit} aria-label="New project">
      <h2>New project</h2>
      <label>Name<input name="name" required autoFocus placeholder="draftcoach" /></label>
      <label>Repository<input name="repoPath" placeholder="/home/you/projects/draftcoach" /></label>
      <label className="check">
        <input type="checkbox" name="hostSessions" />
        Allow host sessions: agents may run on this machine as you, without a container
      </label>
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button type="submit">Create project</button>
        {onCancel !== null && <button type="button" className="ghost" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

/** A remote gateway (AGENTMONITOR_AUTH_MODE=remote-cookie) asks for its login secret first. */
function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const secret = String(new FormData(event.currentTarget).get("secret"));
    fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret }) })
      .then((response) => response.ok ? onLoggedIn() : setError(response.status === 429 ? "Too many attempts; wait a minute." : "Wrong secret."))
      .catch((cause: Error) => setError(cause.message));
  };
  return (
    <form className="panel new-project" onSubmit={submit}>
      <h2>Agent Monitor</h2>
      <label>Login secret<input name="secret" type="password" required autoFocus autoComplete="current-password" /></label>
      {error && <p className="error">{error}</p>}
      <button type="submit">Log in</button>
    </form>
  );
}

/** BOARD-3: searching goes to the All tasks list of what it finds. */
function SearchTasks({ query }: { query: string }) {
  const [words, setWords] = useState(query);
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    window.location.hash = words.trim() === "" ? "#/all" : `#/all?q=${encodeURIComponent(words.trim())}`;
  };
  return (
    <form role="search" className="search" onSubmit={submit}>
      <input type="search" value={words} onChange={(event) => setWords(event.target.value)} placeholder="Search tasks" aria-label="Search tasks" />
    </form>
  );
}

/** UI-5: how many tasks wait on you, and links to each. */
function WaitingOnYou({ waiting }: { waiting: TaskSummary[] }) {
  if (waiting.length === 0) return null;
  return (
    <details className="waiting">
      <summary title="Tasks waiting on you"><span className="badge">{waiting.length}</span> waiting on you</summary>
      <nav aria-label="Waiting on you">
        {waiting.map((summary) => (
          <a
            key={summary.task.id}
            className="task-link"
            href={`#/t/${summary.task.id}`}
            onClick={(event) => event.currentTarget.closest("details")?.removeAttribute("open")}
          >
            <span className="light light-blocked" />
            <span className="name">{summary.task.title}</span>
          </a>
        ))}
      </nav>
    </details>
  );
}

/** UI-1, BOARD-3, and UI-5: Agent Monitor's header with its menus, task search, and the tasks waiting on you. */
function AppHeader({ route, waiting }: { route: Route; waiting: TaskSummary[] }) {
  return (
    <header className="app-header">
      <a className="brand" href="#/">Agent Monitor</a>
      <nav className="menus" aria-label="Menus">
        <a className="menu" href="#/" aria-current={route.page === "board" ? "page" : undefined}>Board</a>
        <a className="menu" href="#/t" aria-current={route.page === "tasks" ? "page" : undefined}>Tasks</a>
      </nav>
      <SearchTasks key={route.query} query={route.query} />
      <WaitingOnYou waiting={waiting} />
    </header>
  );
}

function App() {
  const projects = usePolled<Project[]>("/projects", 30_000);
  const [projectId, setProjectId] = useState<string | null>(() => localStorage.getItem("am.project"));
  const route = useRoute();
  const { page, taskId, tab } = route;
  const [creatingProject, setCreatingProject] = useState(false);
  const [openTopic, setOpenTopic] = useState<string | null>(null);
  const project = projects.data?.find((candidate) => candidate.id === projectId) ?? projects.data?.[0] ?? null;
  const tasks = usePolled<TaskSummary[]>(project === null ? null : `/projects/${project.id}/tasks`, 3_000);
  const cards = usePolled<Card[]>(project === null ? null : `/projects/${project.id}/cards`, 2_000);
  const topics = usePolled<Topic[]>(project === null ? null : `/projects/${project.id}/topics`, 5_000);
  const people = usePolled<Person[]>("/people", 30_000);
  const me = usePolled<{ person: Person }>("/me", 60_000);

  // A topic's panel belongs to the page it was opened on.
  useEffect(() => setOpenTopic(null), [route]);

  const choose = (id: string) => {
    localStorage.setItem("am.project", id);
    setProjectId(id);
    setCreatingProject(false);
    window.location.hash = "#/";
  };

  if (projects.error === "authentication required") return <main className="empty"><Login onLoggedIn={projects.refresh} /></main>;
  if (projects.data === null) return <main className="empty">{projects.error ?? "Loading…"}</main>;
  if (project === null || creatingProject) {
    return (
      <main className="empty">
        <NewProject
          onCreated={(created) => { projects.refresh(); choose(created.id); }}
          onCancel={project === null ? null : () => setCreatingProject(false)}
        />
      </main>
    );
  }
  const refresh = () => {
    tasks.refresh();
    cards.refresh();
    topics.refresh();
  };
  const cardsBySession = new Map((cards.data ?? []).map((card) => [card.session.id, card]));
  const peopleById = new Map((people.data ?? []).map((person) => [person.id, person]));
  const meId = me.data?.person.id ?? null;
  const current = tasks.data?.find((summary) => summary.task.id === taskId) ?? null;
  const currentSession = page === "tasks" ? current?.sessionId ?? null : null;
  const currentCard = currentSession === null ? null : cardsBySession.get(currentSession) ?? null;
  // A session just started has no card yet; its chat loads anyway.
  const running = cards.data === null || tasks.data === null
    ? null
    : new Set([...cardsBySession.keys(), ...tasks.data.flatMap((summary) => (summary.sessionId === null ? [] : [summary.sessionId]))]);
  const waiting = (tasks.data ?? []).filter((summary) => (
    summary.sessionId !== null && waitsOnYou(summary, cardsBySession.get(summary.sessionId), meId)
  ));
  const error = tasks.error ?? cards.error;
  return (
    <OpenTopic.Provider value={setOpenTopic}>
    <div className="shell">
      <AppHeader route={route} waiting={waiting} />
      {page === "board" && (
        <main className="board-page">
          {error && <p className="error banner">{error}</p>}
          <nav className="board-bar" aria-label="Board views"><a href="#/all">All tasks</a></nav>
          <Board project={project} tasks={tasks.data} cards={cardsBySession} people={peopleById} meId={meId} onChanged={refresh} />
        </main>
      )}
      {page === "all" && (
        <main className="board-page">
          <AllTasks project={project} query={route.query} cards={cardsBySession} people={peopleById} />
        </main>
      )}
      {/* Kept while the board shows, so the chats stay loaded. */}
      <div className="tasks-page" hidden={page !== "tasks"}>
        <TaskList
          projects={projects.data}
          project={project}
          onProject={choose}
          onNewProject={() => setCreatingProject(true)}
          tasks={tasks.data ?? []}
          cards={cardsBySession}
          selected={taskId}
          onChanged={refresh}
        />
        <main className="workspace">
          {error && <p className="error banner">{error}</p>}
          {taskId === null && <p className="workspace-page muted">Choose a task, or create one.</p>}
          {taskId !== null && current === null && (
            <p className="workspace-page muted">{tasks.data === null ? "Loading…" : "This task does not exist in this project."}</p>
          )}
          {current !== null && (
            <>
              <WorkspaceTabs taskId={current.task.id} tab={tab} />
              {tab === "page" && (
                <TaskPage key={current.task.id} summary={current} card={currentCard} topics={topics.data ?? []} onChanged={refresh} />
              )}
              {current.sessionId === null && tab === "chat" && (
                <StartSession task={current.task} hostSessions={project.hostSessions} onStarted={refresh} />
              )}
              {tab === "settings" && <TaskSettings key={current.task.id} summary={current} card={currentCard} onChanged={refresh} />}
            </>
          )}
          <SessionFrames
            current={currentSession}
            covered={tab !== "chat"}
            running={running}
            stopped={new Set(cards.data?.filter((card) => card.turn === "stopped").map((card) => card.session.id))}
          />
        </main>
      </div>
      {openTopic !== null && <TopicPanel key={openTopic} topicId={openTopic} tasks={tasks.data ?? []} onClose={() => setOpenTopic(null)} />}
    </div>
    </OpenTopic.Provider>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<StrictMode><App /></StrictMode>);
