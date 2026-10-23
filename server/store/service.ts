import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { userInfo } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { Card, EndedSession, HistoryEntry, TaskChanges, UnpushedWork } from "../../shared/api.ts";
import { projectCards } from "../cards.ts";
import { taskChanges } from "../changes.ts";
import { CLOUDFLARE_API_PREFIX, CloudflareBroker } from "../cloudflare.ts";
import type { GatewayConfig } from "../config.ts";
import {
  addWorktree,
  branchExists,
  defaultBaseRef,
  deleteBranch,
  fetchOrigin,
  removeWorktree,
  restoreSnapshot,
  saveSnapshot,
  snapshotRef,
  unpushedCommits,
  type RestoredSnapshot,
} from "../git.ts";
import { branchPullRequests } from "../github.ts";
import { HostRuntime } from "../runtime/host.ts";
import { PodmanRuntime } from "../runtime/podman.ts";
import type { Runtime, WorkspaceDirs } from "../runtime/runtime.ts";
import { newestTranscript } from "../transcript.ts";
import { handleStoreApi, type SessionInput, type StoreContext } from "./http.ts";
import { Store, StoreError, type Principal, type Session, type SessionRuntime, type Task } from "./store.ts";

type ServiceConfig = Pick<
  GatewayConfig,
  "workspaceRuntime" | "workspaceMemoryMib" | "machineName" | "ompAgentDir" | "credentialsHome" | "configDir" | "cloudflareApi"
>;

export interface TernUpstream {
  address: string;
  token: string;
  origin: string;
}

/** The part of run/launch.json the gateway reads back. */
const launchFile = z.object({ ternOrigin: z.string() });

/** How long a started session gets until its Tern web client answers. */
const TERN_START_MS = 60_000;

function failure(cause: unknown): string {
  return cause instanceof Error && "stderr" in cause ? String(cause.stderr).trim() : String(cause);
}

/**
 * The gateway's store: the database, the socket of each running session, and the
 * sessions' workspaces (worktree and container).
 *
 * Agents reach the store through a Unix socket in their session's run directory,
 * the only gateway endpoint mounted into the container. The socket a request arrives
 * on is the agent's identity: no token exists to leak, and nothing on the network
 * listens for agents. The same socket carries the agent's Cloudflare API requests to the
 * Cloudflare broker.
 */
export class StoreService implements StoreContext {
  readonly store: Store;
  private readonly servers = new Map<string, Server>();
  /** Asking podman for a container's port takes a quarter second, so each page load would wait on it. */
  private readonly ternUpstreams = new Map<string, TernUpstream>();
  /** Sessions being started, first or again; every request for the session waits on the one start. */
  private readonly starts = new Map<string, Promise<void>>();
  private readonly root: string;
  /** HOST-1: one runtime per kind; null keeps records only (store tests). */
  private readonly runtimes: Record<SessionRuntime, Runtime> | null;
  private readonly config: ServiceConfig;
  private readonly cloudflare: CloudflareBroker;

  constructor(stateDir: string, config: ServiceConfig) {
    this.store = new Store(join(stateDir, "store.sqlite"), userInfo().username);
    this.root = join(stateDir, "sessions");
    this.runtimes = config.workspaceRuntime === "podman"
      ? {
          container: new PodmanRuntime({ memoryMib: config.workspaceMemoryMib, stateDir, ompAgentDir: config.ompAgentDir, credentialsHome: config.credentialsHome }),
          host: new HostRuntime({ stateDir, ompAgentDir: config.ompAgentDir, dirs: (sessionId) => this.dirs(sessionId) }),
        }
      : null;
    this.config = config;
    this.cloudflare = new CloudflareBroker({ configDir: config.configDir, upstream: config.cloudflareApi });
  }

  dirs(sessionId: string): WorkspaceDirs {
    const root = join(this.root, sessionId);
    return { root, run: join(root, "run"), worktree: join(root, "worktree"), ompHome: join(root, "omp-home") };
  }

  cards(principal: Principal, projectId: string): Promise<Card[]> {
    const tokens = this.cloudflare.tokens(this.store.getProject(principal, projectId).name);
    const cloudflareOf = (sessionId: string): Card["cloudflare"] =>
      tokens === null ? null : { canWrite: tokens.write !== null, writesUntil: this.cloudflare.writesUntil(sessionId) };
    return projectCards(this.store, (id) => this.dirs(id), cloudflareOf, principal, projectId);
  }

