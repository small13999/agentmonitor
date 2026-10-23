import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, createWriteStream, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { EndedSession, MoveLeftBehind, MoveReceipt, Project } from "../../shared/api.ts";
import { branchExists, git, taskSnapshots, uncommittedFiles, unpushedCommits } from "../git.ts";
import type { WorkspaceDirs } from "../runtime/runtime.ts";
import { chatCwd } from "../transcript.ts";
import { projectRecords, type ProjectRecords } from "./bundle.ts";
import type { Folders } from "./folders.ts";
import { FileResponse } from "./http.ts";
import { runShortId, StoreError, type FolderOwner, type Principal, type Session, type Store } from "./store.ts";

/** What moving a project needs of its gateway. */
export interface MoveHost {
  store: Store;
  folders: Folders;
  dirs(sessionId: string): WorkspaceDirs;
  /** Whether the session's agent runs; where sessions have no workspaces, every session not ended does. */
  running(session: Session): Promise<boolean>;
  endSession(principal: Principal, sessionId: string): Promise<EndedSession>;
  /** The project's repository on this machine, which holds its snapshots; null where sessions have no workspaces. */
  repo(project: Project): string | null;
}

/** An upload nobody finished is removed after this long, when the next one starts. */
const UPLOAD_KEPT_MS = 24 * 60 * 60 * 1000;
/** The chats of a session: omp's transcripts and the blobs (images) they refer to, in its agent directory. */
const CHAT_DIRS = ["sessions", "blobs"];

/** Every regular file under `dir`, relative to it; links and special files are left out. */
function regularFiles(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) return regularFiles(dir, path);
    return entry.isFile() ? [path] : [];
  });
}

/** `from` at `to` as well: a hard link, or a copy with its modification time where the two are on different filesystems. */
function place(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  try {
    linkSync(from, to);
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "EXDEV")) throw cause;
    copyFileSync(from, to);
    const { atime, mtime } = statSync(from);
    utimesSync(to, atime, mtime);
  }
}

/**
 * STORE-6: moving a project to another store. The source exports the project as one bundle, a
 * .tar.gz of `bundle.json` (its records, ProjectRecords), `folders/<task or automation id>/…`
 * (its tasks' and automations' folders), and `chats/<session id>/{sessions,blobs}/…` (its
 * sessions' chats, runs' too). The target receives the bundle in parts, which pass any proxy's
 * request size limit, and imports it. The source deletes the project only once the target
 * confirms it holds what was exported.
 */
export class ProjectMoves {
  private readonly host: MoveHost;
  /** Exports and imports being assembled, and the uploads of bundles. */
  private readonly root: string;

  constructor(host: MoveHost, root: string) {
    this.host = host;
    this.root = root;
  }

  /** The project's records as a bundle holds them, its folders read first (FOLDER-3: the directory is what counts). */
  private records(principal: Principal, projectId: string): { records: ProjectRecords; json: string } {
    for (const { task } of this.host.store.listTasks(principal, projectId)) this.host.folders.sync({ kind: "task", id: task.id });
    for (const { automation } of this.host.store.listAutomations(principal, projectId)) this.host.folders.sync({ kind: "automation", id: automation.id });
    const records = this.host.store.projectRecords(principal, projectId);
    return { records, json: `${JSON.stringify(records, null, 1)}\n` };
  }

