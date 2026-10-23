// `am`: the agent's interface to the Agent Monitor store, run inside a session's container
// or on the host. Talks to the session's store socket; the socket identifies the session, so
// no credentials. STORE-5: what the UI shows, `am` shows, from the same store routes; what only
// people may do (start or end sessions, finish tasks, add people, project settings, Cloudflare
// writes, deleting automations) has no command. AUTO-15: agents create, change, and run
// automations, so they can set one up with a person.
import { execFileSync } from "node:child_process";
import { createReadStream, createWriteStream, readFileSync, statSync } from "node:fs";
import { request, type IncomingMessage } from "node:http";
import { basename, dirname, join } from "node:path";
import type { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
// Types only: erased when Node runs this file, so the container needs no copy of shared/.
import type { Actor, Card, ChangedFile, HistoryEntry, Person, Project, PullRequest, TaskChanges, TaskState, TurnLight } from "../shared/api.ts";

const USAGE = `usage: am [--json] COMMAND [--task ID]

  whoami                              this session, its task (or automation and run), and its
                                      project
  task show                           the task: description, state, assignee, topics, status,
                                      and its sessions
  task status                         print the task's status; first line is its revision
  task set-status --base REV          replace the task's status with stdin (max 50 lines):
                                      what is done and what is next, for the next session;
                                      REV is the revision you read; a stale REV is refused
  task set-state STATE                open, in_progress, or in_review
  task set-title TITLE                rename the task
  task set-description                replace the task's description with stdin (Markdown)
  task assign PERSON                  assign the task to a person (name or id), or nobody
  task history                        what happened to the task, oldest first: who, what, when
  task changes                        what the task's branch changed against the default
                                      branch, its uncommitted files, its open pull requests,
                                      and the other running tasks that changed the same files
  task create TITLE                   create another task (stdin: its description)
  task search [WORDS...]              every task of this project, done and cancelled too,
                                      whose title, description, or comments hold all of WORDS
  board                               the project's open, in-progress, and in-review tasks
                                      with their topics, assignee, and running session
  comments                            the task's comments, oldest first, with author and time
  comment                             comment on the task (stdin: Markdown); people read it
                                      on the task's page, never in a running chat
  comment edit ID                     replace your comment ID with stdin
  comment delete ID                   delete your comment ID
  check                               what would not survive this session: uncommitted
                                      files, unpushed commits, and untracked files that
                                      look like secrets; fails while there are any
  topic list                          topics of this project
  topic create NAME                   create a topic
  topic show NAME                     a topic's status and linked tasks
  topic status NAME                   print a topic's status; first line is its revision
  topic set-status NAME --base REV    replace the status with stdin (max 50 lines);
                                      REV is the revision you read; a stale REV is refused
  topic link NAME...                  link the task to topics
  topic unlink NAME...                unlink the task from topics
  session show [ID]                   a session, its task or automation, and its state
                                      (default: this one)
  folder                              the files in the task's folder (a run's: its
                                      automation's), who added each, when
  folder add FILE [PATH]              put FILE into the folder as PATH (default: its name),
                                      replacing a file there
  folder get PATH [FILE]              write the folder's file PATH to FILE (default: stdout)
  folder rm PATH                      delete the folder's file PATH
  people                              the store's people, the owner first
  project show                        the project's settings: name, repository, and whether
                                      it allows host sessions

  automation list                     the project's automations: on or off, triggers, and
                                      whether a run is going
  automation show [NAME]              an automation: its fields, triggers, instructions, and
                                      runs (default: the one this run serves)
  automation create NAME [FIELDS]     create an automation (stdin: its instructions)
  automation set NAME [FIELDS] [--name NEW] [--instructions]
                                      change an automation's fields; --instructions replaces
                                      its instructions with stdin
      FIELDS: --model MODEL|default --end-mode finish|review --time-limit MINUTES
              --on|--off --slug SLUG (its runs' branches: am/SLUG-RUN)
  automation trigger add NAME --cron "M H D MON WD" [--timezone TZ] [--guard PATH]
                     [--check PATH]   add a schedule (default timezone Europe/Budapest);
                                      guard and check are files of its folder
  automation trigger set NAME TRIGGER [--cron C] [--timezone TZ] [--guard PATH|none]
                     [--check PATH|none]
                                      change a trigger (TRIGGER: its id, from show)
  automation trigger remove NAME TRIGGER
  automation run NAME                 run it now: a new session of the automation on its
                                      own branch, its instructions as the first prompt
  automation folder NAME [add FILE [PATH] | get PATH [FILE] | rm PATH]
                                      the automation's folder, as folder above

  --task ID                           act on another task of this project instead of this
                                      session's (task, comments, comment, topic link/unlink,
                                      folder); a run of an automation has no task of its own

People start and end sessions, finish tasks, add people, change the project's settings,
delete automations, and allow Cloudflare writes in the app; ask them on the task (am comment)
when that is needed.

environment: AM_SOCKET (default /run/agentmonitor/am.sock)`;

interface Topic {
  id: string;
  name: string;
  status: string;
  statusRevision: number;
}

interface Envelope {
  ok: boolean;
  data?: unknown;
  error?: string;
  currentRevision?: number;
}

class CliError extends Error {}

/** The store answered with something else than the route promises: am and the gateway are out of step. */
function unexpected(what: string): CliError {
  return new CliError(`the store answered with something that is not ${what}`);
}

const socketPath = process.env.AM_SOCKET ?? "/run/agentmonitor/am.sock";

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; text: string }>();
  const req = request({
    socketPath,
    path: `/api/store${path}`,
    method,
    headers: payload === undefined ? {} : { "content-type": "application/json" },
  }, (res) => {
    let text = "";
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => { text += chunk; });
    res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
  });
  req.on("error", (error) => reject(new CliError(`cannot reach the store at ${socketPath}: ${error.message}`)));
  req.end(payload);
  const { text } = await promise;
  return envelopeOf(text);
}

function envelopeOf(text: string): unknown {
  const envelope = JSON.parse(text) as Envelope;
  if (!envelope.ok) {
    const extra = envelope.currentRevision === undefined ? "" : ` (current revision ${envelope.currentRevision})`;
    throw new CliError(`${envelope.error ?? "request failed"}${extra}`);
  }
  return envelope.data;
}