  /** TASK-14: the task's history; the pull requests of its branch join it, by no one, when GitHub first lists them. */
  async taskHistory(principal: Principal, taskId: string): Promise<HistoryEntry[]> {
    const { task } = this.store.getTask(principal, taskId);
    const { repoPath } = this.store.getProject(principal, task.projectId);
    if (repoPath !== null && task.branch !== null) {
      for (const pr of (await branchPullRequests(repoPath, task.branch, "all")) ?? []) this.store.recordPullRequest(task.id, pr, pr.createdAt);
    }
    return this.store.taskHistory(principal, taskId);
  }

  taskChanges(principal: Principal, taskId: string): Promise<TaskChanges> {
    return taskChanges(this.store, (id) => this.dirs(id), principal, taskId);
  }

  /** The running session whose Cloudflare writes a human allows or revokes; its project must have a write token. */
  private cloudflareSession(principal: Principal, sessionId: string): Session {
    if (principal.kind !== "human") throw new StoreError(403, "only a human can allow or revoke Cloudflare writes");
    const { session } = this.store.getSession(principal, sessionId);
    if (session.endedAt !== null) throw new StoreError(409, `session ${session.name} has ended`);
    const project = this.store.getProject(principal, session.projectId);
    const tokens = this.cloudflare.tokens(project.name);
    if (tokens === null || tokens.write === null) {
      throw new StoreError(409, `project ${project.name} has no Cloudflare write token in Agent Monitor`);
    }
    return session;
  }

  allowCloudflareWrites(principal: Principal, sessionId: string): { writesUntil: number } {
    return { writesUntil: this.cloudflare.allowWrites(this.cloudflareSession(principal, sessionId).id) };
  }

  revokeCloudflareWrites(principal: Principal, sessionId: string): { writesUntil: null } {
    this.cloudflare.revokeWrites(this.cloudflareSession(principal, sessionId).id);
    return { writesUntil: null };
  }

  /**
   * Where the session's Tern web client listens, the token it wants on /wire and the origin
   * it accepts; 404 for unknown sessions, 409 for ended ones. A stopped container starts
   * again first (SESSION-10). Remembered until forgetTernUpstream, which the proxy calls
   * when the address stops answering.
   */
  async ternUpstream(sessionId: string): Promise<TernUpstream> {
    const { session } = this.store.getSession(this.store.ownerPrincipal(), sessionId);
    if (session.endedAt !== null) throw new StoreError(409, `session ${session.name} has ended`);
    const known = this.ternUpstreams.get(sessionId);
    if (known !== undefined) return known;
    const runtime = this.runtimes?.[session.runtime];
    if (runtime === undefined) throw new StoreError(409, "sessions run without containers here");
    let start = this.starts.get(sessionId);
    if (start === undefined && !(await runtime.running(sessionId))) {
      start = this.restart(runtime, session).finally(() => this.starts.delete(sessionId));
      this.starts.set(sessionId, start);
    }
    await start;
    let address: string;
    try {
      address = await runtime.ternAddress(sessionId);
    } catch (cause) {
      throw new StoreError(409, `the session is not running: ${failure(cause)}`);
    }
    const { run } = this.dirs(sessionId);
    const launch = launchFile.parse(JSON.parse(readFileSync(join(run, "launch.json"), "utf8")));
    const upstream = { address, token: readFileSync(join(run, "tern-token"), "utf8").trim(), origin: launch.ternOrigin };
    this.ternUpstreams.set(sessionId, upstream);
    return upstream;
  }

  forgetTernUpstream(sessionId: string): void {
    this.ternUpstreams.delete(sessionId);
  }

