import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import type { Automation, Card, EndedSession, HistoryEntry, TaskDetail, TaskSummary, Work } from "../../shared/api.ts";
import { email } from "../config.ts";
import { schedule } from "../scheduler/cron.ts";
import { folderPath } from "./bundle.ts";
import type { Folders } from "./folders.ts";
import type { ProjectMoves } from "./move.ts";
import { StoreError, type FolderOwner, type Principal, type Session, type Store, type Task } from "./store.ts";

/** What a store route can touch: the database plus the session lifecycle owned by the gateway. */
export interface StoreContext {
  store: Store;
  /** FOLDER-1..3, AUTO-1: every task's and automation's folder, files outside git. */
  folders: Folders;
  /** STORE-6: moving a project to another store, from either end. */
  moves: ProjectMoves;
  /** Records a session of the task and launches its worktree and container; undone if the launch fails. */
  startSession(principal: Principal, taskId: string, input: SessionInput): Promise<Session>;
  /** AUTO-9: "run now": records a run of the automation and launches it on its own branch; undone if the launch fails. */
  startRun(principal: Principal | null, automationId: string, input: RunInput): Promise<Session>;
  /** AUTO-11: a session on the automation that is no run, optionally from a run: its branch and its outputs. */
  startAutomationSession(principal: Principal, automationId: string, input: AutomationSessionInput): Promise<Session>;
  /** AUTO-10: a run's agent, or a person, says how the run went; all but review end it once its agent's turn ends. */
  endRun(principal: Principal, runId: string, input: RunEndInput): Promise<Session>;
  /** AUTO-12: a task that takes over the run's branch, with the run's outputs copied into its folder. */
  taskFromRun(principal: Principal, runId: string, input: RunTaskInput): Promise<TaskDetail>;
  /** Deletes an automation with its runs' records and chats, and its folder. */
  deleteAutomation(principal: Principal, automationId: string): Automation;
  /** Ends the session and removes its workspace; its uncommitted work becomes the task's snapshot. */
  endSession(principal: Principal, sessionId: string): Promise<EndedSession>;
  /** Ends the task's session and deletes its branch; commits no remote has need `confirm`. */
  finishTask(principal: Principal, taskId: string, state: "done" | "cancelled", confirm: boolean): Promise<Task>;
  /** Running sessions of a project with their live, git, and transcript state. */
  cards(principal: Principal, projectId: string): Promise<Card[]>;
  /** TASK-14: the task's history, with the pull requests of its branch GitHub knows of. */
  taskHistory(principal: Principal, taskId: string): Promise<HistoryEntry[]>;
  /** BOARD-1, CARD-6: the project's tasks, each unfinished one with its board badge. */
  listTasks(principal: Principal, projectId: string, search: string): Promise<TaskSummary[]>;
  /** CARD-3, CARD-4: a task's Work section: its branch's state, commits, files, pull requests, and overlapping tasks. */
  taskWork(principal: Principal, taskId: string): Promise<Work>;
  /** AUTO-16: a run's Work section, as a task's. */
  runWork(principal: Principal, runId: string): Promise<Work>;
  /** DEPLOY-1, AUTO-16: sends the agent of a task, or of a run waiting for review, the deploy instruction; a task's session starts if it has none. */
  deploy(principal: Principal, target: { kind: "task" | "run"; id: string }): Promise<Session>;
  /** CLOUDFLARE-2: humans only; allows the session's Cloudflare writes for 10 minutes from now. */
  allowCloudflareWrites(principal: Principal, sessionId: string): { writesUntil: number };
  revokeCloudflareWrites(principal: Principal, sessionId: string): { writesUntil: null };
}

/** Prefix shared by the human gateway route and every agent socket. */
export const STORE_API_PREFIX = "/api/store";