/** FOLDER-1: a file of the folder at `base` (`/tasks/<id>` or `/automations/<id>`), as the store's routes name it. */
function folderRoute(base: string, path: string): string {
  return `${base}/folder/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** AUTO-9: how a run is named in its branch, `am/<slug>-<run>`: the start of its session's id. */
function runShortId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

/**
 * FOLDER-1: a request whose body or answer is a file's bytes, streamed: `upload` is the file
 * to send; `sink` opens where a successful answer goes. Refusals answer JSON, as `call`'s do.
 */
async function transfer(method: string, path: string, upload: string | null, sink: (() => Writable) | null): Promise<unknown> {
  const { promise, resolve, reject } = Promise.withResolvers<IncomingMessage>();
  const req = request({ socketPath, path: `/api/store${path}`, method }, resolve);
  req.on("error", (error) => reject(new CliError(`cannot reach the store at ${socketPath}: ${error.message}`)));
  if (upload === null) req.end();
  else pipeline(createReadStream(upload), req).catch((error: unknown) => req.destroy(error instanceof Error ? error : undefined));
  const response = await promise;
  if (response.statusCode === 200 && sink !== null) {
    const target = sink();
    await pipeline(response, target, { end: target !== process.stdout });
    return null;
  }
  let text = "";
  response.setEncoding("utf8");
  for await (const chunk of response) text += chunk;
  return envelopeOf(text);
}

interface FolderFile {
  path: string;
  size: number;
  addedBy: Actor | null;
  addedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isActor(value: unknown): value is Actor {
  return isRecord(value) && ((value.kind === "person" && typeof value.personId === "string") || (value.kind === "agent" && typeof value.sessionId === "string"));
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

const TASK_STATES: TaskState[] = ["open", "in_progress", "in_review", "done", "cancelled"];

function isTaskState(value: unknown): value is TaskState {
  return TASK_STATES.some((state) => state === value);
}

function listOf<T>(value: unknown, what: string, item: (value: unknown) => T): T[] {
  if (!Array.isArray(value)) throw unexpected(what);
  return value.map(item);
}

function folderFileOf(value: unknown): FolderFile {
  if (!isRecord(value) || typeof value.path !== "string" || typeof value.size !== "number" || typeof value.addedAt !== "number") {
    throw unexpected("a folder file");
  }
  return { path: value.path, size: value.size, addedBy: isActor(value.addedBy) ? value.addedBy : null, addedAt: value.addedAt };
}

function folderFilesOf(value: unknown): FolderFile[] {
  return listOf(value, "a folder", folderFileOf);
}

interface Session {
  id: string;
  projectId: string;
  name: string;
  branch: string | null;
  baseRef: string | null;
  machine: string | null;
  runtime: string;
  checkout: boolean;
  startedAt: number;
  endedAt: number | null;
}

function sessionOf(value: unknown): Session {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.projectId !== "string" || typeof value.name !== "string"
    || (value.branch !== null && typeof value.branch !== "string") || (value.baseRef !== null && typeof value.baseRef !== "string")
    || (value.machine !== null && typeof value.machine !== "string") || typeof value.runtime !== "string" || typeof value.checkout !== "boolean"
    || typeof value.startedAt !== "number" || (value.endedAt !== null && typeof value.endedAt !== "number")) {
    throw unexpected("a session");
  }
  return {
    id: value.id,
    projectId: value.projectId,
    name: value.name,
    branch: value.branch,
    baseRef: value.baseRef,
    machine: value.machine,
    runtime: value.runtime,
    checkout: value.checkout,
    startedAt: value.startedAt,
    endedAt: value.endedAt,
  };
}

interface Task {
  id: string;
  title: string;
  description: string;
  state: TaskState;
  assigneeId: string | null;
  branch: string | null;
  status: string;
  statusRevision: number;
  createdAt: number;
}

function taskOf(value: unknown): Task {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.title !== "string" || typeof value.description !== "string"
    || !isTaskState(value.state) || typeof value.status !== "string" || typeof value.statusRevision !== "number"
    || (value.assigneeId !== null && typeof value.assigneeId !== "string") || (value.branch !== null && typeof value.branch !== "string")
    || typeof value.createdAt !== "number") {
    throw unexpected("a task");
  }
  return {
    id: value.id,
    title: value.title,
    description: value.description,
    state: value.state,
    assigneeId: value.assigneeId,
    branch: value.branch,
    status: value.status,
    statusRevision: value.statusRevision,
    createdAt: value.createdAt,
  };
}

function topicsOf(value: unknown): Topic[] {
  return listOf(value, "a topic list", (item) => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.status !== "string"
      || typeof item.statusRevision !== "number") {
      throw unexpected("a topic");
    }
    return { id: item.id, name: item.name, status: item.status, statusRevision: item.statusRevision };
  });
}

/** A task as the board and the task list show it (`TaskSummary`). */
interface Summary {
  task: Task;
  topics: Topic[];
  sessionId: string | null;
}

function summariesOf(value: unknown): Summary[] {
  return listOf(value, "a task list", (item) => {
    if (!isRecord(item) || (item.sessionId !== null && typeof item.sessionId !== "string")) throw unexpected("a task");
    return { task: taskOf(item.task), topics: topicsOf(item.topics), sessionId: item.sessionId };
  });
}

/** TASK-12: a task's page: the task, its topics, and every session it has had, newest first. */
function taskDetailOf(value: unknown): { task: Task; topics: Topic[]; sessions: Session[] } {
  if (!isRecord(value)) throw unexpected("a task");
  return { task: taskOf(value.task), topics: topicsOf(value.topics), sessions: listOf(value.sessions, "a session list", sessionOf) };
}

function peopleOf(value: unknown): Person[] {
  return listOf(value, "a list of people", (item) => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.color !== "string"
      || (item.email !== null && typeof item.email !== "string") || typeof item.owner !== "boolean" || typeof item.createdAt !== "number") {
      throw unexpected("a person");
    }
    return { id: item.id, name: item.name, email: item.email, color: item.color, owner: item.owner, createdAt: item.createdAt };
  });
}

function projectOf(value: unknown): Project {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string" || (value.repoPath !== null && typeof value.repoPath !== "string")
    || typeof value.hostSessions !== "boolean" || !isRecord(value.cloudflare) || typeof value.cloudflare.read !== "boolean"
    || typeof value.cloudflare.write !== "boolean" || typeof value.createdAt !== "number") {
    throw unexpected("a project");
  }
  const cloudflare = { read: value.cloudflare.read, write: value.cloudflare.write };
  return { id: value.id, name: value.name, repoPath: value.repoPath, hostSessions: value.hostSessions, cloudflare, createdAt: value.createdAt };
}

/** CLOUDFLARE-3: which Cloudflare tokens the project has, as its settings page says it; never the tokens. */
function cloudflareTokensLine({ cloudflare }: Project): string {
  if (!cloudflare.read) return "cloudflare no tokens";
  return cloudflare.write ? "cloudflare read token set, write token set" : "cloudflare read token set, no write token";
}

/** TASK-14: one entry of a task's history, checked field by field for its kind. */
function historyEntryOf(value: unknown): HistoryEntry {
  if (!isRecord(value) || typeof value.at !== "number" || (value.actor !== null && !isActor(value.actor))) throw unexpected("a history entry");
  const base = { at: value.at, actor: value.actor };
  switch (value.kind) {
    case "created":
      return { kind: "created", ...base };
    case "state":
      if (isTaskState(value.from) && isTaskState(value.to)) return { kind: "state", from: value.from, to: value.to, ...base };
      break;
    case "assignee":
      if (value.personId === null || typeof value.personId === "string") return { kind: "assignee", personId: value.personId, ...base };
      break;
    case "topic":
      if (typeof value.topicId === "string" && typeof value.name === "string" && typeof value.linked === "boolean") {
        return { kind: "topic", topicId: value.topicId, name: value.name, linked: value.linked, ...base };
      }
      break;
    case "session":
      if (typeof value.sessionId === "string" && (value.event === "started" || value.event === "ended")
        && (value.machine === null || typeof value.machine === "string") && (value.runtime === "container" || value.runtime === "host")) {
        return { kind: "session", sessionId: value.sessionId, event: value.event, machine: value.machine, runtime: value.runtime, ...base };
      }
      break;
    case "comment":
      if (typeof value.commentId === "string") return { kind: "comment", commentId: value.commentId, ...base };
      break;
    case "file":
      if (typeof value.path === "string") return { kind: "file", path: value.path, ...base };
      break;
    case "pull_request":
      if (typeof value.number === "number" && typeof value.title === "string" && typeof value.url === "string") {
        return { kind: "pull_request", number: value.number, title: value.title, url: value.url, ...base };
      }
      break;
  }
  throw unexpected("a history entry");
}

function changedFileOf(value: unknown): ChangedFile {
  if (!isRecord(value) || typeof value.path !== "string"
    || !(value.status === "added" || value.status === "modified" || value.status === "deleted" || value.status === "renamed")) {
    throw unexpected("a changed file");
  }
  return { path: value.path, status: value.status };
}

function pullRequestOf(value: unknown): PullRequest {
  if (!isRecord(value) || typeof value.number !== "number" || typeof value.title !== "string" || typeof value.url !== "string") {
    throw unexpected("a pull request");
  }
  return { number: value.number, title: value.title, url: value.url };
}

/** CARD-3, CARD-4: a task's Changes view. */
function changesOf(value: unknown): TaskChanges {
  if (!isRecord(value)) throw unexpected("a task's changes");
  const { branch, baseRef, committed, uncommitted, pullRequests, overlaps } = value;
  if ((branch !== null && typeof branch !== "string") || (baseRef !== null && typeof baseRef !== "string") || (uncommitted !== null && !isStrings(uncommitted))) {
    throw unexpected("a task's changes");
  }
  let onBranch: TaskChanges["committed"] = null;
  if (committed !== null) {
    if (!isRecord(committed) || !isStrings(committed.commits)) throw unexpected("a task's changes");
    onBranch = { commits: committed.commits, files: listOf(committed.files, "a list of changed files", changedFileOf) };
  }
  return {
    branch,
    baseRef,
    committed: onBranch,
    uncommitted,
    pullRequests: pullRequests === null ? null : listOf(pullRequests, "a list of pull requests", pullRequestOf),
    overlaps: listOf(overlaps, "a list of overlapping tasks", (item) => {
      if (!isRecord(item) || typeof item.taskId !== "string" || typeof item.title !== "string" || !isStrings(item.files)) throw unexpected("an overlapping task");
      return { taskId: item.taskId, title: item.title, files: item.files };
    }),
  };
}

/** CARD-1, CARD-4, CLOUDFLARE-2: what a running session's card shows. */
interface CardView {
  session: Session;
  turn: TurnLight;
  overlaps: string[];
  cloudflare: Card["cloudflare"];
}

function cardsOf(value: unknown): CardView[] {
  return listOf(value, "a list of session cards", (item) => {
    if (!isRecord(item) || !(item.turn === "blocked" || item.turn === "working" || item.turn === "done" || item.turn === "stopped")) {
      throw unexpected("a session card");
    }
    const { cloudflare } = item;
    let access: Card["cloudflare"] = null;
    if (cloudflare !== null) {
      if (!isRecord(cloudflare) || typeof cloudflare.canWrite !== "boolean" || (cloudflare.writesUntil !== null && typeof cloudflare.writesUntil !== "number")) {
        throw unexpected("a session card");
      }
      access = { canWrite: cloudflare.canWrite, writesUntil: cloudflare.writesUntil };
    }
    const overlaps = listOf(item.overlaps, "a list of overlapping sessions", (overlap) => {
      if (!isRecord(overlap) || typeof overlap.name !== "string") throw unexpected("an overlapping session");
      return overlap.name;
    });
    return { session: sessionOf(item.session), turn: item.turn, overlaps, cloudflare: access };
  });
}

/** AUTO-1: an automation as am shows it. */
interface Automation {
  id: string;
  name: string;
  slug: string;
  instructions: string;
  model: string | null;
  endMode: string;
  timeLimitMinutes: number;
  enabled: boolean;
}

function automationOf(value: unknown): Automation {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string" || typeof value.slug !== "string"
    || typeof value.instructions !== "string" || (value.model !== null && typeof value.model !== "string") || typeof value.endMode !== "string"
    || typeof value.timeLimitMinutes !== "number" || typeof value.enabled !== "boolean") {
    throw unexpected("an automation");
  }
  return {
    id: value.id,
    name: value.name,
    slug: value.slug,
    instructions: value.instructions,
    model: value.model,
    endMode: value.endMode,
    timeLimitMinutes: value.timeLimitMinutes,
    enabled: value.enabled,
  };
}

/** AUTO-8: a trigger of an automation: a schedule, with an optional guard and check in its folder. */
interface Trigger {
  id: string;
  cron: string;
  timezone: string;
  guardPath: string | null;
  checkPath: string | null;
}

function triggerOf(value: unknown): Trigger {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.cron !== "string" || typeof value.timezone !== "string"
    || (value.guardPath !== null && typeof value.guardPath !== "string") || (value.checkPath !== null && typeof value.checkPath !== "string")) {
    throw unexpected("a trigger");
  }
  return { id: value.id, cron: value.cron, timezone: value.timezone, guardPath: value.guardPath, checkPath: value.checkPath };
}

function triggerLine(trigger: Trigger): string {
  const guard = trigger.guardPath === null ? "" : `, guard ${trigger.guardPath}`;
  const check = trigger.checkPath === null ? "" : `, check ${trigger.checkPath}`;
  return `${trigger.id}\t${trigger.cron} (${trigger.timezone})${guard}${check}`;
}

interface Me {
  kind: string;
  project: { id: string; name: string };
  session: Session;
  /** SESSION-5: the session's task, or for a run of an automation, its automation; the other is null. */
  task: Task | null;
  automation: Automation | null;
}

async function whoami(): Promise<Me> {
  const me = await call("GET", "/me");
  if (!isRecord(me) || me.kind !== "agent") throw new CliError("am must run inside a session's container");
  if (!isRecord(me.project) || typeof me.project.id !== "string" || typeof me.project.name !== "string") throw unexpected("a project");
  return {
    kind: me.kind,
    project: { id: me.project.id, name: me.project.name },
    session: sessionOf(me.session),
    task: me.task === null ? null : taskOf(me.task),
    automation: me.automation === null ? null : automationOf(me.automation),
  };
}

interface Comment {
  id: string;
  author: Actor;
  body: string;
  createdAt: number;
  editedAt: number | null;
}

function commentOf(value: unknown): Comment {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.body !== "string" || typeof value.createdAt !== "number"
    || (value.editedAt !== null && typeof value.editedAt !== "number") || !isActor(value.author)) {
    throw unexpected("a comment");
  }
  return { id: value.id, author: value.author, body: value.body, createdAt: value.createdAt, editedAt: value.editedAt };
}

/** As the UI says a task's state and a session's light (BOARD-1, CARD-1); a blocked agent waits on a person, not on the agent asking. */
const STATE_LABEL: Record<TaskState, string> = { open: "Open", in_progress: "In progress", in_review: "In review", done: "Done", cancelled: "Cancelled" };
const LIGHT_LABEL: Record<TurnLight, string> = { blocked: "Waiting on a person", working: "Working", done: "Idle", stopped: "Stopped" };
/** BOARD-1: the board's columns; done and cancelled tasks leave it. */
const BOARD_COLUMNS: TaskState[] = ["open", "in_progress", "in_review"];

/** PERSON-1, PERSON-2: who did something, as am names them: a person by name, an agent by its session. */
function actorName(actor: Actor | null, people: Person[], me: Me): string {
  if (actor === null) return "GitHub";
  if (actor.kind === "agent") return actor.sessionId === me.session.id ? "this session's agent" : `the agent of session ${actor.sessionId}`;
  return people.find((person) => person.id === actor.personId)?.name ?? "someone no longer in the store";
}

/** TASK-14: what a history entry's actor did, in the words of the task page's History. */
function describe(entry: HistoryEntry, people: Person[], comments: Comment[]): string {
  switch (entry.kind) {
    case "created":
      return "created the task";
    case "state":
      return `moved it from ${STATE_LABEL[entry.from]} to ${STATE_LABEL[entry.to]}`;
    case "assignee": {
      if (entry.personId === null) return "unassigned it";
      return `assigned it to ${people.find((person) => person.id === entry.personId)?.name ?? "someone"}`;
    }
    case "topic":
      return `${entry.linked ? "linked" : "unlinked"} topic ${entry.name}`;
    case "session":
      return `${entry.event} a ${entry.runtime === "host" ? "host " : ""}session${entry.machine === null ? "" : ` on ${entry.machine}`}`;
    case "comment":
      return comments.some((comment) => comment.id === entry.commentId) ? "wrote a comment" : "wrote a comment, since deleted";
    case "file":
      return `added ${entry.path}`;
    case "pull_request":
      return `pull request #${entry.number} ${entry.title} opened`;
  }
}