  /** The session's processes started again, resuming its newest chat, once Tern answers. */
  private async restart(runtime: Runtime, session: Session): Promise<void> {
    const project = this.store.getProject(this.store.ownerPrincipal(), session.projectId);
    const dirs = this.dirs(session.id);
    if (project.repoPath === null || !existsSync(session.checkout ? project.repoPath : dirs.worktree)) {
      throw new StoreError(409, `session ${session.name} has no worktree to start again on`);
    }
    // omp names a chat's transcript <time>_<chat id>.jsonl. A checkout session's chats sit
    // among the user's (HOST-7): its newest is the newest of the checkout's.
    const newest = newestTranscript(dirs.ompHome, session.checkout ? project.repoPath : null);
    const resume = newest === null ? null : /_([0-9a-f-]{36})\.jsonl$/.exec(basename(newest))?.[1] ?? null;
    this.forgetTernUpstream(session.id);
    try {
      await runtime.launch({
        checkout: session.checkout,
        sessionId: session.id,
        repoPath: project.repoPath,
        dirs,
        // A resumed chat keeps the model it last ran.
        model: resume === null ? session.model : null,
        resume,
        ternOrigin: `http://tern-${session.id}.localhost`,
        cloudflare: this.cloudflare.tokens(project.name) !== null,
        taskContext: this.taskContext(session.taskId, { kind: "none" }, session.checkout ? project.repoPath : null),
      });
      await this.ternAnswers(runtime, session.id);
    } catch (cause) {
      throw new StoreError(500, `could not start session ${session.name} again: ${failure(cause)}`);
    }
  }

  /** Waits until the session's Tern web client answers; fails once the session stops or the time is up. */
  private async ternAnswers(runtime: Runtime, sessionId: string): Promise<void> {
    const address = await runtime.ternAddress(sessionId);
    for (const deadline = Date.now() + TERN_START_MS; ;) {
      const answered = await fetch(`http://${address}/`).then(() => true, () => false);
      if (answered) return;
      if (!(await runtime.running(sessionId))) throw new Error("the session stopped while starting");
      if (Date.now() > deadline) throw new Error(`Tern did not answer within ${TERN_START_MS / 1000} s`);
      await sleep(200);
    }
  }

  private async listen(sessionId: string): Promise<void> {
    if (this.servers.has(sessionId)) return;
    const { run } = this.dirs(sessionId);
    mkdirSync(run, { recursive: true, mode: 0o700 });
    const agent = createServer((request, response) => {
      if (new URL(request.url ?? "/", "http://localhost").pathname.startsWith(CLOUDFLARE_API_PREFIX)) {
        let project: string;
        try {
          const owner = this.store.ownerPrincipal();
          project = this.store.getProject(owner, this.store.getSession(owner, sessionId).session.projectId).name;
        } catch {
          response.writeHead(403).end();
          return;
        }
        this.cloudflare.handle(request, response, sessionId, project);
        return;
      }
      void handleStoreApi(request, response, this, { kind: "agent", sessionId });
    });
    this.servers.set(sessionId, agent);
    const path = join(run, "am.sock");
    rmSync(path, { force: true });
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    agent.once("error", reject);
    agent.listen(path, () => resolve());
    await promise;
    // The container user is the host user (rootless keep-id); nobody else needs access.
    chmodSync(path, 0o600);
  }

  private unlisten(sessionId: string): void {
    this.servers.get(sessionId)?.close();
    this.servers.delete(sessionId);
    this.ternUpstreams.delete(sessionId);
    this.cloudflare.revokeWrites(sessionId);
  }