  /** The work of each task and each automation's run that a move leaves behind on this machine; see MoveLeftBehind. */
  private async leftBehind(principal: Principal, repo: string, projectId: string, stopped: Session[]): Promise<MoveLeftBehind[]> {
    const { store } = this.host;
    const owners = [
      ...store.listTasks(principal, projectId).map(({ task }) => ({
        taskId: task.id,
        runId: null,
        // SESSION-9: a task's snapshots go by its id, a run's by its session's (AUTO-9).
        snapshots: task.id,
        title: task.title,
        branch: task.branch,
        baseRef: task.baseRef,
        session: stopped.find((candidate) => candidate.taskId === task.id && !candidate.checkout),
      })),
      ...store.listAutomations(principal, projectId).flatMap(({ automation }) => store.listRuns(principal, automation.id).map((run) => ({
        taskId: null,
        runId: run.id,
        snapshots: run.id,
        title: `${automation.name}, run ${runShortId(run.id)}`,
        branch: run.branch,
        baseRef: run.baseRef,
        session: run.endedAt === null ? run : undefined,
      }))),
    ];
    const found: MoveLeftBehind[] = [];
    for (const { taskId, runId, snapshots, title, branch, baseRef, session } of owners) {
      const worktree = session === undefined ? null : this.host.dirs(session.id).worktree;
      try {
        const uncommitted = worktree !== null && existsSync(worktree) ? await uncommittedFiles(worktree) : [];
        const snapshot = (await taskSnapshots(repo, snapshots)).length > 0;
        const unpushed = branch !== null && baseRef !== null && (await branchExists(repo, branch)) ? await unpushedCommits(repo, branch, baseRef) : [];
        if (snapshot || uncommitted.length > 0 || unpushed.length > 0) found.push({ taskId, runId, title, snapshot, uncommitted, unpushed });
      } catch (cause) {
        throw new StoreError(500, `could not read the work of ${title}: ${String(cause)}`);
      }
    }
    return found;
  }

  /** The session's chat files, each as where it is and where it goes in the bundle's `chats/<session id>/`. */
  private chats(session: Session, project: Project): Array<{ from: string; to: string }> {
    const agent = join(this.host.dirs(session.id).ompHome, "agent");
    return CHAT_DIRS.flatMap((name) => {
      const dir = join(agent, name);
      const found = lstatSync(dir, { throwIfNoEntry: false });
      if (found?.isDirectory()) return regularFiles(dir).map((path) => ({ from: join(dir, path), to: `${name}/${path}` }));
      if (!found?.isSymbolicLink() || name !== "sessions" || project.repoPath === null) return [];
      // HOST-7: a checkout session's chats are among the user's own; only the checkout's go along.
      const real = realpathSync(dir);
      return readdirSync(real, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && readdirSync(join(real, entry.name)).some((file) => file.endsWith(".jsonl") && chatCwd(join(real, entry.name, file)) === project.repoPath))
        .flatMap((entry) => regularFiles(join(real, entry.name)).map((path) => ({ from: join(real, entry.name, path), to: `${name}/${entry.name}/${path}` })));
    });
  }

