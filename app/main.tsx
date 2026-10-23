import "@fontsource-variable/bricolage-grotesque/opsz.css";
import "@fontsource/dm-mono/400.css";
import "@fontsource/dm-mono/500.css";
import { StrictMode, useEffect, useState, type SubmitEvent } from "react";
import { createRoot } from "react-dom/client";
import { AllTasks } from "./AllTasks.tsx";
import { api, chooseStore, LOCAL_STORE, storeOf, usePolled, type AutomationSummary, type Card, type Person, type Project, type StoreListing, type TaskDetail, type TaskSummary, type Topic } from "./api.ts";
import { AutomationList, AutomationWorkspace, NewAutomation } from "./Automations.tsx";
import { Board, waitsOnYou } from "./Board.tsx";
import { ProjectSettings } from "./ProjectSettings.tsx";
import { SessionFrames } from "./SessionFrames.tsx";
import { TaskList } from "./TaskList.tsx";
import { TaskPage } from "./TaskPage.tsx";
import { TaskSettings } from "./TaskSettings.tsx";
import { OpenTopic, TopicPanel } from "./Topics.tsx";
import { StartSession, WorkspaceTabs, type WorkspaceTab } from "./Workspace.tsx";
import "./app.css";

interface Route {
  page: "board" | "tasks" | "automations" | "all" | "project";
  taskId: string | null;
  /** The automation shown on the Automations page; "new" its form for a new one. */
  automationId: string | null;
  /** The session whose chat an automation's Chat tab shows. */
  sessionId: string | null;
  tab: WorkspaceTab;
  /** BOARD-3: the All tasks list's search words. */
  query: string;
}

/**
 * `#/` is the board, `#/t` the task list, `#/t/<task id>` a task's page (TASK-12),
 * `#/t/<task id>/chat` its chat, `#/t/<task id>/settings` its settings (UI-2), `#/all` every
 * task, `#/all?q=<words>` the tasks a search finds (BOARD-3), and `#/project` the project's settings.
 * `#/a` lists the project's automations (AUTO-15), `#/a/new` creates one, `#/a/<automation id>`
 * is an automation's page (AUTO-7), `/settings` its settings, `/chat/<session id>` a run's chat.
 */
