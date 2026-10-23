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
  /** CARD-6: the board's one badge for its work; null on finished tasks and work with nothing to flag. */
  badge: WorkBadge | null;
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
 * One agent run on a task or an automation (SESSION-5: exactly one of `taskId` and
 * `automationId` is set): it keeps every chat started in it after it ends; while it runs it
 * has a workspace, a worktree of its branch and its agent's processes (a container, or the
 * host) on `machine`.
 */
export interface Session {
  id: string;
  projectId: string;
  /** The task it works on; null for a session of an automation. */
  taskId: string | null;
  /** The automation it belongs to: one of its runs (AUTO-9), or a session on it that is none (AUTO-11); null for a task's session. */
  automationId: string | null;
  /** The task's title, or the automation's name, when the session started. */
  name: string;
  branch: string | null;
  /** The ref the branch was created from; its merge base with the branch is where the session's work starts. */
  baseRef: string | null;
  machine: string | null;
  runtime: SessionRuntime;
  /** HOST-6: a host session working in the project's main checkout, the live code, instead of a worktree. */
  checkout: boolean;
  /** omp model of the first chat; null: omp's default. */
  model: string | null;
  startedAt: number;
  endedAt: number | null;
  /** What a run of an automation has besides a session's fields; null for a task's session, and for a session on an automation that is no run (AUTO-11). */
  run: Run | null;
}

/** AUTO-1: how a run ends: `finish` (the default) or `review`, waiting for a person (AUTO-10). */
export type EndMode = "finish" | "review";

/**
 * AUTO-1: what an automation runs (its instructions, with `model`), when (its triggers), and
 * how its runs end. `slug` names its runs' branches, `am/<slug>-<run>` (AUTO-9); an automation
 * that is off (`enabled` false) starts no runs.
 */
export interface Automation {
  id: string;
  projectId: string;
  name: string;
  slug: string;
  instructions: string;
  /** omp model of its runs; null: omp's default. */
  model: string | null;
  endMode: EndMode;
  /** AUTO-14: a run that reaches it is stopped. */
  timeLimitMinutes: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * AUTO-2, AUTO-8: when an automation fires: a cron schedule in `timezone`, optionally with a
 * guard (code) and a check (a prompt), each a file of the automation's folder.
 */
export interface Trigger {
  id: string;
  automationId: string;
  /** Five fields: minute, hour, day of month, month, day of week. */
  cron: string;
  /** IANA time zone the schedule is read in, e.g. Europe/Budapest. */
  timezone: string;
  guardPath: string | null;
  checkPath: string | null;
  createdAt: number;
}

/**
 * How a run ended, or waits (AUTO-10); null on a run that has not said. `finished`: it deployed
 * its work; `nothing_to_deploy`: it had none, and its branch is deleted; `review`: it waits for a
 * person, its session open; `timed_out`: its time limit stopped it (AUTO-14); `failed`: its agent
 * gave up, saying why; `ended`: a person ended its session before anything else said how it went.
 */
export type RunOutcome = "finished" | "nothing_to_deploy" | "review" | "timed_out" | "failed" | "ended";

/** AUTO-9: a session of an automation is one of its runs. */
export interface Run {
  /** Who started it: a person or an agent ("run now"); null: one of its triggers fired. */
  startedBy: Actor | null;
  /** What its trigger's firing found (its time, and what its guard and check said), which its prompt holds (AUTO-13); empty for "run now". */
  triggerContext: string;
  outcome: RunOutcome | null;
  /** Why it failed, or what else its agent said with its outcome; null: nothing. */
  reason: string | null;
  /** PERSON-1: who ended its session: a person, or its own agent with its outcome (AUTO-10); null while it runs, or when its time limit stopped it. */
  endedBy: Actor | null;
}

/** What a trigger's guard or check said at a firing (AUTO-8). */
export interface FiringVerdict {
  passed: boolean;
  /** The guard's output (with its errors and exit status when it failed), or why the check said yes or no. */
  output: string;
}

/**
 * AUTO-8: what became of a trigger's scheduled time: still being decided (its guard or check
 * runs), a run started, or why not (the automation was off, a run was still going, the guard
 * or the check said no, or the firing failed: the run's start, or the gateway stopped during it).
 */
export type FiringOutcome = "pending" | "started" | "off" | "running" | "guard" | "check" | "failed";

/** AUTO-2, AUTO-8: one scheduled time of a trigger, fired at most once (unique per trigger and time). */
export interface Firing {
  id: string;
  automationId: string;
  /** The trigger that fired; it may have been removed since. */
  triggerId: string;
  scheduledAt: number;
  firedAt: number;
  /** AUTO-2: the time passed while the gateway was down, and fired once it was back. */
  caughtUp: boolean;
  /** Null: the trigger has no guard, or did not get to it. */
  guard: FiringVerdict | null;
  check: FiringVerdict | null;
  outcome: FiringOutcome;
  /** The run it started (a session id). */
  sessionId: string | null;
  /** Why it failed (outcome `failed`); null otherwise. */
  error: string | null;
}

/** An automation as its project's list shows it. */
export interface AutomationSummary {
  automation: Automation;
  triggers: Trigger[];
  /** Its running run (AUTO-9: a firing while one goes is skipped). */
  sessionId: string | null;
}

/** An automation's page: the automation, its triggers, and its runs, newest first. */
export interface AutomationDetail {
  automation: Automation;
  triggers: Trigger[];
  runs: Session[];
}

export interface TopicLink {
  taskId: string;
  topicId: string;
  linkedAt: number;
}

/** CARD-3: a file the branch changed against the default branch, with its lines added and deleted (null for a binary file). */
export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  added: number | null;
  deleted: number | null;
}