  /**
   * STORE-6: the project's bundle, for its store's owner. Refused while a session of the project
   * runs, naming it. A stopped session ends first, as when a person ends it: a session moves
   * with its chats, never with its workspace. Work the move would leave behind (MoveLeftBehind)
   * is refused without `confirm`.
   */
  async export(principal: Principal, projectId: string, confirm: boolean): Promise<FileResponse> {
    const { store, folders } = this.host;
    store.requireOwner(principal);
    const project = store.getProject(principal, projectId);
    const open = store.listSessions(principal, projectId);
    const running: Session[] = [];
    for (const session of open) if (await this.host.running(session)) running.push(session);
    if (running.length > 0) {
      throw new StoreError(409, `${project.name} has running sessions, which cannot move: ${running.map((session) => `${session.name} (${session.id})`).join(", ")}; end them first`, {
        sessionIds: running.map((session) => session.id),
      });
    }
    const repo = this.host.repo(project);
    if (repo !== null && existsSync(repo) && !confirm) {
      const leftBehind = await this.leftBehind(principal, repo, projectId, open);
      if (leftBehind.length > 0) {
        throw new StoreError(409, `tasks and runs of ${project.name} have work that does not move: ${leftBehind.map((left) => left.title).join(", ")}; move with confirm to leave it behind`, {
          leftBehind,
        });
      }
    }
    for (const session of open) await this.host.endSession(principal, session.id);
    const { records, json } = this.records(principal, projectId);
    const staging = join(this.root, `export-${projectId}-${Date.now()}`);
    try {
      mkdirSync(join(staging, "folders"), { recursive: true });
      mkdirSync(join(staging, "chats"));
      writeFileSync(join(staging, "bundle.json"), json);
      const files = [
        ...records.folderFiles.map((file): [FolderOwner, string] => [{ kind: "task", id: file.taskId }, file.path]),
        ...records.automationFiles.map((file): [FolderOwner, string] => [{ kind: "automation", id: file.automationId }, file.path]),
      ];
      for (const [owner, path] of files) place(join(folders.dir(owner), path), join(staging, "folders", owner.id, path));
      for (const session of records.sessions) {
        for (const { from, to } of this.chats(session, project)) place(from, join(staging, "chats", session.id, to));
      }
    } catch (cause) {
      rmSync(staging, { recursive: true, force: true });
      throw cause;
    }
    const tar = spawn("tar", ["-czf", "-", "-C", staging, "bundle.json", "folders", "chats"], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    tar.stderr.on("data", (chunk) => { stderr += chunk; });
    tar.on("close", (code) => {
      rmSync(staging, { recursive: true, force: true });
      // The answer is cut short then; the target finds the bundle unreadable.
      if (code !== 0) console.error(`export of ${project.name} failed: tar exited with ${code}: ${stderr}`);
    });
    const name = `${project.name.replace(/[^\p{L}\p{N}._-]+/gu, "-") || "project"}.tar.gz`;
    return new FileResponse(200, {
      "content-type": "application/gzip",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      "cache-control": "no-store",
    }, tar.stdout);
  }

  /**
   * STORE-6: appends a part of a bundle to the upload `uploadId`; `offset` is where the part
   * starts, so a part sent twice or out of order is refused with the size the upload has.
   */
  async receive(principal: Principal, uploadId: string, offset: number, body: Readable): Promise<{ size: number }> {
    this.host.store.requireOwner(principal);
    const file = join(this.root, "uploads", `${uploadId}.tar.gz`);
    mkdirSync(dirname(file), { recursive: true });
    const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
    if (offset !== size) throw new StoreError(409, `the upload has ${size} bytes; send the part from there`, { size });
    if (offset === 0) {
      for (const name of readdirSync(dirname(file))) {
        const stale = join(dirname(file), name);
        if (statSync(stale).mtimeMs < Date.now() - UPLOAD_KEPT_MS) rmSync(stale, { force: true });
      }
    }
    await pipeline(body, createWriteStream(file, { flags: "a" }));
    return { size: statSync(file).size };
  }

  /**
   * STORE-6: imports the bundle uploaded as `uploadId`: its records with their ids (refused when
   * this store has any of them), its folders and its chats. `repoPath` is the project's main
   * checkout on this machine. The receipt's digest is what the source deletes the project for.
   */
  async import(principal: Principal, uploadId: string, repoPath: string | null): Promise<MoveReceipt> {
    const { store, folders } = this.host;
    store.requireOwner(principal);
    const file = join(this.root, "uploads", `${uploadId}.tar.gz`);
    if (!existsSync(file)) throw new StoreError(404, `upload ${uploadId} not found`);
    const staging = join(this.root, `import-${uploadId}`);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    try {
      const extracted = Promise.withResolvers<void>();
      execFile("tar", ["-xzf", file, "-C", staging, "--no-same-owner"], (error, _, stderr) => {
        if (error === null) extracted.resolve();
        else extracted.reject(new StoreError(400, `the bundle is not a readable .tar.gz: ${stderr.trim() || error.message}`));
      });
      await extracted.promise;
      const odd = readdirSync(staging, { recursive: true, encoding: "utf8" }).find((path) => {
        const found = lstatSync(join(staging, path));
        return !found.isFile() && !found.isDirectory();
      });
      if (odd !== undefined) throw new StoreError(400, `the bundle holds ${odd}, which is neither a file nor a folder`);
      if (!existsSync(join(staging, "bundle.json"))) throw new StoreError(400, "the bundle has no bundle.json");
      const raw = readFileSync(join(staging, "bundle.json"));
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        throw new StoreError(400, "the bundle's bundle.json is not JSON");
      }
      const records = projectRecords.parse(parsed);
      const listed = (path: string) => (existsSync(join(staging, path)) ? readdirSync(join(staging, path)) : []);
      const unknown = [
        ...listed("").filter((name) => !["bundle.json", "folders", "chats"].includes(name)),
        ...listed("folders").filter((id) => !records.tasks.some((task) => task.id === id) && !records.automations.some((found) => found.id === id)).map((id) => `folders/${id}`),
        ...listed("chats").flatMap((id) => records.sessions.some((session) => session.id === id)
          ? listed(`chats/${id}`).filter((name) => !CHAT_DIRS.includes(name)).map((name) => `chats/${id}/${name}`)
          : [`chats/${id}`]),
      ];
      if (unknown.length > 0) throw new StoreError(400, `the bundle holds what its records do not name: ${unknown.join(", ")}`);
      for (const id of listed("chats")) {
        if (existsSync(this.host.dirs(id).root)) throw new StoreError(409, `this store already has a directory for session ${id}`);
      }

      const { project, added } = store.importProject(principal, records, repoPath);
      const placed: FolderOwner[] = [];
      try {
        for (const id of listed("folders")) {
          const owner: FolderOwner = records.tasks.some((task) => task.id === id) ? { kind: "task", id } : { kind: "automation", id };
          const files = owner.kind === "task" ? records.folderFiles.filter((found) => found.taskId === id) : records.automationFiles.filter((found) => found.automationId === id);
          folders.adopt(owner, join(staging, "folders", id), files);
          placed.push(owner);
        }
        for (const id of listed("chats")) {
          const agent = join(this.host.dirs(id).ompHome, "agent");
          mkdirSync(agent, { recursive: true });
          for (const name of listed(`chats/${id}`)) renameSync(join(staging, "chats", id, name), join(agent, name));
        }
      } catch (cause) {
        store.deleteProject(principal, project.id);
        for (const owner of placed) folders.delete(owner);
        for (const id of listed("chats")) rmSync(this.host.dirs(id).root, { recursive: true, force: true });
        throw cause;
      }
      return {
        project,
        digest: createHash("sha256").update(raw).digest("hex"),
        added,
        counts: {
          topics: records.topics.length,
          tasks: records.tasks.length,
          automations: records.automations.length,
          comments: records.comments.length,
          sessions: records.sessions.length,
          files: records.folderFiles.length + records.automationFiles.length,
          chats: listed("chats").length,
        },
      };
    } finally {
      rmSync(staging, { recursive: true, force: true });
      rmSync(file, { force: true });
    }
  }

