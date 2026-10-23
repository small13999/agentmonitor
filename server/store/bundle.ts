import { z } from "zod";
import type { Actor, Comment, FolderFile, HistoryEvent, Person, Project, Session, Task, Topic, TopicLink } from "../../shared/api.ts";
import type { CloudflareTokens } from "../cloudflare.ts";

const taskState = z.enum(["open", "in_progress", "in_review", "done", "cancelled"]);
/** TASK-14: a stored event's data, as recorded. */
export const historyEvent: z.ZodType<HistoryEvent> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("created") }),
  z.object({ kind: z.literal("state"), from: taskState, to: taskState }),
  z.object({ kind: z.literal("assignee"), personId: z.string().nullable() }),
  z.object({ kind: z.literal("topic"), topicId: z.string(), name: z.string(), linked: z.boolean() }),
  z.object({
    kind: z.literal("session"),
    sessionId: z.string(),
    event: z.enum(["started", "ended"]),
    machine: z.string().nullable(),
    runtime: z.enum(["container", "host"]),
  }),
  z.object({ kind: z.literal("comment"), commentId: z.string() }),
  z.object({ kind: z.literal("file"), path: z.string() }),
  z.object({ kind: z.literal("pull_request"), number: z.number(), title: z.string(), url: z.string() }),
]);

/** STORE-6: a file of a task's folder, as the store records it. */
export type MovedFolderFile = FolderFile & { taskId: string };

/** STORE-6: one entry of a task's history (TASK-14), in the order the store appended them. */
export interface MovedEvent {
  taskId: string;
  at: number;
  actor: Actor | null;
  event: HistoryEvent;
}

/** STORE-6: every record of one project, as `bundle.json` of a move's bundle holds them. */
export interface ProjectRecords {
  version: 2;
  project: Project;
  /** The store's owner and everyone the records name. */
  people: Person[];
  topics: Topic[];
  tasks: Task[];
  topicLinks: TopicLink[];
  sessions: Session[];
  comments: Comment[];
  folderFiles: MovedFolderFile[];
  events: MovedEvent[];
  /** CLOUDFLARE-3: the project's Cloudflare tokens; null when it has none. */
  cloudflareTokens: CloudflareTokens | null;
}

