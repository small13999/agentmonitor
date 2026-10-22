// `am`: the agent's interface to the Agent Monitor store, run inside a session's container.
// Talks to the session's store socket; the socket identifies the session, so no credentials.
import { execFileSync } from "node:child_process";
import { request } from "node:http";
import { readFileSync } from "node:fs";

const USAGE = `usage: am [--json] COMMAND

  whoami                              this session, its task, and its project
  task show                           this session's task: description, status, topics
  task status                         print the task's status; first line is its revision
  task set-status --base REV          replace the task's status with stdin (max 50 lines):
                                      what is done and what is next, for the next session;
                                      REV is the revision you read; a stale REV is refused
  task set-state STATE                open, in_progress, or in_review
  task create TITLE                   create another task (stdin: its description)
  notes                               the task's notes; first line is their revision
  notes set --base REV                replace the task's notes with stdin;
                                      REV is the revision you read; a stale REV is refused
  check                               what would not survive this session: uncommitted
                                      files, unpushed commits, and untracked files that
                                      look like secrets; fails while there are any
  topic list                          topics of this project
  topic create NAME                   create a topic
  topic show NAME                     a topic's status and linked tasks
  topic status NAME                   print a topic's status; first line is its revision
  topic set-status NAME --base REV    replace the status with stdin (max 50 lines);
                                      REV is the revision you read; a stale REV is refused
  topic link NAME...                  link this session's task to topics
  topic unlink NAME...                unlink this session's task from topics
  session show [ID]                   a session and its task (default: this one)

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
  const envelope = JSON.parse(text) as Envelope;
  if (!envelope.ok) {
    const extra = envelope.currentRevision === undefined ? "" : ` (current revision ${envelope.currentRevision})`;
    throw new CliError(`${envelope.error ?? "request failed"}${extra}`);
  }
  return envelope.data;
}

interface Session {
  id: string;
  name: string;
  branch: string | null;
  baseRef: string | null;
  endedAt: number | null;
}

interface Task {
  id: string;
  title: string;
  description: string;
  state: string;
  branch: string | null;
  status: string;
  statusRevision: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function taskOf(value: unknown): Task {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.title !== "string" || typeof value.description !== "string"
    || typeof value.state !== "string" || typeof value.status !== "string" || typeof value.statusRevision !== "number"
    || (value.branch !== null && typeof value.branch !== "string")) {
    throw new CliError("the store answered with something that is not a task");
  }
  return {
    id: value.id,
    title: value.title,
    description: value.description,
    state: value.state,
    branch: value.branch,
    status: value.status,
    statusRevision: value.statusRevision,
  };
}

function topicsOf(value: unknown): Topic[] {
  if (!Array.isArray(value)) throw new CliError("the store answered with something that is not a topic list");
  return value.map((item: unknown) => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.status !== "string"
      || typeof item.statusRevision !== "number") {
      throw new CliError("the store answered with something that is not a topic");
    }
    return { id: item.id, name: item.name, status: item.status, statusRevision: item.statusRevision };
  });
}

interface Me {
  kind: string;
  project: { id: string; name: string };
  session: Session;
  task: Task;
}

async function whoami(): Promise<Me> {
  const me = await call("GET", "/me") as Me;
  if (me.kind !== "agent") throw new CliError("am must run inside a session's container");
  return me;
}

interface Notes {
  text: string;
  revision: number;
}

function notesOf(value: unknown): Notes {
  if (typeof value !== "object" || value === null || !("text" in value) || typeof value.text !== "string"
    || !("revision" in value) || typeof value.revision !== "number") {
    throw new CliError("the store answered with something that is not notes");
  }
  return { text: value.text, revision: value.revision };
}

/** Untracked files with these names are credentials far more often than work. */
const SECRET_FILE = /(^|\/)(\.env(\.[^/]+)?|[^/]+\.env|[^/]+\.(pem|key|p12|pfx)|id_(rsa|ecdsa|ed25519)|credentials(\.json)?|[^/]*secret[^/]*)$/i;
const EXAMPLE_FILE = /\.(example|sample|template)$/i;

/** TASK-11: what ending this session would leave behind on this machine only, or lose. */
function checkWorktree(me: Me): { uncommitted: string[]; secrets: string[]; unpushed: string[] } {
  const launch: unknown = JSON.parse(readFileSync("/run/agentmonitor/launch.json", "utf8"));
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
  const topics = await call("GET", `/projects/${me.project.id}/topics`) as Topic[];
  const found = topics.find((topic) => topic.name === name);
  if (found === undefined) {
    const known = topics.map((topic) => `"${topic.name}"`).join(", ") || "none";
    throw new CliError(`no topic "${name}" in ${me.project.name} (topics: ${known}); create it with: am topic create NAME`);
  }
  return found;
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

async function main(args: string[]): Promise<void> {
  const json = args[0] === "--json";
  const [group, command, ...rest] = json ? args.slice(1) : args;
  if (group === undefined || group === "help" || group === "--help" || group === "-h") {
    console.log(USAGE);
    return;
  }
  const me = await whoami();

  if (group === "whoami") {
    print(json, me, () => [
      `project ${me.project.name}`,
      `task    ${me.task.title} (${me.task.id}, ${me.task.state})`,
      `session ${me.session.id}`,
      `branch  ${me.session.branch ?? "none"}`,
    ].join("\n"));
    return;
  }

  if (group === "task" && command === "show" && rest.length === 0) {
    const detail = await call("GET", `/tasks/${me.task.id}`);
    const task = taskOf(isRecord(detail) ? detail.task : undefined);
    const topics = topicsOf(isRecord(detail) ? detail.topics : undefined);
    print(json, detail, () => [
      `task ${task.title} (${task.id})`,
      `state  ${task.state}`,
      `branch ${task.branch ?? "none"}`,
      `topics ${topics.map((topic) => topic.name).join(", ") || "none"}`,
      "",
      "description:",
      task.description.trimEnd() || "(none)",
      "",
      `status (revision ${task.statusRevision}):`,
      task.status.trimEnd() || "(none yet)",
    ].join("\n"));
    return;
  }
  if (group === "task" && command === "status" && rest.length === 0) {
    const detail = await call("GET", `/tasks/${me.task.id}`);
    const task = taskOf(isRecord(detail) ? detail.task : undefined);
    print(json, task, () => `# revision ${task.statusRevision}\n${task.status}`.trimEnd());
    return;
  }
  if (group === "task" && command === "set-status" && rest.length === 2 && rest[0] === "--base") {
    const baseRevision = revisionOf(rest[1]);
    const status = readFileSync(0, "utf8");
    const updated = taskOf(await call("PUT", `/tasks/${me.task.id}/status`, { status, baseRevision }));
    print(json, updated, () => `the task's status is now revision ${updated.statusRevision}`);
    return;
  }
  if (group === "task" && command === "set-state" && rest.length === 1) {
    const updated = taskOf(await call("PATCH", `/tasks/${me.task.id}`, { state: rest[0] }));
    print(json, updated, () => `the task is now ${updated.state}`);
    return;
  }
  if (group === "task" && command === "create" && rest.length === 1) {
    const description = process.stdin.isTTY ? "" : readFileSync(0, "utf8");
    const created = taskOf(await call("POST", `/projects/${me.project.id}/tasks`, { title: rest[0], description }));
    print(json, created, () => `created task "${created.title}" (${created.id})`);
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
    const topics = await call("GET", `/projects/${me.project.id}/topics`) as Topic[];
    print(json, topics, () => topicNames(topics));
    return;
  }
  if (group === "topic" && command === "create" && rest.length === 1) {
    const topic = await call("POST", `/projects/${me.project.id}/topics`, { name: rest[0] }) as Topic;
    print(json, topic, () => `created topic "${topic.name}"`);
    return;
  }
  if (group === "topic" && command === "show" && rest.length === 1) {
    const topic = await topicByName(me, rest[0]);
    const detail = await call("GET", `/topics/${topic.id}`) as { topic: Topic; tasks: Array<{ taskId: string; linkedAt: number }> };
    print(json, detail, () => [
      `topic ${detail.topic.name} (revision ${detail.topic.statusRevision})`,
      detail.topic.status === "" ? "(no status yet)" : detail.topic.status.trimEnd(),
      "",
      `tasks: ${detail.tasks.map((link) => link.taskId).join(", ") || "none"}`,
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
    const updated = await call("PUT", `/topics/${topic.id}/status`, { status, baseRevision: base }) as Topic;
    print(json, updated, () => `status of "${updated.name}" is now revision ${updated.statusRevision}`);
    return;
  }
  if (group === "topic" && (command === "link" || command === "unlink") && rest.length > 0) {
    let topics: Topic[] = [];
    for (const name of rest) {
      const topic = await topicByName(me, name);
      topics = topicsOf(await call(command === "link" ? "PUT" : "DELETE", `/tasks/${me.task.id}/topics/${topic.id}`));
    }
    print(json, topics, () => `task topics:\n${topicNames(topics)}`);
    return;
  }

  if (group === "session" && command === "show" && rest.length <= 1) {
    const detail = await call("GET", `/sessions/${rest[0] ?? me.session.id}`);
    const session = isRecord(detail) && isRecord(detail.session) ? detail.session : {};
    const task = taskOf(isRecord(detail) ? detail.task : undefined);
    print(json, detail, () => [
      `session ${String(session.id)}`,
      `task ${task.title} (${task.id}, ${task.state})`,
      `branch ${typeof session.branch === "string" ? session.branch : "none"}`,
      typeof session.endedAt === "number" ? `ended ${new Date(session.endedAt).toISOString()}` : "running",
    ].join("\n"));
    return;
  }

  if (group === "notes" && command === undefined) {
    const notes = notesOf(await call("GET", `/tasks/${me.task.id}/notes`));
    print(json, notes, () => `# revision ${notes.revision}\n${notes.text}`.trimEnd());
    return;
  }
  if (group === "notes" && command === "set" && rest.length === 2 && rest[0] === "--base") {
    const base = revisionOf(rest[1]);
    const text = readFileSync(0, "utf8");
    const updated = notesOf(await call("PUT", `/tasks/${me.task.id}/notes`, { text, baseRevision: base }));
    print(json, updated, () => `notes are now revision ${updated.revision}`);
    return;
  }

  throw new CliError(`unknown command: ${[group, command, ...rest].filter(Boolean).join(" ")}\n\n${USAGE}`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`am: ${error instanceof CliError ? error.message : String(error)}`);
  process.exitCode = 1;
});