/** Where a session's agent runs (HOST-1, HOST-6). */
function runsIn(session: Session): string {
  if (session.runtime !== "host") return "container";
  return session.checkout ? "host, main checkout" : "host";
}

/** CLOUDFLARE-2: the agent's Cloudflare access, as the task's Cloudflare settings say it. */
function cloudflareLine(cloudflare: Card["cloudflare"]): string {
  if (cloudflare === null) return "no Cloudflare tokens in Agent Monitor";
  if (!cloudflare.canWrite) return "reads; the project has no write token";
  return cloudflare.writesUntil === null ? "reads; writes are off" : `reads; writes allowed until ${new Date(cloudflare.writesUntil).toISOString()}`;
}

/** Untracked files with these names are credentials far more often than work. */
const SECRET_FILE = /(^|\/)(\.env(\.[^/]+)?|[^/]+\.env|[^/]+\.(pem|key|p12|pfx)|id_(rsa|ecdsa|ed25519)|credentials(\.json)?|[^/]*secret[^/]*)$/i;
const EXAMPLE_FILE = /\.(example|sample|template)$/i;

/** TASK-11: what ending this session would leave behind on this machine only, or lose. */
function checkWorktree(me: Me): { uncommitted: string[]; secrets: string[]; unpushed: string[] } {
  const launch: unknown = JSON.parse(readFileSync(join(dirname(socketPath), "launch.json"), "utf8"));
  const cwd = isRecord(launch) && typeof launch.cwd === "string" ? launch.cwd : process.cwd();
  const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const uncommitted: string[] = [];
  const secrets: string[] = [];
  // -z entries are "XY path"; renames carry the old path as an extra entry, which is skipped.
  const entries = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]).split("\0").filter(Boolean);
  for (let index = 0; index < entries.length; index++) {
    const path = entries[index].slice(3);
    if (entries[index].startsWith("??") && SECRET_FILE.test(path) && !EXAMPLE_FILE.test(path)) secrets.push(path);
    else uncommitted.push(path);
    if (entries[index][0] === "R" || entries[index][0] === "C") index++;
  }
  const notOnRemotes = ["log", "--format=%h %s", "HEAD", "--not", "--remotes", ...(me.session.baseRef === null ? [] : [me.session.baseRef])];
  const unpushed = git(notOnRemotes).split("\n").filter(Boolean);
  return { uncommitted, secrets, unpushed };
}