const name = z.string().trim().min(1).max(200);
const description = z.string().max(64 * 1024);
// Strict objects: unknown fields are rejected, e.g. a topic `parent` (TOPIC-1).
const nameBody = z.strictObject({ name });
const personBody = z.strictObject({ name, email });
const repoPath = z.string().startsWith("/");
const projectBody = z.strictObject({ name, repoPath: repoPath.optional(), hostSessions: z.boolean().optional() });
// The project settings page; null takes the repository away.
const projectUpdateBody = z.strictObject({ name: name.optional(), repoPath: repoPath.nullable().optional(), hostSessions: z.boolean().optional() });
// CLOUDFLARE-3: both tokens at once; without a write token the project's agents only read.
const cloudflareToken = z.string().trim().min(1).max(1024);
const cloudflareTokensBody = z.strictObject({ read: cloudflareToken, write: cloudflareToken.optional() });
const taskBody = z.strictObject({ title: name, description: description.optional() });
// Finishing a task has its own route (TASK-9).
const taskUpdateBody = z.strictObject({
  title: name.optional(),
  description: description.optional(),
  state: z.enum(["open", "in_progress", "in_review"]).optional(),
  assigneeId: z.uuid().nullable().optional(),
});
const finishBody = z.strictObject({ state: z.enum(["done", "cancelled"]), confirm: z.boolean().optional() });
const sessionBody = z.strictObject({
  model: z.string().min(1).optional(),
  runtime: z.enum(["container", "host"]).optional(),
  // HOST-6: the main checkout instead of a worktree.
  checkout: z.boolean().optional(),
});
export type SessionInput = z.infer<typeof sessionBody>;
// AUTO-9: "run now"; HOST-1: on the host only where the project allows it, for its owner.
const runBody = z.strictObject({ runtime: z.enum(["container", "host"]).optional() });
export type RunInput = z.infer<typeof runBody> & {
  /** AUTO-13: what the trigger's firing found, as the run's prompt shows it; the scheduler's, never a request's. */
  triggerContext?: string;
};
// AUTO-11: a session on an automation that is no run; `fromRun` goes on from a run's branch and outputs.
const automationSessionBody = z.strictObject({
  model: z.string().min(1).optional(),
  runtime: z.enum(["container", "host"]).optional(),
  fromRun: z.uuid().optional(),
});
export type AutomationSessionInput = z.infer<typeof automationSessionBody>;
// AUTO-10: how a run went, as its agent says it; a failed run says why.
const runEndBody = z.strictObject({
  outcome: z.enum(["finished", "nothing_to_deploy", "review", "failed"]),
  reason: z.string().trim().min(1).max(4000).optional(),
}).refine((input) => input.outcome !== "failed" || input.reason !== undefined, { message: "a failed run says why (reason)", path: ["reason"] });
export type RunEndInput = z.infer<typeof runEndBody>;
// AUTO-12: the task's title and description; by default they name the run.
const runTaskBody = z.strictObject({ title: name.optional(), description: description.optional() });
export type RunTaskInput = z.infer<typeof runTaskBody>;
// AUTO-1: a slug names the automation's runs' branches, `am/<slug>-<run>` (AUTO-9).
const slug = z.string().max(40).regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/, "a slug is lowercase letters and digits, joined by single dots or dashes");
const automationFields = {
  slug: slug.optional(),
  instructions: description.optional(),
  // Null: omp's default model.
  model: z.string().trim().min(1).nullable().optional(),
  endMode: z.enum(["finish", "review"]).optional(),
  timeLimitMinutes: z.int().min(1).max(24 * 60).optional(),
  enabled: z.boolean().optional(),
};
const automationBody = z.strictObject({ name, ...automationFields });
const automationUpdateBody = z.strictObject({ name: name.optional(), ...automationFields });
// AUTO-2: five cron fields, as the scheduler reads them.
const cron = z.string().trim().superRefine((value, context) => {
  try {
    schedule(value, "UTC");
  } catch (cause) {
    context.addIssue({ code: "custom", message: `not a cron schedule (minute hour day month weekday): ${cause instanceof Error ? cause.message : String(cause)}` });
  }
});
const timezone = z.string().refine((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, "not a time zone (an IANA name such as Europe/Budapest)");
// AUTO-8: a guard or check is a file of the automation's folder; null removes it.
const triggerFields = { timezone: timezone.optional(), guardPath: folderPath.nullable().optional(), checkPath: folderPath.nullable().optional() };
const triggerBody = z.strictObject({ cron, ...triggerFields });
const triggerUpdateBody = z.strictObject({ cron: cron.optional(), ...triggerFields });
const statusBody = z.strictObject({ status: z.string().max(64 * 1024), baseRevision: z.int().min(0) });
const commentBody = z.strictObject({ body: z.string().trim().min(1).max(64 * 1024) });
// STORE-6: `confirm` leaves behind the work a move cannot take along (MoveLeftBehind).
const exportBody = z.strictObject({ confirm: z.boolean().optional() });
const importBody = z.strictObject({ repoPath: z.string().startsWith("/").optional() });
const movedBody = z.strictObject({ digest: z.string().regex(/^[0-9a-f]{64}$/) });
const offsetQuery = z.string().regex(/^\d+$/, "offset must be a byte count").transform(Number);

/** A route's answer that is a file's bytes instead of JSON. */
export class FileResponse {
  readonly status: number;
  readonly headers: OutgoingHttpHeaders;
  readonly body: Readable;

  constructor(status: number, headers: OutgoingHttpHeaders, body: Readable) {
    this.status = status;
    this.headers = headers;
    this.body = body;
  }
}

/**
 * `body` reads the request as JSON; `request` is there for the routes that stream it (FOLDER-1)
 * or read its headers; `query` is the request URL's search parameters, e.g. a task search's words.
 */
type Handler = (
  c: StoreContext,
  principal: Principal,
  params: string[],
  body: () => Promise<unknown>,
  request: IncomingMessage,
  query: URLSearchParams,
) => unknown;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

const id = "([0-9a-f-]{36})";

/** FOLDER-1, FOLDER-2, AUTO-1: a task's and an automation's folder answer the same routes, under `/tasks/<id>` and `/automations/<id>`. */
function folderRoutes(kind: FolderOwner["kind"]): Route[] {
  const base = `^/${kind}s/${id}/folder`;
  const owner = (ownerId: string): FolderOwner => ({ kind, id: ownerId });
  return [
    { method: "GET", pattern: new RegExp(`${base}$`), handler: (c, p, [ownerId]) => c.folders.list(p, owner(ownerId)) },
    // AUTO-7: `?path=<folder>` zips that subfolder only, e.g. a run's outputs `runs/<run>`.
    {
      method: "GET",
      pattern: new RegExp(`${base}\\.zip$`),
      handler: (c, p, [ownerId], _, __, query) => c.folders.zip(p, owner(ownerId), query.has("path") ? folderPath.parse(query.get("path")) : null),
    },
    {
      method: "GET",
      pattern: new RegExp(`${base}/(.+)$`),
      // `?download` asks for an attachment instead of the file shown inline.
      handler: (c, p, [ownerId, path], _, request, query) => c.folders.download(p, owner(ownerId), path, request.headers.range, query.has("download")),
    },
    // The body is the file's bytes, streamed into the folder: no JSON and no JSON size limit.
    { method: "PUT", pattern: new RegExp(`${base}/(.+)$`), handler: (c, p, [ownerId, path], _, request) => c.folders.upload(p, owner(ownerId), path, request) },
    { method: "DELETE", pattern: new RegExp(`${base}/(.+)$`), handler: (c, p, [ownerId, path]) => c.folders.remove(p, owner(ownerId), path) },
  ];
}

const routes: Route[] = [
  { method: "GET", pattern: /^\/me$/, handler: (c, p) => c.store.whoami(p) },
  { method: "GET", pattern: /^\/people$/, handler: (c, p) => c.store.listPeople(p) },
  { method: "POST", pattern: /^\/people$/, handler: async (c, p, _, body) => c.store.createPerson(p, personBody.parse(await body())) },
  {
    method: "PATCH",
    pattern: new RegExp(`^/people/${id}$`),
    handler: async (c, p, [personId], body) => c.store.updatePerson(p, personId, nameBody.parse(await body())),
  },
  { method: "GET", pattern: /^\/projects$/, handler: (c, p) => c.store.listProjects(p) },
  {
    method: "POST",
    pattern: /^\/projects$/,
    handler: async (c, p, _, body) => c.store.createProject(p, projectBody.parse(await body())),
  },
  {
    method: "PATCH",
    pattern: new RegExp(`^/projects/${id}$`),
    handler: async (c, p, [projectId], body) => c.store.updateProject(p, projectId, projectUpdateBody.parse(await body())),
  },
  // CLOUDFLARE-3: the owner sets or removes the project's Cloudflare tokens; no route answers with them.
  {
    method: "PUT",
    pattern: new RegExp(`^/projects/${id}/cloudflare$`),
    handler: async (c, p, [projectId], body) => {
      const input = cloudflareTokensBody.parse(await body());
      return c.store.setCloudflareTokens(p, projectId, { read: input.read, write: input.write ?? null });
    },
  },
  {
    method: "DELETE",
    pattern: new RegExp(`^/projects/${id}/cloudflare$`),
    handler: (c, p, [projectId]) => c.store.removeCloudflareTokens(p, projectId),
  },
  // STORE-6: the source exports a bundle, the target receives it in parts and imports it, and the source deletes the project.
  {
    method: "POST",
    pattern: new RegExp(`^/projects/${id}/export$`),
    handler: async (c, p, [projectId], body) => c.moves.export(p, projectId, exportBody.parse(await body()).confirm === true),
  },
  {
    method: "PUT",
    pattern: new RegExp(`^/imports/${id}$`),
    // The body is a part of the bundle's bytes, streamed: no JSON and no JSON size limit.
    handler: (c, p, [uploadId], _, request, query) => c.moves.receive(p, uploadId, offsetQuery.parse(query.get("offset")), request),
  },
  {
    method: "POST",
    pattern: new RegExp(`^/imports/${id}$`),
    handler: async (c, p, [uploadId], body) => c.moves.import(p, uploadId, importBody.parse(await body()).repoPath ?? null),
  },
  {
    method: "POST",
    pattern: new RegExp(`^/projects/${id}/moved$`),
    handler: async (c, p, [projectId], body) => c.moves.deleteMoved(p, projectId, movedBody.parse(await body()).digest),
  },
  { method: "GET", pattern: new RegExp(`^/projects/${id}/topics$`), handler: (c, p, [projectId]) => c.store.listTopics(p, projectId) },
  {
    method: "POST",
    pattern: new RegExp(`^/projects/${id}/topics$`),
    handler: async (c, p, [projectId], body) => c.store.createTopic(p, projectId, nameBody.parse(await body()).name),
  },
  { method: "GET", pattern: new RegExp(`^/topics/${id}$`), handler: (c, p, [topicId]) => c.store.getTopic(p, topicId) },
  {
    method: "PUT",
    pattern: new RegExp(`^/topics/${id}/status$`),
    handler: async (c, p, [topicId], body) => {
      const input = statusBody.parse(await body());
      return c.store.writeTopicStatus(p, topicId, input.status, input.baseRevision);
    },
  },
  {
    method: "GET",
    pattern: new RegExp(`^/projects/${id}/sessions$`),
    handler: (c, p, [projectId]) => c.store.listSessions(p, projectId),
  },
  {
    method: "GET",
    pattern: new RegExp(`^/projects/${id}/cards$`),
    handler: (c, p, [projectId]) => c.cards(p, projectId),
  },
  // BOARD-3: `?q=` finds tasks by their words; without it every task is listed.
  {
    method: "GET",
    pattern: new RegExp(`^/projects/${id}/tasks$`),
    handler: (c, p, [projectId], _, __, query) => c.listTasks(p, projectId, query.get("q") ?? ""),
  },
  {
    method: "POST",
    pattern: new RegExp(`^/projects/${id}/tasks$`),
    handler: async (c, p, [projectId], body) => c.store.createTask(p, projectId, taskBody.parse(await body())),
  },
  { method: "GET", pattern: new RegExp(`^/tasks/${id}$`), handler: (c, p, [taskId]) => c.store.getTask(p, taskId) },
  {
    method: "PATCH",
    pattern: new RegExp(`^/tasks/${id}$`),
    handler: async (c, p, [taskId], body) => c.store.updateTask(p, taskId, taskUpdateBody.parse(await body())),
  },
  {
    method: "GET",
    pattern: new RegExp(`^/tasks/${id}/history$`),
    // Files an agent wrote into the folder are history too (FOLDER-3).
    handler: (c, p, [taskId]) => {
      c.folders.list(p, { kind: "task", id: taskId });
      return c.taskHistory(p, taskId);
    },
  },
  { method: "GET", pattern: new RegExp(`^/tasks/${id}/changes$`), handler: (c, p, [taskId]) => c.taskWork(p, taskId) },
  { method: "POST", pattern: new RegExp(`^/tasks/${id}/deploy$`), handler: (c, p, [taskId]) => c.deploy(p, { kind: "task", id: taskId }) },
  { method: "GET", pattern: new RegExp(`^/tasks/${id}/comments$`), handler: (c, p, [taskId]) => c.store.listComments(p, taskId) },
  {
    method: "POST",
    pattern: new RegExp(`^/tasks/${id}/comments$`),
    handler: async (c, p, [taskId], body) => c.store.createComment(p, taskId, commentBody.parse(await body()).body),
  },
  {
    method: "PATCH",
    pattern: new RegExp(`^/comments/${id}$`),
    handler: async (c, p, [commentId], body) => c.store.updateComment(p, commentId, commentBody.parse(await body()).body),
  },
  { method: "DELETE", pattern: new RegExp(`^/comments/${id}$`), handler: (c, p, [commentId]) => c.store.deleteComment(p, commentId) },
  ...folderRoutes("task"),
  // AUTO-1, AUTO-15: a project's automations, for people and agents alike.
  {
    method: "GET",
    pattern: new RegExp(`^/projects/${id}/automations$`),
    handler: (c, p, [projectId]) => c.store.listAutomations(p, projectId),
  },
  {
    method: "POST",
    pattern: new RegExp(`^/projects/${id}/automations$`),
    handler: async (c, p, [projectId], body) => c.store.createAutomation(p, projectId, automationBody.parse(await body())),
  },
  { method: "GET", pattern: new RegExp(`^/automations/${id}$`), handler: (c, p, [automationId]) => c.store.getAutomation(p, automationId) },
  {
    method: "PATCH",
    pattern: new RegExp(`^/automations/${id}$`),
    handler: async (c, p, [automationId], body) => c.store.updateAutomation(p, automationId, automationUpdateBody.parse(await body())),
  },
  { method: "DELETE", pattern: new RegExp(`^/automations/${id}$`), handler: (c, p, [automationId]) => c.deleteAutomation(p, automationId) },
  {
    method: "POST",
    pattern: new RegExp(`^/automations/${id}/triggers$`),
    handler: async (c, p, [automationId], body) => c.store.addTrigger(p, automationId, triggerBody.parse(await body())),
  },
  {
    method: "PATCH",
    pattern: new RegExp(`^/triggers/${id}$`),
    handler: async (c, p, [triggerId], body) => c.store.updateTrigger(p, triggerId, triggerUpdateBody.parse(await body())),
  },
  { method: "DELETE", pattern: new RegExp(`^/triggers/${id}$`), handler: (c, p, [triggerId]) => c.store.removeTrigger(p, triggerId) },
  // AUTO-9: its runs, newest first; POST is "run now".
  { method: "GET", pattern: new RegExp(`^/automations/${id}/runs$`), handler: (c, p, [automationId]) => c.store.listRuns(p, automationId) },
  {
    method: "POST",
    pattern: new RegExp(`^/automations/${id}/runs$`),
    handler: async (c, p, [automationId], body) => c.startRun(p, automationId, runBody.parse(await body())),
  },
  { method: "GET", pattern: new RegExp(`^/automations/${id}/firings$`), handler: (c, p, [automationId]) => c.store.listFirings(p, automationId) },
  {
    method: "POST",
    pattern: new RegExp(`^/automations/${id}/sessions$`),
    handler: async (c, p, [automationId], body) => c.startAutomationSession(p, automationId, automationSessionBody.parse(await body())),
  },
  // AUTO-10, AUTO-12: a run is a session; these are what only runs have.
  { method: "POST", pattern: new RegExp(`^/runs/${id}/end$`), handler: async (c, p, [runId], body) => c.endRun(p, runId, runEndBody.parse(await body())) },
  { method: "POST", pattern: new RegExp(`^/runs/${id}/task$`), handler: async (c, p, [runId], body) => c.taskFromRun(p, runId, runTaskBody.parse(await body())) },
  { method: "GET", pattern: new RegExp(`^/runs/${id}/changes$`), handler: (c, p, [runId]) => c.runWork(p, runId) },
  { method: "POST", pattern: new RegExp(`^/runs/${id}/deploy$`), handler: (c, p, [runId]) => c.deploy(p, { kind: "run", id: runId }) },
  ...folderRoutes("automation"),
  {
    method: "POST",
    pattern: new RegExp(`^/tasks/${id}/finish$`),
    handler: async (c, p, [taskId], body) => {
      const input = finishBody.parse(await body());
      return c.finishTask(p, taskId, input.state, input.confirm === true);
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^/tasks/${id}/sessions$`),
    handler: async (c, p, [taskId], body) => c.startSession(p, taskId, sessionBody.parse(await body())),
  },
  {
    method: "PUT",
    pattern: new RegExp(`^/tasks/${id}/topics/${id}$`),
    handler: (c, p, [taskId, topicId]) => c.store.linkTopic(p, taskId, topicId),
  },
  {
    method: "DELETE",
    pattern: new RegExp(`^/tasks/${id}/topics/${id}$`),
    handler: (c, p, [taskId, topicId]) => c.store.unlinkTopic(p, taskId, topicId),
  },
  {
    method: "PUT",
    pattern: new RegExp(`^/tasks/${id}/status$`),
    handler: async (c, p, [taskId], body) => {
      const input = statusBody.parse(await body());
      return c.store.writeTaskStatus(p, taskId, input.status, input.baseRevision);
    },
  },
  { method: "POST", pattern: new RegExp(`^/sessions/${id}/end$`), handler: (c, p, [sessionId]) => c.endSession(p, sessionId) },
  { method: "GET", pattern: new RegExp(`^/sessions/${id}$`), handler: (c, p, [sessionId]) => c.store.getSession(p, sessionId) },
  {
    method: "POST",
    pattern: new RegExp(`^/sessions/${id}/cloudflare-writes$`),
    handler: (c, p, [sessionId]) => c.allowCloudflareWrites(p, sessionId),
  },
  {
    method: "DELETE",
    pattern: new RegExp(`^/sessions/${id}/cloudflare-writes$`),
    handler: (c, p, [sessionId]) => c.revokeCloudflareWrites(p, sessionId),
  },
];

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 128 * 1024) throw new StoreError(413, "request body is too large");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new StoreError(400, "request body is not JSON");
  }
}

/**
 * The one store API. Humans reach it through the gateway; agents through their
 * session socket. Both run these exact routes (STORE-5); only the principal differs.
 */
export async function handleStoreApi(
  request: IncomingMessage,
  response: ServerResponse,
  context: StoreContext,
  principal: Principal,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const pathname = url.pathname;
  const path = pathname.startsWith(STORE_API_PREFIX) ? pathname.slice(STORE_API_PREFIX.length) : null;
  const candidates = path === null ? [] : routes.filter((route) => route.pattern.test(path));
  const route = candidates.find((candidate) => candidate.method === request.method);
  if (path === null || route === undefined) {
    send(response, candidates.length > 0 ? 405 : 404, { ok: false, error: "unknown store endpoint" });
    return;
  }
  try {
    const params = route.pattern.exec(path)?.slice(1) ?? [];
    const data = await route.handler(context, principal, params, () => readBody(request), request, url.searchParams);
    if (data instanceof FileResponse) {
      response.writeHead(data.status, data.headers);
      // Once the head is out, a failed read can only cut the response short.
      await pipeline(data.body, response).catch(() => response.destroy());
      return;
    }
    send(response, 200, { ok: true, data });
  } catch (cause) {
    if (cause instanceof StoreError) {
      send(response, cause.status, { ok: false, error: cause.message, ...cause.details });
    } else if (cause instanceof z.ZodError) {
      send(response, 400, { ok: false, error: z.prettifyError(cause) });
    } else {
      console.error("store request failed", cause);
      send(response, 500, { ok: false, error: "internal error" });
    }
  }
}
