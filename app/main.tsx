import { StrictMode, useEffect, useState, type SubmitEvent } from "react";
import { createRoot } from "react-dom/client";
import { api, usePolled, type Card, type Project, type TaskSummary, type Topic } from "./api.ts";
import { Board } from "./Board.tsx";
import { SessionFrames } from "./SessionFrames.tsx";
import { TaskFolder } from "./Folder.tsx";
import { TaskList } from "./TaskList.tsx";
import { Notes, StartSession, WorkspaceTabs, type WorkspaceTab } from "./Workspace.tsx";
import { WorkspaceSettings } from "./WorkspaceSettings.tsx";
import "./app.css";

interface Route {
  page: "board" | "tasks";
  taskId: string | null;
  tab: WorkspaceTab;
}

/**
 * `#/` is the board, `#/t` the task list, `#/t/<task id>` a task's chat, `#/t/<task id>/notes`
 * its notes, `#/t/<task id>/folder` its folder.
 */
function readRoute(): Route {
  const match = /^#\/t(?:\/([0-9a-f-]{36})(?:\/(notes|folder))?)?$/.exec(window.location.hash);
  if (match === null) return { page: "board", taskId: null, tab: "chat" };
  return { page: "tasks", taskId: match[1] ?? null, tab: match[2] === "notes" || match[2] === "folder" ? match[2] : "chat" };
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

/** UI-1 and BOARD-2: Agent Monitor's header with its menus; the board counts the tasks waiting on you. */
function AppHeader({ page, waiting }: { page: Route["page"]; waiting: number }) {
  return (
    <header className="app-header">
      <a className="brand" href="#/">Agent Monitor</a>
      <nav className="menus" aria-label="Menus">
        <a className="menu" href="#/" aria-current={page === "board" ? "page" : undefined}>
          Board
          {waiting > 0 && <span className="badge" title="Tasks waiting on you">{waiting}</span>}
        </a>
        <a className="menu" href="#/t" aria-current={page === "tasks" ? "page" : undefined}>Tasks</a>
      </nav>
    </header>
  );
}

function App() {
  const projects = usePolled<Project[]>("/projects", 30_000);
  const [projectId, setProjectId] = useState<string | null>(() => localStorage.getItem("am.project"));
  const { page, taskId, tab } = useRoute();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const project = projects.data?.find((candidate) => candidate.id === projectId) ?? projects.data?.[0] ?? null;
  const tasks = usePolled<TaskSummary[]>(project === null ? null : `/projects/${project.id}/tasks`, 3_000);
  const cards = usePolled<Card[]>(project === null ? null : `/projects/${project.id}/cards`, 2_000);
  const topics = usePolled<Topic[]>(project === null ? null : `/projects/${project.id}/topics`, 5_000);

  useEffect(() => {
    if (!settingsOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setSettingsOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen]);

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
  const current = tasks.data?.find((summary) => summary.task.id === taskId) ?? null;
  const currentSession = page === "tasks" ? current?.sessionId ?? null : null;
  const currentCard = currentSession === null ? null : cardsBySession.get(currentSession) ?? null;
  // A session just started has no card yet; its chat loads anyway.
  const running = cards.data === null || tasks.data === null
    ? null
    : new Set([...cardsBySession.keys(), ...tasks.data.flatMap((summary) => (summary.sessionId === null ? [] : [summary.sessionId]))]);
  const error = tasks.error ?? cards.error;
  return (
    <div className="shell">
      <AppHeader page={page} waiting={cards.data?.filter((card) => card.turn === "blocked").length ?? 0} />
      {page === "board" && (
        <main className="board-page">
          {error && <p className="error banner">{error}</p>}
          <Board project={project} tasks={tasks.data} cards={cardsBySession} onChanged={refresh} />
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
              <WorkspaceTabs
                taskId={current.task.id}
                tab={tab}
                settingsOpen={settingsOpen}
                onSettings={() => setSettingsOpen((open) => !open)}
              />
              {current.sessionId === null && tab === "chat" && (
                <StartSession task={current.task} hostSessions={project.hostSessions} onStarted={refresh} />
              )}
              <Notes key={current.task.id} taskId={current.task.id} hidden={tab !== "notes"} />
              {tab === "folder" && (
                <div className="workspace-page folder-tab">
                  <TaskFolder key={current.task.id} taskId={current.task.id} />
                </div>
              )}
              {settingsOpen && (
                <WorkspaceSettings
                  key={current.task.id}
                  summary={current}
                  card={currentCard}
                  topics={topics.data ?? []}
                  onChanged={refresh}
                  onClose={() => setSettingsOpen(false)}
                />
              )}
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
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<StrictMode><App /></StrictMode>);