async function topicByName(me: Me, name: string): Promise<Topic> {
  const topics = topicsOf(await call("GET", `/projects/${me.project.id}/topics`));
  const found = topics.find((topic) => topic.name === name);
  if (found === undefined) {
    const known = topics.map((topic) => `"${topic.name}"`).join(", ") || "none";
    throw new CliError(`no topic "${name}" in ${me.project.name} (topics: ${known}); create it with: am topic create NAME`);
  }
  return found;
}

/** TASK-13: the person a name or id stands for; "nobody" unassigns. */
function assigneeOf(people: Person[], who: string): string | null {
  if (who === "nobody") return null;
  const byId = people.find((person) => person.id === who);
  if (byId !== undefined) return byId.id;
  const named = people.filter((person) => person.name === who);
  if (named.length === 1) return named[0].id;
  const known = people.map((person) => `"${person.name}"`).join(", ");
  if (named.length > 1) throw new CliError(`${named.length} people are named "${who}"; name one by id (am people)`);
  throw new CliError(`no person "${who}" in the store (people: ${known}); assign nobody with: am task assign nobody`);
}

function print(json: boolean, data: unknown, human: () => string): void {
  console.log(json ? JSON.stringify(data, null, 2) : human());
}

function topicNames(topics: Topic[]): string {
  return topics.length === 0 ? "no topics" : topics.map((topic) => topic.name).join("\n");
}

function revisionOf(value: string): number {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 0) throw new CliError("--base must be a revision number");
  return revision;
}

/** `--task ID`, anywhere after the command: the task to act on instead of the session's own. */
function taskOption(args: string[]): { task: string | null; rest: string[] } {
  const at = args.indexOf("--task");
  if (at === -1) return { task: null, rest: args };
  const task = args[at + 1];
  if (task === undefined) throw new CliError("--task needs a task id (am task search finds it)");
  return { task, rest: args.toSpliced(at, 2) };
}

/** `--option VALUE` options and `--switch` switches among a command's arguments; the other arguments stay in order. */
function optionsOf(args: string[], valued: string[], switches: string[]): { values: Map<string, string>; switches: Set<string>; rest: string[] } {
  const values = new Map<string, string>();
  const on = new Set<string>();
  const rest: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (valued.includes(arg)) {
      const value = args[index + 1];
      if (value === undefined) throw new CliError(`${arg} needs a value`);
      values.set(arg, value);
      index++;
    } else if (switches.includes(arg)) {
      on.add(arg);
    } else if (arg.startsWith("--")) {
      throw new CliError(`unknown option ${arg}`);
    } else {
      rest.push(arg);
    }
  }
  return { values, switches: on, rest };
}