  /**
   * TASK-6: what the container adds to the agent's workflow context: the task as it is now,
   * with its comments (COMMENT-3: the only time they reach the agent unasked), and what
   * happened to the work an earlier session left uncommitted (SESSION-9). A checkout session
   * (HOST-6) is told it works in the main checkout, `checkout`, instead.
   */
  private taskContext(taskId: string, restored: RestoredSnapshot, checkout: string | null): string {
    const human = this.store.ownerPrincipal();
    const { task, topics } = this.store.getTask(human, taskId);
    const comments = this.store.listComments(human, taskId);
    const people = this.store.listPeople(human);
    const sections = [
      "# Your task",
      checkout === null
        ? `You work on the task "${task.title}" (id ${task.id}, state ${task.state})${task.branch === null ? "" : ` on its branch \`${task.branch}\``}. ` +
          "Every session of this task works on this branch; only what is committed and pushed to it is certain to reach the next session."
        : `You work on the task "${task.title}" (id ${task.id}, state ${task.state}) in the project's main checkout, \`${checkout}\`, ` +
          "not in a worktree: the live instance runs this code, so every edit takes effect at once, and other sessions' branches are merged here. " +
          "There is no task branch: commit by the end of every turn as anywhere, and back the commits up with `git push origin HEAD:am/integrator`. " +
          "Unlike other sessions, you may push to the default branch, open pull requests to it, and deploy, but only when a person asks for it.",
      `Topics: ${topics.length === 0 ? "none" : topics.map((topic) => topic.name).join(", ")}`,
      "## Description",
      task.description.trim() === "" ? "(none)" : task.description.trim(),
      `## Status (revision ${task.statusRevision})`,
      task.status.trim() === "" ? "(none yet)" : task.status.trim(),
      `## Comments (${comments.length})`,
      ...(comments.length === 0 ? ["(none)"] : comments.map(({ author, body, createdAt, editedAt }) => {
        const name = author.kind === "person"
          ? people.find((person) => person.id === author.personId)?.name ?? "someone no longer in the store"
          : `the agent of session ${author.sessionId}`;
        const quoted = body.trim().split("\n").map((line) => `> ${line}`.trimEnd()).join("\n");
        return `${name}, ${new Date(createdAt).toISOString()}${editedAt === null ? "" : " (edited)"}:\n\n${quoted}`;
      })),
    ];
    if (restored.kind === "restored") {
      sections.push("## Restored work", "The task's previous session ended with uncommitted changes. They are back in the worktree, still uncommitted: commit what belongs to the task.");
    } else if (restored.kind === "conflicts") {
      sections.push(
        "## Restored work",
        "The task's previous session ended with uncommitted changes that did not apply cleanly to the branch as it is now. " +
          `Conflicts are marked in the files where git could merge; the whole snapshot is kept at \`${restored.kept}\` (\`git diff ${restored.kept}^ ${restored.kept}\`).`,
      );
    }
    return `${sections.join("\n\n")}\n`;
  }

  /**
   * Starts a session on the task (TASK-3, TASK-5): a worktree of the task's branch, which its
   * first session creates (TASK-4), with the previous session's uncommitted work restored
   * (SESSION-9), and its agent in a container or on the host (HOST-1). A checkout session
   * works in the main checkout instead (HOST-6), among the user's omp chats (HOST-7). Undone
   * if the launch fails.
   */
  async startSession(principal: Principal, taskId: string, input: SessionInput): Promise<Session> {
    const { task } = this.store.getTask(principal, taskId);
    const project = this.store.getProject(principal, task.projectId);
    const kind = input.runtime ?? "container";
    const runtime = this.runtimes?.[kind] ?? null;
    if (runtime !== null && project.repoPath === null) {
      throw new StoreError(400, `project ${project.name} has no repository to create a worktree from`);
    }
    const repo = runtime === null ? null : project.repoPath;
    const created = this.store.createSession(principal, taskId, {
      model: input.model,
      machine: this.config.machineName,
      runtime: kind,
      checkout: input.checkout,
    });
    const dirs = this.dirs(created.id);
    // The session shows in the task list as soon as it exists; its page waits for this start
    // instead of starting it a second time.
    const starting = Promise.withResolvers<void>();
    this.starts.set(created.id, starting.promise);
    let worktreeAdded = false;
    try {
      await this.listen(created.id);
      if (runtime === null || repo === null) return created;
      let started = created;
      let restored: RestoredSnapshot = { kind: "none" };
      if (!created.checkout) {
        // Fetching also brings in a task branch that only origin has.
        const hasOrigin = await fetchOrigin(repo);
        const slug = task.title.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "task";
        const branch = task.branch ?? `am/${slug}-${randomBytes(2).toString("hex")}`;
        const baseRef = task.baseRef ?? await defaultBaseRef(repo, hasOrigin);
        await addWorktree(repo, branch, dirs.worktree, baseRef);
        worktreeAdded = true;
        if (task.branch === null) this.store.setTaskBranch(task.id, branch, baseRef);
        this.store.setSessionBranch(created.id, branch, baseRef);
        restored = await restoreSnapshot(repo, dirs.worktree, snapshotRef(task.id));
        started = { ...created, branch, baseRef };
      }
      await runtime.launch({
        checkout: created.checkout,
        sessionId: created.id,
        repoPath: repo,
        dirs,
        model: input.model ?? null,
        resume: null,
        ternOrigin: `http://tern-${created.id}.localhost`,
        cloudflare: this.cloudflare.tokens(project.name) !== null,
        taskContext: this.taskContext(task.id, restored, created.checkout ? repo : null),
      });
      await this.ternAnswers(runtime, created.id);
      return started;
    } catch (cause) {
      this.unlisten(created.id);
      let workspaceGone = true;
      if (runtime !== null && repo !== null) {
        await runtime.remove(created.id).catch(() => undefined);
        // A restored snapshot is back in this worktree only; it goes back to the task first.
        workspaceGone = !worktreeAdded || await saveSnapshot(repo, dirs.worktree, snapshotRef(task.id))
          .then(() => removeWorktree(repo, dirs.worktree))
          .then(() => true, () => false);
      }
      if (workspaceGone) rmSync(dirs.root, { recursive: true, force: true });
      this.store.discardSession(created.id);
      if (task.state === "open") this.store.updateTask(principal, task.id, { state: "open" });
      throw new StoreError(500, `could not launch session: ${failure(cause)}`);
    } finally {
      this.starts.delete(created.id);
      starting.resolve();
    }
  }

  /**
   * SESSION-8/SESSION-9: removes the session's workspace and keeps its chats (omp-home) and the
   * task's branch. Uncommitted work becomes the task's snapshot first, so ending never loses
   * it; `kept` lists those files. A checkout session (HOST-6) only stops: the main checkout
   * and its uncommitted work stay as they are.
   */
  async endSession(principal: Principal, sessionId: string): Promise<EndedSession> {
    const { session, task } = this.store.getSession(principal, sessionId);
    if (principal.kind !== "human") throw new StoreError(403, "only a human can do this");
    if (session.endedAt !== null) throw new StoreError(409, `session ${session.name} has already ended`);
    const project = this.store.getProject(principal, session.projectId);
    const dirs = this.dirs(sessionId);
    const runtime = this.runtimes?.[session.runtime] ?? null;
    const repo = runtime === null || session.checkout ? null : project.repoPath;
    let kept: string[] = [];
    if (runtime !== null) {
      try {
        // Stopped first, so the snapshot holds the agent's last writes.
        await runtime.remove(sessionId);
        if (repo !== null && existsSync(dirs.worktree)) kept = await saveSnapshot(repo, dirs.worktree, snapshotRef(task.id));
      } catch (cause) {
        throw new StoreError(500, `could not keep the uncommitted work of ${session.name}, so it has not ended: ${failure(cause)}`);
      }
    }
    const ended = this.store.endSession(principal, sessionId);
    this.unlisten(sessionId);
    if (repo !== null) {
      try {
        await removeWorktree(repo, dirs.worktree);
      } catch (cause) {
        throw new StoreError(500, `${session.name} has ended, but its worktree could not be removed: ${failure(cause)}`);
      }
    }
    rmSync(dirs.run, { recursive: true, force: true });
    return { session: ended, kept };
  }

  /**
   * TASK-9: ends the task's running session and deletes its branch from this machine.
   * Commits no remote has are lost with the branch, so they need `confirm`.
   */
  async finishTask(principal: Principal, taskId: string, state: "done" | "cancelled", confirm: boolean): Promise<Task> {
    if (principal.kind !== "human") throw new StoreError(403, "only a human can do this");
    const { task } = this.store.getTask(principal, taskId);
    const repo = this.runtimes === null ? null : this.store.getProject(principal, task.projectId).repoPath;
    const branch = repo !== null && task.branch !== null && (await branchExists(repo, task.branch)) ? task.branch : null;
    if (repo !== null && branch !== null && task.baseRef !== null && !confirm) {
      let unpushed: string[];
      try {
        unpushed = await unpushedCommits(repo, branch, task.baseRef);
      } catch (cause) {
        throw new StoreError(500, `could not read the commits of ${branch}: ${failure(cause)}`);
      }
      if (unpushed.length > 0) {
        const work: UnpushedWork = { unpushed };
        throw new StoreError(409, `${branch} has ${unpushed.length} commit(s) no remote has, which finishing the task deletes`, { ...work });
      }
    }
    const running = this.store.listTasks(principal, task.projectId).find((summary) => summary.task.id === taskId)?.sessionId ?? null;
    if (running !== null) await this.endSession(principal, running);
    if (repo !== null && branch !== null) {
      try {
        await deleteBranch(repo, branch);
      } catch (cause) {
        throw new StoreError(500, `could not delete ${branch}: ${failure(cause)}`);
      }
    }
    return this.store.finishTask(principal, taskId, state);
  }

  /** Re-open every running session's socket after a gateway restart. */
  async start(): Promise<void> {
    await Promise.all(this.store.runningSessionIds().map((id) => this.listen(id)));
  }

  /** Closes the agent sockets and the database; for a dev server that reloads its config. */
  close(): void {
    for (const id of [...this.servers.keys()]) this.unlisten(id);
    this.store.close();
  }
}