const id = z.uuid();
const actor: z.ZodType<Actor> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("person"), personId: id }),
  z.object({ kind: z.literal("agent"), sessionId: id }),
]);
// A folder path as the store records it (FOLDER-1): `/`-separated segments, none empty, `.` or `..`.
const folderPath = z.string().refine((path) => path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."), "not a folder path");

const person: z.ZodType<Person> = z.object({
  id,
  name: z.string(),
  email: z.string().nullable(),
  color: z.string(),
  owner: z.boolean(),
  createdAt: z.number(),
});
const project: z.ZodType<Project> = z.object({
  id,
  name: z.string().trim().min(1),
  repoPath: z.string().nullable(),
  hostSessions: z.boolean(),
  cloudflare: z.object({ read: z.boolean(), write: z.boolean() }),
  createdAt: z.number(),
});
const topic: z.ZodType<Topic> = z.object({
  id,
  projectId: id,
  name: z.string(),
  color: z.string(),
  createdAt: z.number(),
  status: z.string(),
  statusRevision: z.int().min(0),
});
const task: z.ZodType<Task> = z.object({
  id,
  projectId: id,
  title: z.string(),
  description: z.string(),
  state: taskState,
  assigneeId: id.nullable(),
  branch: z.string().nullable(),
  baseRef: z.string().nullable(),
  status: z.string(),
  statusRevision: z.int().min(0),
  createdAt: z.number(),
  updatedAt: z.number(),
});
const topicLink: z.ZodType<TopicLink> = z.object({ taskId: id, topicId: id, linkedAt: z.number() });
const session: z.ZodType<Session> = z.object({
  id,
  projectId: id,
  taskId: id,
  name: z.string(),
  branch: z.string().nullable(),
  baseRef: z.string().nullable(),
  machine: z.string().nullable(),
  runtime: z.enum(["container", "host"]),
  checkout: z.boolean(),
  model: z.string().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
});
const comment: z.ZodType<Comment> = z.object({
  id,
  taskId: id,
  author: actor,
  body: z.string(),
  createdAt: z.number(),
  editedAt: z.number().nullable(),
});
const folderFile: z.ZodType<MovedFolderFile> = z.object({
  taskId: id,
  path: folderPath,
  size: z.int().min(0),
  contentType: z.string(),
  addedBy: actor.nullable(),
  addedAt: z.number(),
  updatedAt: z.number(),
});
const movedEvent: z.ZodType<MovedEvent> = z.object({ taskId: id, at: z.number(), actor: actor.nullable(), event: historyEvent });
const token = z.string().min(1);
const cloudflareTokens: z.ZodType<CloudflareTokens> = z.object({ read: token, write: token.nullable() });

/**
 * STORE-6: a bundle's records, checked to be one project's: every record belongs to it, links
 * only to records of the bundle (STORE-2), and names only people the bundle holds. A moved
 * session has ended: a running one never leaves its store.
 */
export const projectRecords: z.ZodType<ProjectRecords> = z.object({
  version: z.literal(2),
  project,
  people: z.array(person),
  topics: z.array(topic),
  tasks: z.array(task),
  topicLinks: z.array(topicLink),
  sessions: z.array(session),
  comments: z.array(comment),
  folderFiles: z.array(folderFile),
  events: z.array(movedEvent),
  cloudflareTokens: cloudflareTokens.nullable(),
}).superRefine((records, context) => {
  const problem = (message: string) => context.addIssue({ code: "custom", message });
  const people = new Set(records.people.map((person) => person.id));
  const topics = new Set(records.topics.map((found) => found.id));
  const tasks = new Set(records.tasks.map((found) => found.id));
  const sessions = new Set(records.sessions.map((found) => found.id));
  for (const [kind, ids] of Object.entries({
    person: records.people.map((person) => person.id),
    topic: records.topics.map((found) => found.id),
    task: records.tasks.map((found) => found.id),
    session: records.sessions.map((found) => found.id),
    comment: records.comments.map((found) => found.id),
  })) {
    const twice = ids.find((value, index) => ids.indexOf(value) !== index);
    if (twice !== undefined) problem(`${kind} ${twice} is in the bundle twice`);
  }
  if (records.people.filter((person) => person.owner).length !== 1) problem("the bundle names no owner of its store, or more than one");
  for (const owned of [...records.topics, ...records.tasks, ...records.sessions]) {
    if (owned.projectId !== records.project.id) problem(`${owned.id} belongs to another project`);
  }
  const knownActor = (who: Actor | null) => who === null || (who.kind === "person" ? people.has(who.personId) : sessions.has(who.sessionId));
  for (const link of records.topicLinks) {
    if (!tasks.has(link.taskId) || !topics.has(link.topicId)) problem(`a topic link of task ${link.taskId} names a record not in the bundle`);
  }
  for (const found of records.tasks) {
    if (found.assigneeId !== null && !people.has(found.assigneeId)) problem(`task ${found.id} is assigned to a person not in the bundle`);
  }
  for (const found of records.sessions) {
    if (!tasks.has(found.taskId)) problem(`session ${found.id} belongs to a task not in the bundle`);
    if (found.endedAt === null) problem(`session ${found.name} (${found.id}) has not ended`);
  }
  for (const found of records.comments) {
    if (!tasks.has(found.taskId) || !knownActor(found.author)) problem(`comment ${found.id} names a record not in the bundle`);
  }
  for (const file of records.folderFiles) {
    if (!tasks.has(file.taskId) || !knownActor(file.addedBy)) problem(`folder file ${file.path} of task ${file.taskId} names a record not in the bundle`);
  }
  for (const entry of records.events) {
    const assignee = entry.event.kind === "assignee" ? entry.event.personId : null;
    if (!tasks.has(entry.taskId) || !knownActor(entry.actor) || (assignee !== null && !people.has(assignee))) {
      problem(`an event of task ${entry.taskId} names a record not in the bundle`);
    }
  }
});

/**
 * STORE-6: who each person of a moved project is in the store it moves to, by id; null for
 * someone the store does not have yet, who is added. A person with an email is whoever has that
 * email here (AUTH-2: emails are lower-cased). Otherwise the moved store's owner is this
 * store's owner, and anyone else the person with the same id (someone an earlier move brought
 * here), else, for someone without an email, the person with the same name, ignoring case.
 */
export function matchPeople(moved: Person[], present: Person[]): Map<string, string | null> {
  const owner = present.find((candidate) => candidate.owner);
  if (owner === undefined) throw new Error("the store has no owner");
  return new Map(moved.map((one): [string, string | null] => {
    const email = one.email?.toLowerCase() ?? null;
    const match = (email === null ? undefined : present.find((candidate) => candidate.email?.toLowerCase() === email))
      ?? (one.owner ? owner : undefined)
      ?? present.find((candidate) => candidate.id === one.id)
      ?? (email === null ? present.find((candidate) => candidate.name.trim().toLowerCase() === one.name.trim().toLowerCase()) : undefined);
    return [one.id, match?.id ?? null];
  }));
}