/** FOLDER-1, AUTO-1: `am folder` and `am automation folder NAME`, on the folder at `base`; false for no folder command. */
async function folderCommand(json: boolean, me: Me, base: string, command: string | undefined, rest: string[]): Promise<boolean> {
  if (command === undefined) {
    const files = folderFilesOf(await call("GET", `${base}/folder`));
    const people = peopleOf(await call("GET", "/people"));
    const lines = files.map((file) => {
      const who = file.addedBy === null ? "unknown" : actorName(file.addedBy, people, me);
      return `${file.path}\t${file.size} bytes\tadded by ${who}\t${new Date(file.addedAt).toISOString()}`;
    });
    print(json, files, () => lines.length === 0 ? "the folder is empty" : lines.join("\n"));
    return true;
  }
  if (command === "add" && (rest.length === 1 || rest.length === 2)) {
    if (!statSync(rest[0], { throwIfNoEntry: false })?.isFile()) throw new CliError(`${rest[0]} is not a file`);
    const added = folderFileOf(await transfer("PUT", folderRoute(base, rest[1] ?? basename(rest[0])), rest[0], null));
    print(json, added, () => `added ${added.path} (${added.size} bytes)`);
    return true;
  }
  if (command === "get" && (rest.length === 1 || rest.length === 2)) {
    const target = rest[1];
    await transfer("GET", folderRoute(base, rest[0]), null, () => target === undefined ? process.stdout : createWriteStream(target));
    return true;
  }
  if (command === "rm" && rest.length === 1) {
    const left = folderFilesOf(await call("DELETE", folderRoute(base, rest[0])));
    print(json, left, () => `deleted ${rest[0]}; ${left.length} file(s) left`);
    return true;
  }
  return false;
}

/** AUTO-15: the automation a name, slug, or id stands for, among the project's. */
async function automationByName(me: Me, name: string): Promise<Automation> {
  const listed = listOf(await call("GET", `/projects/${me.project.id}/automations`), "a list of automations", (item) => automationOf(isRecord(item) ? item.automation : undefined));
  const found = listed.find((candidate) => candidate.id === name || candidate.name === name || candidate.slug === name);
  if (found !== undefined) return found;
  const known = listed.map((candidate) => `"${candidate.name}"`).join(", ") || "none";
  throw new CliError(`no automation "${name}" in ${me.project.name} (automations: ${known}); create one with: am automation create NAME`);
}

/**
 * AUTO-1: the fields `create` and `set` take as options, as the store's automation routes name
 * them; `set` also renames (`--name`) and replaces the instructions with stdin (`--instructions`).
 */
function automationFields(args: string[], setting: boolean): { fields: Record<string, unknown>; rest: string[] } {
  const options = optionsOf(
    args,
    ["--model", "--end-mode", "--time-limit", "--slug", ...(setting ? ["--name"] : [])],
    ["--on", "--off", ...(setting ? ["--instructions"] : [])],
  );
  const fields: Record<string, unknown> = {};
  const name = options.values.get("--name");
  if (name !== undefined) fields.name = name;
  const model = options.values.get("--model");
  if (model !== undefined) fields.model = model === "default" ? null : model;
  const endMode = options.values.get("--end-mode");
  if (endMode !== undefined) fields.endMode = endMode;
  const limit = options.values.get("--time-limit");
  if (limit !== undefined) {
    const minutes = Number(limit);
    if (!Number.isInteger(minutes) || minutes < 1) throw new CliError("--time-limit is a number of whole minutes");
    fields.timeLimitMinutes = minutes;
  }
  const slug = options.values.get("--slug");
  if (slug !== undefined) fields.slug = slug;
  if (options.switches.has("--on") && options.switches.has("--off")) throw new CliError("--on and --off contradict each other");
  if (options.switches.has("--on")) fields.enabled = true;
  if (options.switches.has("--off")) fields.enabled = false;
  if (options.switches.has("--instructions")) fields.instructions = readFileSync(0, "utf8");
  return { fields, rest: options.rest };
}

/** AUTO-8: a trigger's fields as options; `none` removes a guard or a check. */
function triggerFields(args: string[]): { fields: Record<string, unknown>; rest: string[] } {
  const options = optionsOf(args, ["--cron", "--timezone", "--guard", "--check"], []);
  const fields: Record<string, unknown> = {};
  const cron = options.values.get("--cron");
  if (cron !== undefined) fields.cron = cron;
  const timezone = options.values.get("--timezone");
  if (timezone !== undefined) fields.timezone = timezone;
  const guard = options.values.get("--guard");
  if (guard !== undefined) fields.guardPath = guard === "none" ? null : guard;
  const check = options.values.get("--check");
  if (check !== undefined) fields.checkPath = check === "none" ? null : check;
  return { fields, rest: options.rest };
}

function automationText(automation: Automation): string {
  return [
    `automation ${automation.name} (${automation.id})`,
    `state      ${automation.enabled ? "on" : "off: it starts no runs"}`,
    `model      ${automation.model ?? "default"}`,
    `end mode   ${automation.endMode}`,
    `time limit ${automation.timeLimitMinutes} minutes`,
    `branches   am/${automation.slug}-<run>`,
  ].join("\n");
}