function readRoute(): Route {
  const none: Omit<Route, "page"> = { taskId: null, automationId: null, sessionId: null, tab: "page", query: "" };
  if (window.location.hash === "#/project") return { ...none, page: "project" };
  const all = /^#\/all(?:\?q=(.*))?$/.exec(window.location.hash);
  if (all !== null) return { ...none, page: "all", query: decodeURIComponent(all[1] ?? "") };
  const automation = /^#\/a(?:\/(new|[0-9a-f-]{36})(?:\/(settings|chat\/([0-9a-f-]{36})))?)?$/.exec(window.location.hash);
  if (automation !== null) {
    const tab = automation[2] === "settings" ? "settings" : automation[3] !== undefined ? "chat" : "page";
    return { ...none, page: "automations", automationId: automation[1] ?? null, sessionId: automation[3] ?? null, tab };
  }
  const match = /^#\/t(?:\/([0-9a-f-]{36})(?:\/(chat|settings))?)?$/.exec(window.location.hash);
  if (match === null) return { ...none, page: "board" };
  return { ...none, page: "tasks", taskId: match[1] ?? null, tab: match[2] === "chat" ? "chat" : match[2] === "settings" ? "settings" : "page" };
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

/**
 * TASK-12: the project of the task a link names, in this gateway's store or a reachable hub's
 * (STORE-3); null when none of them has it.
 */
async function projectOfTask(stores: StoreListing[], taskId: string): Promise<string | null> {
  const found = await Promise.all(stores.filter((store) => store.unavailable === null).map(async (store) => {
    const detail = await api<TaskDetail>("GET", `/tasks/${taskId}`, undefined, storeOf(store.hub)).catch(() => null);
    return detail !== null && store.projects.some((project) => project.id === detail.task.projectId) ? detail.task.projectId : null;
  }));
  return found.find((projectId) => projectId !== null) ?? null;
}

/** UI-3: a new project; host sessions only where the store's owner allows them (HOST-1). */
function NewProject({ owner, onCreated, onCancel }: { owner: boolean; onCreated: (project: Project) => void; onCancel: (() => void) | null }) {
  const [error, setError] = useState<string | null>(null);
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const repoPath = String(form.get("repoPath")).trim();
    api<Project>("POST", "/projects", {
      name: String(form.get("name")).trim(),
      ...(repoPath === "" ? {} : { repoPath }),
      ...(owner ? { hostSessions: form.get("hostSessions") === "on" } : {}),
    }, LOCAL_STORE).then(onCreated, (cause: Error) => setError(cause.message));
  };
  return (
    <form className="panel new-project" onSubmit={submit} aria-label="New project">
      <h2>New project</h2>
      <label>Name<input name="name" required autoFocus placeholder="draftcoach" /></label>
      <label>Repository<input name="repoPath" placeholder="/home/you/projects/draftcoach" /></label>
      {owner && (
        <label className="check">
          <input type="checkbox" name="hostSessions" />
          Allow host sessions: agents may run on this machine as you, without a container
        </label>
      )}
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button type="submit">Create project</button>
        {onCancel !== null && <button type="button" className="ghost" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

/** BOARD-3: searching goes to the All tasks list of what it finds. */
function SearchTasks({ query }: { query: string }) {
  const [words, setWords] = useState(query);
  // The query the box last showed or searched for. A query from elsewhere (a link, Back) replaces
  // the words; the box's own search landing does not, since the next words may be typed already.
  const [known, setKnown] = useState(query);
  if (query !== known) {
    setKnown(query);
    setWords(query);
  }
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = words.trim();
    setKnown(next);
    window.location.hash = next === "" ? "#/all" : `#/all?q=${encodeURIComponent(next)}`;
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
      <a className="brand" href="#/"><span className="brand-mark" aria-hidden="true" />Agent Monitor</a>
      <nav className="menus" aria-label="Menus">
        <a className="menu" href="#/" aria-current={route.page === "board" ? "page" : undefined}>Board</a>
        <a className="menu" href="#/t" aria-current={route.page === "tasks" ? "page" : undefined}>Tasks</a>
      </nav>
      <SearchTasks query={route.query} />
      <WaitingOnYou waiting={waiting} />
    </header>
  );
}

function App() {
  // STORE-3: the gateway's own projects and its hubs'.
  const stores = usePolled<StoreListing[]>("/stores", 30_000, "/api");
  const [projectId, setProjectId] = useState<string | null>(() => localStorage.getItem("am.project"));
  const route = useRoute();
  const { page, taskId, tab } = route;
  const [creatingProject, setCreatingProject] = useState(false);
  const [openTopic, setOpenTopic] = useState<string | null>(null);
  const listed = (stores.data ?? []).flatMap((store) => store.projects.map((project) => ({ store, project })));
  const chosen = listed.find((entry) => entry.project.id === projectId) ?? listed[0] ?? null;
  const project = chosen?.project ?? null;
  // Before the store's data loads below: everything the page reads comes from the project's store.
  chooseStore(chosen?.store.hub ?? null);
  const tasks = usePolled<TaskSummary[]>(project === null ? null : `/projects/${project.id}/tasks`, 3_000);
  const cards = usePolled<Card[]>(project === null ? null : `/projects/${project.id}/cards`, 2_000);
  const topics = usePolled<Topic[]>(project === null ? null : `/projects/${project.id}/topics`, 5_000);
  const automations = usePolled<AutomationSummary[]>(project === null || page !== "automations" ? null : `/projects/${project.id}/automations`, 3_000);
  const people = usePolled<Person[]>("/people", 30_000);
  const me = usePolled<{ person: Person }>("/me", 60_000);
  // New projects are this gateway's own, so its owner is the one that matters there, not a hub's.
  const localMe = usePolled<{ person: Person }>("/me", 60_000, LOCAL_STORE);

  // A topic's panel belongs to the page it was opened on.
  useEffect(() => setOpenTopic(null), [route]);

  const select = (id: string) => {
    localStorage.setItem("am.project", id);
    setProjectId(id);
    setCreatingProject(false);
  };
  const choose = (id: string) => {
    select(id);
    window.location.hash = "#/";
  };

  // TASK-12: a link to a task the chosen project lacks switches to the task's project; `nowhere` is a task no store has.
  const [nowhere, setNowhere] = useState<string | null>(null);
  const elsewhere = taskId !== null && tasks.data !== null && !tasks.data.some((summary) => summary.task.id === taskId);
  useEffect(() => {
    if (!elsewhere || taskId === null || stores.data === null) return;
    let cancelled = false;
    void projectOfTask(stores.data, taskId).then((found) => {
      if (cancelled) return;
      if (found === null) setNowhere(taskId);
      // A task of the chosen project that its list does not hold yet shows with the list's next poll.
      else if (found !== project?.id) select(found);
    });
    return () => { cancelled = true; };
  }, [elsewhere, taskId]);

  const owner = me.data?.person.owner === true;
  if (stores.data === null) return <main className="empty">{stores.error ?? "Loading…"}</main>;
  if (project === null || creatingProject) {
    return (
      <main className="empty">
        <NewProject
          owner={localMe.data?.person.owner === true}
          onCreated={(created) => { stores.refresh(); choose(created.id); }}
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
  const currentSession = page === "tasks" ? current?.sessionId ?? null : page === "automations" && tab === "chat" ? route.sessionId : null;
  const currentCard = currentSession === null ? null : cardsBySession.get(currentSession) ?? null;
  // A session just started has no card yet; its chat loads anyway.
  const running = cards.data === null || tasks.data === null
    ? null
    : new Set([
      ...cardsBySession.keys(),
      ...tasks.data.flatMap((summary) => (summary.sessionId === null ? [] : [summary.sessionId])),
      ...(automations.data ?? []).flatMap((summary) => (summary.sessionId === null ? [] : [summary.sessionId])),
    ]);
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
          <header className="board-head">
            <h1>{project.name}</h1>
            <nav className="board-bar" aria-label="Board views">
              <a className="button" href="#/all">All tasks</a>
              <a className="button" href="#/a">Automations</a>
              <a className="button ghost" href="#/project">Project settings</a>
            </nav>
          </header>
          <Board project={project} tasks={tasks.data} cards={cardsBySession} people={peopleById} meId={meId} onChanged={refresh} />
        </main>
      )}
      {page === "all" && (
        <main className="board-page">
          <AllTasks project={project} query={route.query} cards={cardsBySession} people={peopleById} />
        </main>
      )}
      {page === "project" && (
        <main className="board-page">
          <ProjectSettings project={project} me={me.data?.person ?? null} onSaved={stores.refresh} />
        </main>
      )}
      {/* Kept while the board shows, so the chats stay loaded; the Automations page shows its runs' chats in them too. */}
      <div className="tasks-page" hidden={page !== "tasks" && page !== "automations"}>
        {page === "automations" ? (
          <AutomationList
            stores={stores.data}
            project={project}
            onProject={(id) => { select(id); window.location.hash = "#/a"; }}
            onNewProject={() => setCreatingProject(true)}
            automations={automations.data}
            cards={cardsBySession}
            selected={route.automationId}
          />
        ) : (
          <TaskList
            stores={stores.data}
            project={project}
            onProject={choose}
            onNewProject={() => setCreatingProject(true)}
            tasks={tasks.data ?? []}
            cards={cardsBySession}
            selected={taskId}
            onChanged={refresh}
          />
        )}
        <main className="workspace">
          {error && <p className="error banner">{error}</p>}
          {page === "automations" && route.automationId === null && <p className="workspace-page muted">Choose an automation, or create one.</p>}
          {page === "automations" && route.automationId === "new" && <NewAutomation project={project} onCreated={automations.refresh} />}
          {page === "automations" && route.automationId !== null && route.automationId !== "new" && (
            <AutomationWorkspace
              key={route.automationId}
              project={project}
              automationId={route.automationId}
              tab={tab}
              chatSessionId={route.sessionId}
              hostSessions={project.hostSessions && owner}
              onChanged={() => { automations.refresh(); cards.refresh(); }}
            />
          )}
          {page === "tasks" && taskId === null && <p className="workspace-page muted">Choose a task, or create one.</p>}
          {page === "tasks" && taskId !== null && current === null && (
            <p className="workspace-page muted">{nowhere === taskId ? "This task does not exist." : "Loading…"}</p>
          )}
          {page === "tasks" && current !== null && (
            <>
              <WorkspaceTabs base={`#/t/${current.task.id}`} tab={tab} chat={`#/t/${current.task.id}/chat`} />
              {tab === "page" && (
                <TaskPage key={current.task.id} summary={current} card={currentCard} topics={topics.data ?? []} onChanged={refresh} />
              )}
              {current.sessionId === null && tab === "chat" && (
                <StartSession task={current.task} hostSessions={project.hostSessions && owner} onStarted={refresh} />
              )}
              {tab === "settings" && <TaskSettings key={current.task.id} summary={current} card={currentCard} onChanged={refresh} />}
            </>
          )}
          <SessionFrames
            current={currentSession}
            covered={page === "tasks" && tab !== "chat"}
            running={running}
            stopped={new Set(cards.data?.filter((card) => card.turn === "stopped").map((card) => card.session.id))}
            hub={chosen?.store.url ?? null}
          />
        </main>
      </div>
      {openTopic !== null && <TopicPanel key={openTopic} topicId={openTopic} tasks={tasks.data ?? []} onClose={() => setOpenTopic(null)} />}
    </div>
    </OpenTopic.Provider>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<StrictMode><App /></StrictMode>);