/** CARD-3: a commit of the branch since it left the default branch. */
export interface WorkCommit {
  sha: string;
  subject: string;
  /** The message after the subject line; empty when there is none. */
  body: string;
  /** When it was committed (ms since epoch). */
  at: number;
  /** A remote branch has it. */
  pushed: boolean;
  /** Its page on the remote's site; null when the remote is no web host. */
  url: string | null;
}

/** CARD-3: where the branch's work is: nothing yet, uncommitted in the running session, committed but not pushed, or pushed. */
export type BranchState = "nothing" | "uncommitted" | "unpushed" | "pushed";

/** CARD-6: a card's one badge, the most important of: commits not pushed, a pull request open, a pull request merged (deployed). */
export type WorkBadge = "unpushed" | "open" | "deployed";

/**
 * CARD-3, CARD-4, AUTO-16: the Work section of a task or a run: its branch's state, commits,
 * files, and pull requests, and who else changed the same files.
 */
export interface Work {
  branch: string | null;
  /** The default branch the branch started from. */
  baseRef: string | null;
  state: BranchState;
  /** The branch's commits since it left the default branch, newest first; null: the branch cannot be read here. */
  commits: WorkCommit[] | null;
  /** The files those commits changed; null as for `commits`. */
  files: ChangedFile[] | null;
  /** The running session's uncommitted files; null without a running session's worktree. */
  uncommitted: string[] | null;
  /** The pull requests from the branch, newest first; null when GitHub cannot be asked. */
  pullRequests: PullRequest[] | null;
  /** CARD-4: the other running tasks of the project that changed any of the same files. */
  overlaps: Array<{ taskId: string; title: string; files: string[] }>;
  /** DEPLOY-1: Deploy is offered: the branch has commits and no pull request open or merged (a run's: only while it waits for review). */
  deployable: boolean;
}

/** blocked: waits for you (red); working: a turn runs (orange); done: turn finished (green); stopped: no live agent. */
export type TurnLight = "blocked" | "working" | "done" | "stopped";

export type CheckState = "passing" | "failing" | "pending";

/** CARD-3: a pull request from a branch, in any state, with its checks; a merged one is deployed. */
export interface PullRequest {
  number: number;
  title: string;
  url: string;
  state: "open" | "merged" | "closed";
  /** Its checks; null when GitHub answers about the pull request but not its checks (a token without the Checks permission). */
  checks: Array<{ name: string; state: CheckState }> | null;
}

export interface Card {
  session: Session;
  turn: TurnLight;
  lastUserMessage: string | null;
  lastReply: string | null;
  /** Null when the worktree cannot be read. */
  git: { uncommitted: string[]; unpushed: number; changedFiles: string[] } | null;
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
 * STORE-6: a task's or a run's work that moving its project would leave on the source machine:
 * its snapshot (SESSION-9) and a stopped session's uncommitted files, which the move deletes,
 * and commits of its branch no remote has, which stay on that machine's branch.
 */
export interface MoveLeftBehind {
  /** The task whose work it is; null for a run's. */
  taskId: string | null;
  /** The run (a session of an automation) whose work it is; null for a task's. */
  runId: string | null;
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
  counts: { topics: number; tasks: number; automations: number; comments: number; sessions: number; files: number; chats: number };
}