/** AUTO-15: `am automation …`; false for no automation command. */
async function automationCommand(json: boolean, me: Me, command: string | undefined, args: string[]): Promise<boolean> {
  if (command === "list" && args.length === 0) {
    const listed = await call("GET", `/projects/${me.project.id}/automations`);
    const summaries = listOf(listed, "a list of automations", (item) => {
      if (!isRecord(item) || (item.sessionId !== null && typeof item.sessionId !== "string")) throw unexpected("an automation");
      return { automation: automationOf(item.automation), triggers: listOf(item.triggers, "a list of triggers", triggerOf), sessionId: item.sessionId };
    });
    print(json, listed, () => summaries.map(({ automation, triggers, sessionId }) => [
      automation.id,
      automation.enabled ? "on " : "off",
      automation.name,
      `${triggers.length} trigger(s)`,
      sessionId === null ? "no run going" : `run ${runShortId(sessionId)} going (session ${sessionId})`,
    ].join("\t")).join("\n") || "no automations");
    return true;
  }
  if (command === "show" && args.length <= 1) {
    const automation = args[0] === undefined ? me.automation : await automationByName(me, args[0]);
    if (automation === null) throw new CliError("name the automation: am automation show NAME (am automation list)");
    const detail = await call("GET", `/automations/${automation.id}`);
    if (!isRecord(detail)) throw unexpected("an automation");
    const shown = automationOf(detail.automation);
    const triggers = listOf(detail.triggers, "a list of triggers", triggerOf);
    const runs = listOf(detail.runs, "a list of runs", (item) => {
      const outcome = isRecord(item) && isRecord(item.run) && typeof item.run.outcome === "string" ? item.run.outcome : null;
      return { session: sessionOf(item), outcome };
    });
    print(json, detail, () => [
      automationText(shown),
      "",
      "triggers:",
      ...(triggers.length === 0 ? ["  (none: it runs only when someone runs it now)"] : triggers.map((trigger) => `  ${triggerLine(trigger)}`)),
      "",
      "instructions:",
      shown.instructions.trimEnd() || "(none)",
      "",
      "runs:",
      ...(runs.length === 0 ? ["  (none)"] : runs.map(({ session, outcome }) => [
        `  ${session.id}`,
        session.endedAt === null ? "going" : `ended ${new Date(session.endedAt).toISOString()}${outcome === null ? "" : ` (${outcome})`}`,
        `started ${new Date(session.startedAt).toISOString()}`,
        session.branch ?? "no branch",
      ].join("\t"))),
    ].join("\n"));
    return true;
  }
  if (command === "create") {
    const { fields, rest } = automationFields(args, false);
    if (rest.length !== 1) return false;
    const instructions = process.stdin.isTTY ? "" : readFileSync(0, "utf8");
    const created = await call("POST", `/projects/${me.project.id}/automations`, { name: rest[0], instructions, ...fields });
    const automation = automationOf(created);
    print(json, created, () => `created automation "${automation.name}" (${automation.id}); add a schedule with: am automation trigger add "${automation.name}" --cron "…"`);
    return true;
  }
  if (command === "set") {
    const { fields, rest } = automationFields(args, true);
    if (rest.length !== 1) return false;
    if (Object.keys(fields).length === 0) throw new CliError("nothing to change: name a field to set (am help)");
    const automation = await automationByName(me, rest[0]);
    const updated = await call("PATCH", `/automations/${automation.id}`, fields);
    print(json, updated, () => automationText(automationOf(updated)));
    return true;
  }
  if (command === "trigger") {
    const [action, ...more] = args;
    const { fields, rest } = triggerFields(more);
    if (action === "add" && rest.length === 1) {
      if (fields.cron === undefined) throw new CliError("a trigger needs --cron \"MINUTE HOUR DAY MONTH WEEKDAY\"");
      const automation = await automationByName(me, rest[0]);
      const added = await call("POST", `/automations/${automation.id}/triggers`, fields);
      print(json, added, () => `added trigger ${triggerLine(triggerOf(added))}`);
      return true;
    }
    // A trigger's id names it in the store; the automation's name keeps it from changing another's.
    const ownTrigger = async (name: string, triggerId: string): Promise<string> => {
      const automation = await automationByName(me, name);
      const detail = await call("GET", `/automations/${automation.id}`);
      const triggers = listOf(isRecord(detail) ? detail.triggers : undefined, "a list of triggers", triggerOf);
      if (!triggers.some((trigger) => trigger.id === triggerId)) throw new CliError(`automation "${automation.name}" has no trigger ${triggerId} (am automation show "${automation.name}")`);
      return triggerId;
    };
    if (action === "set" && rest.length === 2) {
      const updated = await call("PATCH", `/triggers/${await ownTrigger(rest[0], rest[1])}`, fields);
      print(json, updated, () => `trigger ${triggerLine(triggerOf(updated))}`);
      return true;
    }
    if (action === "remove" && rest.length === 2 && Object.keys(fields).length === 0) {
      const removed = await call("DELETE", `/triggers/${await ownTrigger(rest[0], rest[1])}`);
      print(json, removed, () => `removed trigger ${triggerOf(removed).id}`);
      return true;
    }
    return false;
  }
  if (command === "run" && args.length === 1) {
    const automation = await automationByName(me, args[0]);
    const started = await call("POST", `/automations/${automation.id}/runs`, {});
    const session = sessionOf(started);
    print(json, started, () => `started run ${runShortId(session.id)} of "${automation.name}" (session ${session.id}) on ${session.branch ?? "no branch"}`);
    return true;
  }
  if (command === "folder" && args.length >= 1) {
    const automation = await automationByName(me, args[0]);
    const [action, ...rest] = args.slice(1);
    return folderCommand(json, me, `/automations/${automation.id}`, action, rest);
  }
  return false;
}