  /**
   * STORE-6: deletes a project the store at the other end of a move confirmed it holds, with its
   * folders, chats, and snapshots; refused unless `digest` is the digest of the project's records
   * as they are now, so nothing written here since the export is lost.
   */
  async deleteMoved(principal: Principal, projectId: string, digest: string): Promise<{ project: Project }> {
    const { store, folders } = this.host;
    store.requireOwner(principal);
    const project = store.getProject(principal, projectId);
    const { records, json } = this.records(principal, projectId);
    if (createHash("sha256").update(json).digest("hex") !== digest) {
      throw new StoreError(409, `${project.name} changed here since it was exported, so it stays here; the other store holds it as it was exported`);
    }
    store.deleteProject(principal, projectId);
    for (const task of records.tasks) folders.delete({ kind: "task", id: task.id });
    for (const automation of records.automations) folders.delete({ kind: "automation", id: automation.id });
    for (const session of records.sessions) rmSync(this.host.dirs(session.id).root, { recursive: true, force: true });
    const repo = this.host.repo(project);
    if (repo !== null && existsSync(repo)) {
      // SESSION-9: a task's snapshots go by its id, a run's by its session's (AUTO-9).
      for (const id of [...records.tasks.map((task) => task.id), ...records.sessions.filter((session) => session.taskId === null).map((session) => session.id)]) {
        for (const ref of await taskSnapshots(repo, id)) await git(repo, ["update-ref", "-d", ref]);
      }
    }
    return { project };
  }
}
