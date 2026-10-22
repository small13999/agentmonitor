import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { Card, EndedSession } from "../../shared/api.ts";
import { StoreError, type Principal, type Session, type Store, type Task } from "./store.ts";

/** What a store route can touch: the database plus the session lifecycle owned by the gateway. */
export interface StoreContext {
  store: Store;
  /** Records a session of the task and launches its worktree and container; undone if the launch fails. */
  startSession(principal: Principal, taskId: string, input: SessionInput): Promise<Session>;
  /** Ends the session and removes its workspace; its uncommitted work becomes the task's snapshot. */
  endSession(principal: Principal, sessionId: string): Promise<EndedSession>;
  /** Ends the task's session and deletes its branch; commits no remote has need `confirm`. */
  finishTask(principal: Principal, taskId: string, state: "done" | "cancelled", confirm: boolean): Promise<Task>;
  /** Running sessions of a project with their live, git, and transcript state. */
  cards(principal: Principal, projectId: string): Promise<Card[]>;
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
const projectBody = z.strictObject({ name, repoPath: z.string().startsWith("/").optional(), hostSessions: z.boolean().optional() });
const projectUpdateBody = z.strictObject({ hostSessions: z.boolean() });
const taskBody = z.strictObject({ title: name, description: description.optional() });
// Finishing a task has its own route (TASK-9).
const taskUpdateBody = z.strictObject({
  title: name.optional(),
  description: description.optional(),
  state: z.enum(["open", "in_progress", "in_review"]).optional(),
});
const finishBody = z.strictObject({ state: z.enum(["done", "cancelled"]), confirm: z.boolean().optional() });
const sessionBody = z.strictObject({
  model: z.string().min(1).optional(),
  runtime: z.enum(["container", "host"]).optional(),
  // HOST-6 and HOST-7: the main checkout instead of a worktree; one of the user's omp chats to go on with.
  checkout: z.boolean().optional(),
  resume: z.string().regex(/^[0-9a-f-]{8,36}$/).optional(),
});
export type SessionInput = z.infer<typeof sessionBody>;
const statusBody = z.strictObject({ status: z.string().max(64 * 1024), baseRevision: z.int().min(0) });
const notesBody = z.strictObject({ text: z.string().max(64 * 1024), baseRevision: z.int().min(0) });

type Handler = (c: StoreContext, principal: Principal, params: string[], body: () => Promise<unknown>) => unknown;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

const id = "([0-9a-f-]{36})";
const routes: Route[] = [
  { method: "GET", pattern: /^\/me$/, handler: (c, p) => c.store.whoami(p) },
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
  { method: "GET", pattern: new RegExp(`^/projects/${id}/tasks$`), handler: (c, p, [projectId]) => c.store.listTasks(p, projectId) },
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
  { method: "GET", pattern: new RegExp(`^/tasks/${id}/notes$`), handler: (c, p, [taskId]) => c.store.getNotes(p, taskId) },
  {
    method: "PUT",
    pattern: new RegExp(`^/tasks/${id}/notes$`),
    handler: async (c, p, [taskId], body) => {
      const input = notesBody.parse(await body());
      return c.store.writeNotes(p, taskId, input.text, input.baseRevision);
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
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const path = pathname.startsWith(STORE_API_PREFIX) ? pathname.slice(STORE_API_PREFIX.length) : null;
  const candidates = path === null ? [] : routes.filter((route) => route.pattern.test(path));
  const route = candidates.find((candidate) => candidate.method === request.method);
  if (path === null || route === undefined) {
    send(response, candidates.length > 0 ? 405 : 404, { ok: false, error: "unknown store endpoint" });
    return;
  }
  try {
    const params = route.pattern.exec(path)?.slice(1) ?? [];
    const data = await route.handler(context, principal, params, () => readBody(request));
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