async function main(args: string[]): Promise<void> {
  const json = args[0] === "--json";
  const option = taskOption(json ? args.slice(1) : args);
  const [group, command, ...rest] = option.rest;
  if (group === undefined || group === "help" || group === "--help" || group === "-h") {
    console.log(USAGE);
    return;
  }
  const me = await whoami();
  const ownTask = option.task ?? me.task?.id ?? null;
  // SESSION-5: a run of an automation belongs to no task; task commands then name one.
  const taskId = (): string => {
    if (ownTask === null) throw new CliError("this session is a run of an automation and belongs to no task: name one with --task ID (am task search finds it)");
    return ownTask;
  };

  if (group === "whoami") {
    print(json, me, () => [
      `project ${me.project.name}`,
      me.task !== null
        ? `task    ${me.task.title} (${me.task.id}, ${me.task.state})`
        : `automation ${me.automation?.name ?? "unknown"} (${me.automation?.id ?? "unknown"}), run ${runShortId(me.session.id)}`,
      `session ${me.session.id}`,
      `branch  ${me.session.branch ?? "none"}`,
    ].join("\n"));
    return;
  }

  if (group === "task" && command === "show" && rest.length === 0) {
    const detail = await call("GET", `/tasks/${taskId()}`);
    const { task, topics, sessions } = taskDetailOf(detail);
    const people = peopleOf(await call("GET", "/people"));
    const assignee = task.assigneeId === null ? "nobody" : people.find((person) => person.id === task.assigneeId)?.name ?? "someone no longer in the store";
    print(json, detail, () => [
      `task ${task.title} (${task.id})`,
      `state  ${task.state}`,
      `assignee ${assignee}`,
      `branch ${task.branch ?? "none"}`,
      `topics ${topics.map((topic) => topic.name).join(", ") || "none"}`,
      "",
      "description:",
      task.description.trimEnd() || "(none)",
      "",
      `status (revision ${task.statusRevision}):`,
      task.status.trimEnd() || "(none yet)",
      "",
      "sessions:",
      ...(sessions.length === 0 ? ["(none)"] : sessions.map((session) => [
        session.id,
        session.endedAt === null ? "running" : `ended ${new Date(session.endedAt).toISOString()}`,
        `started ${new Date(session.startedAt).toISOString()}${session.machine === null ? "" : ` on ${session.machine}`}`,
        runsIn(session),
      ].join("\t"))),
    ].join("\n"));
    return;
  }
  if (group === "task" && command === "status" && rest.length === 0) {
    const { task } = taskDetailOf(await call("GET", `/tasks/${taskId()}`));
    print(json, task, () => `# revision ${task.statusRevision}\n${task.status}`.trimEnd());
    return;
  }
  if (group === "task" && command === "set-status" && rest.length === 2 && rest[0] === "--base") {
    const baseRevision = revisionOf(rest[1]);
    const status = readFileSync(0, "utf8");
    const updated = taskOf(await call("PUT", `/tasks/${taskId()}/status`, { status, baseRevision }));
    print(json, updated, () => `the task's status is now revision ${updated.statusRevision}`);
    return;
  }
  if (group === "task" && command === "set-state" && rest.length === 1) {
    const updated = taskOf(await call("PATCH", `/tasks/${taskId()}`, { state: rest[0] }));
    print(json, updated, () => `the task is now ${updated.state}`);
    return;
  }
  if (group === "task" && command === "set-title" && rest.length === 1) {
    const updated = taskOf(await call("PATCH", `/tasks/${taskId()}`, { title: rest[0] }));
    print(json, updated, () => `the task is now titled "${updated.title}"`);
    return;
  }
  if (group === "task" && command === "set-description" && rest.length === 0) {
    const updated = taskOf(await call("PATCH", `/tasks/${taskId()}`, { description: readFileSync(0, "utf8") }));
    print(json, updated, () => "the task's description is replaced");
    return;
  }
  if (group === "task" && command === "assign" && rest.length === 1) {
    const people = peopleOf(await call("GET", "/people"));
    const assigneeId = assigneeOf(people, rest[0]);
    const updated = taskOf(await call("PATCH", `/tasks/${taskId()}`, { assigneeId }));
    const name = people.find((person) => person.id === updated.assigneeId)?.name;
    print(json, updated, () => name === undefined ? "the task is assigned to nobody" : `the task is assigned to ${name}`);
    return;
  }
  if (group === "task" && command === "history" && rest.length === 0) {
    const listed = await call("GET", `/tasks/${taskId()}/history`);
    const history = listOf(listed, "a task's history", historyEntryOf);
    const [people, comments] = await Promise.all([
      call("GET", "/people").then(peopleOf),
      call("GET", `/tasks/${taskId()}/comments`).then((value) => listOf(value, "a comment list", commentOf)),
    ]);
    print(json, listed, () => history.map((entry) => [
      new Date(entry.at).toISOString(),
      actorName(entry.actor, people, me),
      describe(entry, people, comments),
    ].join("\t")).join("\n") || "no history");
    return;
  }
  if (group === "task" && command === "changes" && rest.length === 0) {
    const answered = await call("GET", `/tasks/${taskId()}/changes`);
    const { branch, baseRef, committed, uncommitted, pullRequests, overlaps } = changesOf(answered);
    const indent = (lines: string[]) => lines.map((line) => `  ${line}`);
    print(json, answered, () => {
      if (branch === null) return "the task has no branch yet; its first session creates it";
      const lines = [`branch ${branch}${baseRef === null ? "" : ` against ${baseRef}`}`, "", "committed on the branch:"];
      if (committed === null) lines.push("  the branch cannot be read here");
      else if (committed.files.length === 0) lines.push("  the branch has no changes against the default branch");
      else lines.push(...indent(committed.commits), ...indent(committed.files.map((file) => `${file.status}\t${file.path}`)));
      lines.push("", "uncommitted:");
      if (uncommitted === null) lines.push("  no session is running; an ended session's uncommitted files wait for the next one");
      else lines.push(...(uncommitted.length === 0 ? ["  no uncommitted files"] : indent(uncommitted)));
      lines.push("", "pull requests:");
      if (pullRequests === null) lines.push("  pull requests unavailable");
      else lines.push(...(pullRequests.length === 0 ? ["  no open pull requests"] : indent(pullRequests.map((pr) => `#${pr.number} ${pr.title}\t${pr.url}`))));
      if (overlaps.length > 0) {
        lines.push("", "same files changed in:", ...indent(overlaps.map((overlap) => `${overlap.title} (${overlap.taskId}): ${overlap.files.join(", ")}`)));
      }
      return lines.join("\n");
    });
    return;
  }
  if (group === "task" && command === "create" && rest.length === 1) {
    const description = process.stdin.isTTY ? "" : readFileSync(0, "utf8");
    const created = taskOf(await call("POST", `/projects/${me.project.id}/tasks`, { title: rest[0], description }));
    print(json, created, () => `created task "${created.title}" (${created.id})`);
    return;
  }
  if (group === "task" && command === "search") {
    const found = await call("GET", `/projects/${me.project.id}/tasks?q=${encodeURIComponent(rest.join(" "))}`);
    const tasks = summariesOf(found).map((summary) => summary.task);
    print(json, found, () => tasks.map((task) => `${task.id} ${task.state.padEnd(11)} ${task.title}`).join("\n") || "no tasks found");
    return;
  }

  // BOARD-1, BOARD-2, CARD-1: the board's columns; tasks whose session waits on a person first.
  if (group === "board" && command === undefined) {
    const [listed, cardsAnswer, peopleAnswer] = await Promise.all([
      call("GET", `/projects/${me.project.id}/tasks`),
      call("GET", `/projects/${me.project.id}/cards`),
      call("GET", "/people"),
    ]);
    const tasks = summariesOf(listed);
    const cards = new Map(cardsOf(cardsAnswer).map((card) => [card.session.id, card]));
    const people = peopleOf(peopleAnswer);
    const cardOf = (summary: Summary) => (summary.sessionId === null ? undefined : cards.get(summary.sessionId));
    const waiting = (summary: Summary) => (cardOf(summary)?.turn === "blocked" ? 0 : 1);
    const columns = BOARD_COLUMNS.map((state) => ({
      state,
      tasks: tasks.filter((summary) => summary.task.state === state)
        .toSorted((a, b) => waiting(a) - waiting(b) || a.task.createdAt - b.task.createdAt),
    }));
    const sessionText = (summary: Summary) => {
      const card = cardOf(summary);
      if (card === undefined) return summary.sessionId === null ? "no session" : "starting";
      const where = [card.session.machine === null ? "" : ` on ${card.session.machine}`, card.session.runtime === "host" ? ` (${runsIn(card.session)})` : ""].join("");
      const overlaps = card.overlaps.length === 0 ? "" : `; same files changed in ${card.overlaps.join(", ")}`;
      return `${LIGHT_LABEL[card.turn]}${where}${overlaps}`;
    };
    print(json, { columns, cards: [...cards.values()], people }, () => columns.map((column) => {
      const needs = column.tasks.filter((summary) => waiting(summary) === 0).length;
      return [
        `${STATE_LABEL[column.state]} (${column.tasks.length}${needs === 0 ? "" : `, ${needs} waiting on a person`})`,
        ...column.tasks.map((summary) => [
          `  ${summary.task.id}`,
          summary.task.title,
          summary.topics.map((topic) => topic.name).join(", ") || "no topics",
          summary.task.assigneeId === null ? "nobody" : people.find((person) => person.id === summary.task.assigneeId)?.name ?? "someone no longer in the store",
          sessionText(summary),
        ].join("\t")),
      ].join("\n");
    }).join("\n"));
    return;
  }

  if (group === "check" && command === undefined) {
    const found = checkWorktree(me);
    const clean = found.uncommitted.length === 0 && found.secrets.length === 0 && found.unpushed.length === 0;
    print(json, { clean, ...found }, () => {
      if (clean) return "clean: everything is committed and pushed";
      const lines: string[] = [];
      if (found.uncommitted.length > 0) {
        lines.push(`uncommitted files (${found.uncommitted.length}): commit what belongs to the task, delete or ignore the rest`);
        lines.push(...found.uncommitted.map((path) => `  ${path}`));
      }
      if (found.secrets.length > 0) {
        lines.push(`untracked files that look like secrets (${found.secrets.length}): add them to .gitignore, never commit them`);
        lines.push(...found.secrets.map((path) => `  ${path}`));
      }
      if (found.unpushed.length > 0) {
        lines.push(`unpushed commits (${found.unpushed.length}): push the branch`);
        lines.push(...found.unpushed.map((commit) => `  ${commit}`));
      }
      return lines.join("\n");
    });
    if (!clean) process.exitCode = 1;
    return;
  }

  if (group === "topic" && command === "list") {
    const topics = await call("GET", `/projects/${me.project.id}/topics`);
    print(json, topics, () => topicNames(topicsOf(topics)));
    return;
  }
  if (group === "topic" && command === "create" && rest.length === 1) {
    const created = await call("POST", `/projects/${me.project.id}/topics`, { name: rest[0] });
    const [topic] = topicsOf([created]);
    print(json, created, () => `created topic "${topic.name}"`);
    return;
  }
  if (group === "topic" && command === "show" && rest.length === 1) {
    const topic = await topicByName(me, rest[0]);
    const [detail, listed] = await Promise.all([call("GET", `/topics/${topic.id}`), call("GET", `/projects/${me.project.id}/tasks`)]);
    const tasks = summariesOf(listed).map((summary) => summary.task);
    const links = isRecord(detail) ? listOf(detail.tasks, "a topic's tasks", (link) => {
      if (!isRecord(link) || typeof link.taskId !== "string") throw unexpected("a topic's task");
      return link.taskId;
    }) : [];
    print(json, detail, () => [
      `topic ${topic.name} (revision ${topic.statusRevision})`,
      topic.status === "" ? "(no status yet)" : topic.status.trimEnd(),
      "",
      "tasks:",
      ...(links.length === 0 ? ["(none)"] : links.map((id) => {
        const task = tasks.find((candidate) => candidate.id === id);
        return task === undefined ? `  ${id}` : `  ${id} ${task.state.padEnd(11)} ${task.title}`;
      })),
    ].join("\n"));
    return;
  }
  if (group === "topic" && command === "status" && rest.length === 1) {
    const topic = await topicByName(me, rest[0]);
    print(json, topic, () => `# revision ${topic.statusRevision}\n${topic.status}`.trimEnd());
    return;
  }
  if (group === "topic" && command === "set-status" && rest.length === 3 && rest[1] === "--base") {
    const base = revisionOf(rest[2]);
    const topic = await topicByName(me, rest[0]);
    const status = readFileSync(0, "utf8");
    const written = await call("PUT", `/topics/${topic.id}/status`, { status, baseRevision: base });
    const [updated] = topicsOf([written]);
    print(json, written, () => `status of "${updated.name}" is now revision ${updated.statusRevision}`);
    return;
  }
  if (group === "topic" && (command === "link" || command === "unlink") && rest.length > 0) {
    let topics: Topic[] = [];
    for (const name of rest) {
      const topic = await topicByName(me, name);
      topics = topicsOf(await call(command === "link" ? "PUT" : "DELETE", `/tasks/${taskId()}/topics/${topic.id}`));
    }
    print(json, topics, () => `task topics:\n${topicNames(topics)}`);
    return;
  }

  if (group === "session" && command === "show" && rest.length <= 1) {
    const detail = await call("GET", `/sessions/${rest[0] ?? me.session.id}`);
    const session = sessionOf(isRecord(detail) ? detail.session : undefined);
    const task = isRecord(detail) && detail.task !== null ? taskOf(detail.task) : null;
    const automation = isRecord(detail) && detail.automation !== null ? automationOf(detail.automation) : null;
    const card = session.endedAt === null
      ? cardsOf(await call("GET", `/projects/${session.projectId}/cards`)).find((candidate) => candidate.session.id === session.id)
      : undefined;
    print(json, { ...(isRecord(detail) ? detail : {}), card: card ?? null }, () => [
      `session ${session.id}`,
      task !== null ? `task ${task.title} (${task.id}, ${task.state})` : `automation ${automation?.name ?? "unknown"} (${automation?.id ?? "unknown"}), run ${runShortId(session.id)}`,
      `branch ${session.branch ?? "none"}`,
      `machine ${session.machine ?? "unknown"} (${runsIn(session)})`,
      session.endedAt === null ? `running${card === undefined ? "" : `: ${LIGHT_LABEL[card.turn]}`}` : `ended ${new Date(session.endedAt).toISOString()}`,
      ...(card === undefined ? [] : [`cloudflare ${cloudflareLine(card.cloudflare)}`]),
    ].join("\n"));
    return;
  }

  if (group === "folder") {
    // FOLDER-1, AUTO-1: the task's folder, or for a run its automation's.
    const base = ownTask !== null ? `/tasks/${ownTask}` : me.automation !== null ? `/automations/${me.automation.id}` : null;
    if (base === null) throw new CliError("this session has no folder");
    if (await folderCommand(json, me, base, command, rest)) return;
  }

  if (group === "automation" && await automationCommand(json, me, command, rest)) return;

  if (group === "comments" && command === undefined) {
    const listed = await call("GET", `/tasks/${taskId()}/comments`);
    const comments = listOf(listed, "a comment list", commentOf);
    const people = peopleOf(await call("GET", "/people"));
    print(json, listed, () => comments.length === 0 ? "no comments" : comments.map((comment) => [
      `comment ${comment.id} by ${actorName(comment.author, people, me)}, ${new Date(comment.createdAt).toISOString()}${comment.editedAt === null ? "" : " (edited)"}`,
      comment.body.trimEnd(),
    ].join("\n")).join("\n\n"));
    return;
  }
  if (group === "comment" && command === undefined) {
    const created = commentOf(await call("POST", `/tasks/${taskId()}/comments`, { body: readFileSync(0, "utf8") }));
    print(json, created, () => `commented on the task (comment ${created.id})`);
    return;
  }
  if (group === "comment" && command === "edit" && rest.length === 1) {
    const updated = commentOf(await call("PATCH", `/comments/${rest[0]}`, { body: readFileSync(0, "utf8") }));
    print(json, updated, () => `comment ${updated.id} is edited`);
    return;
  }
  if (group === "comment" && command === "delete" && rest.length === 1) {
    const deleted = commentOf(await call("DELETE", `/comments/${rest[0]}`));
    print(json, deleted, () => `comment ${deleted.id} is deleted`);
    return;
  }

  if (group === "people" && command === undefined) {
    const listed = await call("GET", "/people");
    const people = peopleOf(listed);
    print(json, listed, () => people.map((person) => [
      `${person.id} ${person.name}`,
      person.email === null ? "" : ` <${person.email}>`,
      person.owner ? " (owner)" : "",
    ].join("")).join("\n"));
    return;
  }

  if (group === "project" && command === "show" && rest.length === 0) {
    // An agent's store routes see its own project only.
    const listed = listOf(await call("GET", "/projects"), "a project list", projectOf);
    const project = listed.find((candidate) => candidate.id === me.project.id);
    if (project === undefined) throw unexpected("this session's project");
    print(json, project, () => [
      `project ${project.name} (${project.id})`,
      `repository ${project.repoPath ?? "none"}`,
      `host sessions ${project.hostSessions ? "allowed" : "not allowed"}`,
      cloudflareTokensLine(project),
    ].join("\n"));
    return;
  }

  throw new CliError(`unknown command: ${[group, command, ...rest].filter(Boolean).join(" ")}\n\n${USAGE}`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`am: ${error instanceof CliError ? error.message : String(error)}`);
  process.exitCode = 1;
});
