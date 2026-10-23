// The store API's wire types, shared by the gateway and the web app. Types only: this file
// must not import anything that does not run in a browser.

export interface Project {
  id: string;
  name: string;
  /** The project's main checkout on the gateway's machine; session worktrees are worktrees of it. */
  repoPath: string | null;
  /** HOST-1: whether sessions of this project may run on the host instead of in a container. */
  hostSessions: boolean;
  /** CLOUDFLARE-3: whether the store holds a Cloudflare read and a write token for the project; never the tokens. */
  cloudflare: { read: boolean; write: boolean };
  createdAt: number;
}

/**
 * STORE-3: a store the app lists projects of: the gateway's own (`hub` null) or a hub of the
 * client's hubs.json, whose projects stay listed from its last answer while it is unavailable.
 */
export interface StoreListing {
  hub: string | null;
  name: string;
  /** The hub's origin; null for the gateway's own store. */
  url: string | null;
  projects: Project[];
  /** Why the hub cannot be reached; null when it can. */
  unavailable: string | null;
}

export interface Topic {
  id: string;
  projectId: string;
  name: string;
  /** UI-4: the topic's colour wherever its name shows, `#rrggbb`. */
  color: string;
  createdAt: number;
  status: string;
  statusRevision: number;
}

/** PERSON-1: someone who uses the store; its owner adds the others. */
export interface Person {
  id: string;
  name: string;
  /** AUTH-2: what the person logs in with, lower-cased; null for an owner whose gateway names none (local mode). */
  email: string | null;
  /** Initials on this colour stand in for an avatar, `#rrggbb`. */
  color: string;
  /** The store's owner; in local mode every request is the owner. */
  owner: boolean;
  createdAt: number;
}

/** PERSON-1, PERSON-2: who did something: a person, or the agent of a session. */
export type Actor = { kind: "person"; personId: string } | { kind: "agent"; sessionId: string };

/** TASK-1: what a task's state can be; done and cancelled tasks are finished. */
export type TaskState = "open" | "in_progress" | "in_review" | "done" | "cancelled";

/**
 * Requested work. Its sessions all work on its `branch` (TASK-4), which it gets when its
 * first session starts; its status and comments outlive them.
 */
export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  state: TaskState;
  /** TASK-13: one person or nobody. */
  assigneeId: string | null;
  branch: string | null;
  /** The ref the branch was created from; its merge base with the branch is where the task's work starts. */
  baseRef: string | null;
  /** TASK-7: what is done and what is next, kept current by its agents. */
  status: string;
  statusRevision: number;
  createdAt: number;
  updatedAt: number;
}

/** A task as the board and the task list show it. */
export interface TaskSummary {
  task: Task;
  topics: Topic[];
  /** Its running session (TASK-5: at most one). */
  sessionId: string | null;
}

export interface TaskDetail {
  task: Task;
  topics: Topic[];
  /** Every session the task has had, newest first. */
  sessions: Session[];
}

/** COMMENT-1: Markdown discussion on a task; never part of a running chat (COMMENT-3). */
export interface Comment {
  id: string;
  taskId: string;
  author: Actor;
  body: string;
  createdAt: number;
  /** COMMENT-2: when its author last edited it; null if never. */
  editedAt: number | null;
}

/** TASK-14: one thing that happened to a task. */
export type HistoryEvent =
  | { kind: "created" }
  | { kind: "state"; from: TaskState; to: TaskState }
  | { kind: "assignee"; personId: string | null }
  | { kind: "topic"; topicId: string; name: string; linked: boolean }
  | { kind: "session"; sessionId: string; event: "started" | "ended"; machine: string | null; runtime: SessionRuntime }
  | { kind: "comment"; commentId: string }
  | { kind: "file"; path: string }
  | { kind: "pull_request"; number: number; title: string; url: string };

/** TASK-14: an event with when and who; `actor` is null for what no one did (a pull request seen on GitHub). */
export type HistoryEntry = HistoryEvent & { at: number; actor: Actor | null };

/** FOLDER-1, FOLDER-2: a file in a task's folder; `path` is relative to the folder, `/`-separated. */
export interface FolderFile {
  path: string;
  size: number;
  contentType: string;
  /** Null when it is not known who wrote it (a file that appeared in the folder's directory). */
  addedBy: Actor | null;
  addedAt: number;
  updatedAt: number;
}

/**
 * HOST-1: where a session's agent runs: in a container, or on the host as the user with
 * full access to the machine.
 */
export type SessionRuntime = "container" | "host";

/**
 * One agent run on a task: it keeps every chat started in it after it ends; while it runs it
 * has a workspace, a worktree of the task's branch and its agent's processes (a container,
 * or the host) on `machine`.
 */
export interface Session {
  id: string;
  projectId: string;
  taskId: string;
  /** The task's title when the session started. */
  name: string;
  branch: string | null;
  /** The ref the branch was created from; its merge base with the branch is where the task's work starts. */
  baseRef: string | null;
  machine: string | null;
  runtime: SessionRuntime;
  /** HOST-6: a host session working in the project's main checkout, the live code, instead of a worktree. */
  checkout: boolean;
  /** omp model of the first chat; null: omp's default. */
  model: string | null;
  startedAt: number;
  endedAt: number | null;
}

export interface TopicLink {
  taskId: string;
  topicId: string;
  linkedAt: number;
}

/** CARD-3: a file the task's branch changed against the default branch. */
export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
}

/** CARD-3, CARD-4: what a task's branch changed, its uncommitted files, and who else changed the same files. */
export interface TaskChanges {
  branch: string | null;
  /** The default branch the task's branch started from. */
  baseRef: string | null;
  /** Commits and files on the branch since it left the default branch; null: no branch here yet. */
  committed: { commits: string[]; files: ChangedFile[] } | null;
  /** The running session's uncommitted files; null without a running session's worktree. */
  uncommitted: string[] | null;
  /** Open pull requests from the branch; null when GitHub cannot be asked. */
  pullRequests: PullRequest[] | null;
  /** CARD-4: the other running tasks of the project that changed any of the same files. */
  overlaps: Array<{ taskId: string; title: string; files: string[] }>;
}

/** blocked: waits for you (red); working: a turn runs (orange); done: turn finished (green); stopped: no live agent. */
export type TurnLight = "blocked" | "working" | "done" | "stopped";

export interface PullRequest {
  number: number;
  title: string;
  url: string;
}

export interface Card {
  session: Session;
  turn: TurnLight;
  lastUserMessage: string | null;
  lastReply: string | null;
  /** Null when the worktree cannot be read. */
  git: { uncommitted: string[]; unpushed: number; changedFiles: string[] } | null;
  /** Open pull requests from the session branch; null when GitHub cannot be asked. */
  pullRequests: PullRequest[] | null;
  /** Other running sessions of the project that changed any of the same files. */
  overlaps: Array<{ sessionId: string; name: string; files: string[] }>;
  /** The agent's Cloudflare access; null when the project has no Cloudflare tokens. */
  cloudflare: {
    /** False: the project has only a read token. */
    canWrite: boolean;
    /** Until when the user allowed the session's writes (ms since epoch); null: writes are off. */
    writesUntil: number | null;
  } | null;
}

/** TASK-9: the commits finishing a task deletes; the 409 that refuses an unconfirmed finish carries them. */
export interface UnpushedWork {
  /** Commits on the task branch that no remote has, as "<short sha> <subject>". */
  unpushed: string[];
}

/** SESSION-9: an ended session and the uncommitted files kept as its task's snapshot. */
export interface EndedSession {
  session: Session;
  kept: string[];
}

/**
 * STORE-6: a task's work that moving its project would leave on the source machine: its
 * snapshot (SESSION-9) and a stopped session's uncommitted files, which the move deletes, and
 * commits of its branch no remote has, which stay on that machine's branch.
 */
export interface MoveLeftBehind {
  taskId: string;
  title: string;
  snapshot: boolean;
  uncommitted: string[];
  unpushed: string[];
}

/** STORE-6: what the store a project moved to answers once it holds it. */
export interface MoveReceipt {
  project: Project;
  /** SHA-256 of the bundle's records as this store read them; the source deletes the project only for this digest. */
  digest: string;
  /** People this store did not have, added for the records that name them. */
  added: Person[];
  counts: { topics: number; tasks: number; comments: number; sessions: number; files: number; chats: number };
}
