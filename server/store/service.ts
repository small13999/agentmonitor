import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { userInfo } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { Automation, Card, EndedSession, HistoryEntry, TaskChanges, TaskDetail, UnpushedWork } from "../../shared/api.ts";
import { gatewayZone, hostOrigin } from "../../shared/hosts.ts";
import { projectCards } from "../cards.ts";
import { fileClock, systemClock, type Clock } from "../scheduler/clock.ts";
import { taskChanges } from "../changes.ts";
import { CLOUDFLARE_API_PREFIX, CloudflareBroker } from "../cloudflare.ts";
import type { GatewayConfig } from "../config.ts";
import {
  addWorktree,
  branchExists,
  defaultBaseRef,
  deleteBranch,
  fetchOrigin,
  git,
  removeWorktree,
  restoreSnapshot,
  saveSnapshot,
  snapshotRef,
  unpushedCommits,
  type RestoredSnapshot,
} from "../git.ts";
import { branchPullRequests } from "../github.ts";
import { HostRuntime } from "../runtime/host.ts";
import { CONTAINER_FOLDER, PodmanRuntime } from "../runtime/podman.ts";
import type { LaunchInput, Runtime, WorkspaceDirs } from "../runtime/runtime.ts";
import { Scheduler } from "../scheduler/scheduler.ts";
import { newestTranscript } from "../transcript.ts";
import { Folders } from "./folders.ts";
import { ProjectMoves } from "./move.ts";
import {
  handleStoreApi,
  type AutomationSessionInput,
  type RunEndInput,
  type RunInput,
  type RunTaskInput,
  type SessionInput,
  type StoreContext,
} from "./http.ts";
import { checkOutcome, deleteRemoteBranch, endModeSection, MEMORY_FILE, overTimeLimit, runOutputs, runPrompt, turnEnded, type AgentOutcome } from "./runs.ts";
import { folderOwnerOf, runShortId, Store, StoreError, type Principal, type Project, type RunOutcome, type Session, type SessionRuntime, type Task } from "./store.ts";

type ServiceConfig = Pick<
  GatewayConfig,
  | "workspaceRuntime" | "workspaceMemoryMib" | "machineName" | "ompAgentDir" | "credentialsHome" | "cloudflareApi" | "ownerEmail" | "publicOrigin"
  | "clockFile"
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
  readonly folders: Folders;
  readonly moves: ProjectMoves;
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
  /** AUTO-2: fires the automations' triggers; runs while the store is open. */
  private readonly scheduler: Scheduler;
  /** AUTO-14: the time runs' time limits are measured on. */
  private readonly clock: Clock;
  /** Stops checking runs' time limits: on every minute, and whenever the clock jumps (tests). */
  private stopTicking: () => void = () => undefined;
  /** AUTO-10: runs whose agent said how they went; each ends when its agent's turn does. */
  private readonly ending = new Set<string>();
  /** AUTO-10, AUTO-14: runs being ended without a person, each once, whoever asks. */
  private readonly runStops = new Map<string, Promise<void>>();

  constructor(stateDir: string, config: ServiceConfig) {
    this.store = new Store(join(stateDir, "store.sqlite"), userInfo().username);
    if (config.ownerEmail !== null) this.store.setOwnerEmail(config.ownerEmail);
    this.folders = new Folders(this.store, join(stateDir, "folders"));
    this.root = join(stateDir, "sessions");
    this.runtimes = config.workspaceRuntime === "podman"
      ? {
          container: new PodmanRuntime({ memoryMib: config.workspaceMemoryMib, stateDir, ompAgentDir: config.ompAgentDir, credentialsHome: config.credentialsHome }),
          host: new HostRuntime({ stateDir, ompAgentDir: config.ompAgentDir, dirs: (sessionId) => this.dirs(sessionId) }),
        }
      : null;
    this.config = config;
    this.cloudflare = new CloudflareBroker({ store: this.store, upstream: config.cloudflareApi });
    this.clock = config.clockFile === null ? systemClock : fileClock(config.clockFile);
    this.moves = new ProjectMoves({
      store: this.store,
      folders: this.folders,
      dirs: (sessionId) => this.dirs(sessionId),
      running: async (session) => this.runtimes === null || await this.runtimes[session.runtime].running(session.id),
      endSession: (principal, sessionId) => this.endSession(principal, sessionId),
      repo: (project) => (this.runtimes === null ? null : project.repoPath),
    }, join(stateDir, "moves"));
    this.scheduler = new Scheduler(this, {
      clock: this.clock,
      stateFile: join(stateDir, "scheduler.json"),
      gates: { stateDir, ompAgentDir: config.ompAgentDir, memoryMib: config.workspaceMemoryMib },
    });
  }

  dirs(sessionId: string): WorkspaceDirs {
    const root = join(this.root, sessionId);
    return { root, run: join(root, "run"), worktree: join(root, "worktree"), ompHome: join(root, "omp-home") };
  }

  cards(principal: Principal, projectId: string): Promise<Card[]> {
    const { cloudflare } = this.store.getProject(principal, projectId);
    const cloudflareOf = (sessionId: string): Card["cloudflare"] =>
      cloudflare.read ? { canWrite: cloudflare.write, writesUntil: this.cloudflare.writesUntil(sessionId) } : null;
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

  /** The running session whose Cloudflare writes the owner allows or revokes (AUTH-3); its project must have a write token. */
  private cloudflareSession(principal: Principal, sessionId: string): Session {
    this.store.requireOwner(principal);
    const { session } = this.store.getSession(principal, sessionId);
    if (session.endedAt !== null) throw new StoreError(409, `session ${session.name} has ended`);
    const project = this.store.getProject(principal, session.projectId);
    if (!project.cloudflare.write) {
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
      await this.launch(runtime, project.repoPath, project, session, {
        // A resumed chat keeps the model it last ran.
        model: resume === null ? session.model : null,
        resume,
        // A run's instructions start its first chat only (AUTO-9): starting again goes on from where it was.
        prompt: null,
        taskContext: session.taskId === null
          ? this.runContext(session)
          : this.taskContext(session.taskId, { kind: "none" }, session.checkout ? project.repoPath : null, session.runtime),
      });
    } catch (cause) {
      throw new StoreError(500, `could not start session ${session.name} again: ${failure(cause)}`);
    }
  }

  /** Launches the session's agent with the folder of its task or automation (FOLDER-3, AUTO-1) and waits until Tern answers. */
  private async launch(
    runtime: Runtime,
    repoPath: string,
    project: Project,
    session: Session,
    chat: Pick<LaunchInput, "model" | "resume" | "prompt" | "taskContext">,
  ): Promise<void> {
    await runtime.launch({
      checkout: session.checkout,
      sessionId: session.id,
      repoPath,
      dirs: this.dirs(session.id),
      folder: this.folders.dir(folderOwnerOf(session)),
      ternOrigin: hostOrigin(gatewayZone(this.config.publicOrigin), { kind: "chat", sessionId: session.id }),
      cloudflare: project.cloudflare.read,
      ...chat,
    });
    await this.ternAnswers(runtime, session.id);
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
        let project: Project;
        try {
          const owner = this.store.ownerPrincipal();
          project = this.store.getProject(owner, this.store.getSession(owner, sessionId).session.projectId);
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
   * with its comments (COMMENT-3: the only time they reach the agent unasked), where its folder
   * is (FOLDER-3), and what happened to the work an earlier session left uncommitted
   * (SESSION-9). A checkout session (HOST-6) is told it works in the main checkout, `checkout`,
   * instead.
   */
  private taskContext(taskId: string, restored: RestoredSnapshot, checkout: string | null, runtime: SessionRuntime): string {
    const human = this.store.ownerPrincipal();
    const { task, topics } = this.store.getTask(human, taskId);
    const comments = this.store.listComments(human, taskId);
    const people = this.store.listPeople(human);
    const folder = runtime === "container" ? CONTAINER_FOLDER : this.folders.dir({ kind: "task", id: taskId });
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
      "## Folder",
      `The task's folder is the directory \`${folder}\`, outside the worktree and outside git.`,
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
   * AUTO-9, AUTO-10: what a run's agent is told besides its first prompt: the automation and the
   * run it serves, the run's own branch, how the run ends, and the automation's folder, which all
   * its runs share. AUTO-11: a session on the automation that is no run is told so instead, and
   * which run it goes on from: the run whose branch it has.
   */
  private runContext(session: Session, restored: RestoredSnapshot = { kind: "none" }): string {
    const owner = folderOwnerOf(session);
    const { automation, runs } = this.store.getAutomation(this.store.ownerPrincipal(), owner.id);
    const sections = ["# Your automation"];
    if (session.run !== null) {
      sections.push(
        `You serve the automation "${automation.name}" (id ${automation.id}): this session is its run ${runShortId(session.id)} (session id ${session.id}), ` +
          `started ${session.run.startedBy === null ? "by one of its triggers" : "by hand"}. It belongs to no task.`,
        session.branch === null
          ? "The run works on no branch."
          : `The run works on its own branch \`${session.branch}\`, made for it from \`${session.baseRef ?? "the default branch"}\`; only what is committed and pushed to it outlives the run.`,
        "This chat's first prompt holds the automation's instructions, what started the run, and the automation's memory. `am automation show` prints the automation as it is now.",
        endModeSection(automation, session),
      );
    } else {
      const from = session.branch === null ? undefined : runs.find((run) => run.run !== null && run.branch === session.branch);
      sections.push(
        `You work with a person on the automation "${automation.name}" (id ${automation.id}). This session is on the automation, not one of its runs: ` +
          "it has no end mode and no time limit, and it ends when a person ends it. It belongs to no task.",
        from === undefined
          ? `It works on its own branch \`${session.branch ?? "none"}\`, made from \`${session.baseRef ?? "the default branch"}\`; only what is committed and pushed to it outlives the session.`
          : `It goes on from run ${runShortId(from.id)} (session ${from.id}, outcome ${from.run?.outcome ?? "none"}): it works on the run's branch \`${from.branch ?? ""}\`, ` +
            `and the run's outputs are in \`${runOutputs(from.id)}/\` of the folder.`,
        "`am automation show` prints the automation, its instructions, and its runs; `am run task RUN` makes a task of a run, which takes over the run's branch.",
      );
    }
    sections.push(
      "## Folder",
      `The automation's folder is the directory \`${session.runtime === "container" ? CONTAINER_FOLDER : this.folders.dir(owner)}\`, outside the worktree and outside git. Every run of the automation shares it; ` +
        `\`${MEMORY_FILE}\` in it is the automation's memory, which every run starts with, and \`runs/<run>/\` holds each run's outputs.`,
    );
    if (restored.kind === "restored") {
      sections.push("## Restored work", "The run ended with uncommitted changes. They are back in the worktree, still uncommitted.");
    } else if (restored.kind === "conflicts") {
      sections.push(
        "## Restored work",
        "The run ended with uncommitted changes that did not apply cleanly to the branch as it is now. " +
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
      await this.launch(runtime, repo, project, started, {
        model: input.model ?? null,
        resume: null,
        prompt: null,
        taskContext: this.taskContext(task.id, restored, created.checkout ? repo : null, kind),
      });
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
   * AUTO-9: starts a run of the automation: a session of it, of no task, on a branch of its own,
   * `am/<slug>-<run short id>`, made from the default branch, in a container or on the host by
   * the project's rules (HOST-1), whose chat starts on the automation's instructions.
   * `principal` started it by hand ("run now"); null: one of its triggers did. Undone if the
   * launch fails. Every run starts here, whatever started it.
   */
  async startRun(principal: Principal | null, automationId: string, input: RunInput): Promise<Session> {
    const system = this.store.ownerPrincipal();
    const { automation } = this.store.getAutomation(principal ?? system, automationId);
    const project = this.store.getProject(system, automation.projectId);
    const kind = input.runtime ?? "container";
    const runtime = this.runtimes?.[kind] ?? null;
    if (runtime !== null && project.repoPath === null) {
      throw new StoreError(400, `project ${project.name} has no repository to create a worktree from`);
    }
    const repo = runtime === null ? null : project.repoPath;
    const created = this.store.createRun(principal, automationId, { machine: this.config.machineName, runtime: kind, triggerContext: input.triggerContext });
    const dirs = this.dirs(created.id);
    const starting = Promise.withResolvers<void>();
    this.starts.set(created.id, starting.promise);
    const branch = `am/${automation.slug}-${runShortId(created.id)}`;
    let worktreeAdded = false;
    try {
      await this.listen(created.id);
      if (runtime === null || repo === null) return created;
      const baseRef = await defaultBaseRef(repo, await fetchOrigin(repo));
      await addWorktree(repo, branch, dirs.worktree, baseRef);
      worktreeAdded = true;
      this.store.setSessionBranch(created.id, branch, baseRef);
      const started = { ...created, branch, baseRef };
      // AUTO-13: memory.md as the run starts; a link there is no memory (an agent can make those).
      const folder = this.folders.dir(folderOwnerOf(started));
      const memory = join(folder, MEMORY_FILE);
      await this.launch(runtime, repo, project, started, {
        model: automation.model,
        resume: null,
        prompt: runPrompt(automation, started, lstatSync(memory, { throwIfNoEntry: false })?.isFile() === true ? readFileSync(memory) : null, kind === "container" ? CONTAINER_FOLDER : folder),
        taskContext: this.runContext(started),
      });
      return started;
    } catch (cause) {
      this.unlisten(created.id);
      let workspaceGone = true;
      if (runtime !== null && repo !== null) {
        await runtime.remove(created.id).catch(() => undefined);
        // The branch was made for this run a moment ago: nothing else has it.
        workspaceGone = !worktreeAdded || await removeWorktree(repo, dirs.worktree)
          .then(() => deleteBranch(repo, branch))
          .then(() => true, () => false);
      }
      if (workspaceGone) rmSync(dirs.root, { recursive: true, force: true });
      this.store.discardSession(created.id);
      throw new StoreError(500, `could not launch the run: ${failure(cause)}`);
    } finally {
      this.starts.delete(created.id);
      starting.resolve();
    }
  }

  /** AUTO-1: deletes an automation with its runs' records and chats, and its folder; its runs' branches stay in the repository. */
  deleteAutomation(principal: Principal, automationId: string): Automation {
    const { automation, runIds } = this.store.deleteAutomation(principal, automationId);
    for (const id of runIds) rmSync(this.dirs(id).root, { recursive: true, force: true });
    this.folders.delete({ kind: "automation", id: automationId });
    return automation;
  }

  /**
   * AUTO-11: starts a session on the automation that is no run, for a person to work on it with
   * its agent: on a branch of its own from the default branch, or from a run (`fromRun`), on the
   * run's branch with the run's uncommitted work restored; the run's outputs are in the folder
   * the session gets. A run whose session goes on is gone on with in that session instead.
   * Undone if the launch fails.
   */
  async startAutomationSession(principal: Principal, automationId: string, input: AutomationSessionInput): Promise<Session> {
    const { automation } = this.store.getAutomation(principal, automationId);
    const project = this.store.getProject(principal, automation.projectId);
    let from: Session | null = null;
    if (input.fromRun !== undefined) {
      const { session: found } = this.store.getSession(principal, input.fromRun);
      if (found.automationId !== automationId || found.run === null) throw new StoreError(404, `"${automation.name}" has no run ${input.fromRun}`);
      if (found.endedAt === null) {
        throw new StoreError(409, `run ${runShortId(found.id)} of "${automation.name}" is still going: go on in its session instead`, { sessionId: found.id });
      }
      from = found;
    }
    const kind = input.runtime ?? "container";
    const runtime = this.runtimes?.[kind] ?? null;
    if (runtime !== null && project.repoPath === null) {
      throw new StoreError(400, `project ${project.name} has no repository to create a worktree from`);
    }
    const repo = runtime === null ? null : project.repoPath;
    const created = this.store.createAutomationSession(principal, automationId, { model: input.model, machine: this.config.machineName, runtime: kind });
    const dirs = this.dirs(created.id);
    const starting = Promise.withResolvers<void>();
    this.starts.set(created.id, starting.promise);
    const branch = from?.branch ?? `am/${automation.slug}-${runShortId(created.id)}`;
    let worktreeAdded = false;
    try {
      await this.listen(created.id);
      if (runtime === null || repo === null) return created;
      const hasOrigin = await fetchOrigin(repo);
      const baseRef = from?.baseRef ?? await defaultBaseRef(repo, hasOrigin);
      // A run's branch is reused, or taken from origin; a branch nothing has any more starts again from its base.
      await addWorktree(repo, branch, dirs.worktree, baseRef);
      worktreeAdded = true;
      this.store.setSessionBranch(created.id, branch, baseRef);
      let restored: RestoredSnapshot = { kind: "none" };
      if (from !== null) restored = await restoreSnapshot(repo, dirs.worktree, snapshotRef(from.id));
      const started = { ...created, branch, baseRef };
      await this.launch(runtime, repo, project, started, {
        model: input.model ?? automation.model,
        resume: null,
        prompt: null,
        taskContext: this.runContext(started, restored),
      });
      return started;
    } catch (cause) {
      this.unlisten(created.id);
      let workspaceGone = true;
      if (runtime !== null && repo !== null) {
        await runtime.remove(created.id).catch(() => undefined);
        // A run's restored work goes back to the run; a branch made a moment ago goes.
        workspaceGone = !worktreeAdded || await (from === null
          ? removeWorktree(repo, dirs.worktree).then(() => deleteBranch(repo, branch))
          : saveSnapshot(repo, dirs.worktree, snapshotRef(from.id)).then(() => removeWorktree(repo, dirs.worktree)))
          .then(() => true, () => false);
      }
      if (workspaceGone) rmSync(dirs.root, { recursive: true, force: true });
      this.store.discardSession(created.id);
      throw new StoreError(500, `could not launch the session: ${failure(cause)}`);
    } finally {
      this.starts.delete(created.id);
      starting.resolve();
    }
  }

  /**
   * AUTO-10: a run says how it went: its own agent (`am run end`), or a person. The outcome must
   * suit the automation's end mode (Wait for review deploys only after a review) and be true of
   * the run's work (checkOutcome); nothing to deploy also deletes the branch from origin. `review`
   * leaves the session open, waiting on a person; any other outcome ends it once its agent's
   * turn ends, so the agent's last reply stays in its chat.
   */
  async endRun(principal: Principal, runId: string, input: RunEndInput): Promise<Session> {
    const { session, automation } = this.store.getSession(principal, runId);
    if (session.run === null || automation === null) throw new StoreError(404, `session ${session.name} is no run of an automation`);
    if (principal.kind === "agent" && principal.sessionId !== runId) throw new StoreError(403, "how a run went is for its own agent or a person to say");
    if (session.endedAt !== null || this.ending.has(runId) || this.runStops.has(runId)) {
      throw new StoreError(409, `run ${runShortId(runId)} has ended or is ending (${session.run.outcome ?? "ended"})`);
    }
    const outcome: AgentOutcome = input.outcome;
    if (outcome === "review" && automation.endMode !== "review") {
      throw new StoreError(409, `"${automation.name}" ends its runs with Finish: deploy and end with finished, or end with nothing_to_deploy or failed`);
    }
    if (outcome === "finished" && automation.endMode === "review" && session.run.outcome !== "review") {
      throw new StoreError(409, `"${automation.name}" waits for review before it deploys: push the branch and end with review; a person tells you when to deploy`);
    }
    const repo = this.runtimes === null ? null : this.store.getProject(principal, session.projectId).repoPath;
    const dirs = this.dirs(runId);
    if (repo !== null && existsSync(dirs.worktree)) {
      try {
        await checkOutcome(repo, dirs.worktree, session, outcome);
        if (outcome === "nothing_to_deploy" && session.branch !== null) await deleteRemoteBranch(repo, session.branch);
      } catch (cause) {
        if (cause instanceof StoreError) throw cause;
        throw new StoreError(500, `could not check the run's branch: ${failure(cause)}`);
      }
    }
    this.store.setRunOutcome(runId, outcome, input.reason ?? null);
    if (outcome !== "review") {
      this.ending.add(runId);
      void turnEnded(dirs.run).then(() => this.stopRun(runId, principal, outcome)).finally(() => this.ending.delete(runId));
    }
    return this.store.getSession(principal, runId).session;
  }

  /**
   * AUTO-10, AUTO-14: ends a run without a person: its agent said how it went (`endedBy`), or its
   * time limit stopped it (null, `timed_out`). Its work is kept as a person's ending keeps it
   * (endSession); a run with nothing to deploy loses its branch. Once per run, whoever asks.
   */
  private stopRun(runId: string, endedBy: Principal | null, outcome: RunOutcome): Promise<void> {
    const pending = this.runStops.get(runId);
    if (pending !== undefined) return pending;
    const stopping = (async () => {
      const { session } = this.store.getSession(this.store.ownerPrincipal(), runId);
      if (session.endedAt !== null) return;
      const { session: ended } = await this.closeSession(session, () => this.store.endRun(endedBy, runId, outcome));
      const repo = this.runtimes === null ? null : this.store.getProject(this.store.ownerPrincipal(), ended.projectId).repoPath;
      if (ended.run?.outcome === "nothing_to_deploy" && repo !== null && ended.branch !== null) await deleteBranch(repo, ended.branch);
    })()
      .catch((cause: unknown) => console.error(`could not end run ${runId}: ${failure(cause)}`))
      .finally(() => this.runStops.delete(runId));
    this.runStops.set(runId, stopping);
    return stopping;
  }

  /** AUTO-14: stops every run past its automation's time limit by the gateway's clock; on every tick, and when the gateway starts. */
  private stopRunsOverTime(): void {
    const system = this.store.ownerPrincipal();
    const now = this.clock.now();
    for (const id of this.store.runningSessionIds()) {
      const { session, automation } = this.store.getSession(system, id);
      if (automation !== null && overTimeLimit(session, automation, now)) void this.stopRun(id, null, "timed_out");
    }
  }

  /**
   * AUTO-12: makes a task of a run. The task takes over the run's branch and the uncommitted work
   * the run left (its snapshot, SESSION-9), and the run's outputs are copied into the task's
   * folder, under the same `runs/<run>/`: copies, so the task keeps them whatever becomes of the
   * automation. A run still going ends first, which only a person does.
   */
  async taskFromRun(principal: Principal, runId: string, input: RunTaskInput): Promise<TaskDetail> {
    const { session, automation } = this.store.getSession(principal, runId);
    if (session.run === null || automation === null) throw new StoreError(404, `session ${session.name} is no run of an automation`);
    await this.runStops.get(runId);
    if (this.store.getSession(principal, runId).session.endedAt === null) {
      if (principal.kind !== "human") throw new StoreError(409, `run ${runShortId(runId)} is still going: end it first (am run end), or ask a person to make the task`);
      await this.endSession(principal, runId);
    }
    const short = runShortId(runId);
    const outputs = runOutputs(runId);
    const task = this.store.createTask(principal, session.projectId, {
      title: input.title ?? `${automation.name}: run ${short}`,
      description: input.description ??
        `Made from run ${short} of the automation "${automation.name}" (session ${runId}). ` +
          `The task works on the run's branch${session.branch === null ? "" : ` \`${session.branch}\``}; the run's outputs are copied into this task's folder under \`${outputs}/\`.`,
    });
    if (session.branch !== null && session.baseRef !== null) {
      this.store.setTaskBranch(task.id, session.branch, session.baseRef);
      const repo = this.runtimes === null ? null : this.store.getProject(principal, session.projectId).repoPath;
      if (repo !== null && (await git(repo, ["for-each-ref", snapshotRef(runId)])) !== "") {
        await git(repo, ["update-ref", snapshotRef(task.id), snapshotRef(runId)]);
        await git(repo, ["update-ref", "-d", snapshotRef(runId)]);
      }
    }
    this.folders.copy(principal, { kind: "automation", id: automation.id }, outputs, { kind: "task", id: task.id });
    return this.store.getTask(principal, task.id);
  }

  /**
   * SESSION-8/SESSION-9: removes the session's workspace and keeps its chats (omp-home) and its
   * branch. Uncommitted work becomes the task's snapshot first, or the run's (AUTO-9), so ending
   * never loses it; `kept` lists those files. A checkout session (HOST-6) only stops: the main
   * checkout and its uncommitted work stay as they are.
   */
  async endSession(principal: Principal, sessionId: string): Promise<EndedSession> {
    if (principal.kind !== "human") throw new StoreError(403, "only a human can do this");
    // A run its agent or its time limit is ending ends that way.
    await this.runStops.get(sessionId);
    const { session } = this.store.getSession(principal, sessionId);
    if (session.endedAt !== null) throw new StoreError(409, `session ${session.name} has already ended`);
    return this.closeSession(session, () => this.store.endSession(principal, sessionId));
  }

  /** Ends the session as endSession says; `record` records the end in the store once the workspace has stopped. */
  private async closeSession(session: Session, record: () => Session): Promise<EndedSession> {
    const sessionId = session.id;
    const project = this.store.getProject(this.store.ownerPrincipal(), session.projectId);
    const dirs = this.dirs(sessionId);
    const runtime = this.runtimes?.[session.runtime] ?? null;
    const repo = runtime === null || session.checkout ? null : project.repoPath;
    let kept: string[] = [];
    if (runtime !== null) {
      try {
        // Stopped first, so the snapshot holds the agent's last writes.
        await runtime.remove(sessionId);
        if (repo !== null && existsSync(dirs.worktree)) kept = await saveSnapshot(repo, dirs.worktree, snapshotRef(session.taskId ?? session.id));
      } catch (cause) {
        throw new StoreError(500, `could not keep the uncommitted work of ${session.name}, so it has not ended: ${failure(cause)}`);
      }
    }
    // Recorded now, what its agent wrote into the folder is the agent's; after the session, no one is known to write there (FOLDER-3).
    this.folders.sync(folderOwnerOf(session));
    const ended = record();
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

  /**
   * Re-open every running session's socket after a gateway restart. AUTO-14: runs' time limits
   * hold across restarts: the runs past theirs stop now, the others on a later tick. AUTO-10: a
   * run whose agent said how it went before the restart ends once its turn does, as its agent's.
   * AUTO-2: then the automations' triggers fire, those missed while the gateway was down first.
   */
  async start(): Promise<void> {
    await Promise.all(this.store.runningSessionIds().map((id) => this.listen(id)));
    const system = this.store.ownerPrincipal();
    for (const id of this.store.runningSessionIds()) {
      const outcome = this.store.getSession(system, id).session.run?.outcome ?? null;
      if (outcome === null || outcome === "review") continue;
      this.ending.add(id);
      void turnEnded(this.dirs(id).run).then(() => this.stopRun(id, { kind: "agent", sessionId: id }, outcome)).finally(() => this.ending.delete(id));
    }
    const minutely = setInterval(() => this.stopRunsOverTime(), 60_000);
    minutely.unref();
    const stopJumps = this.clock.onJump(() => this.stopRunsOverTime());
    this.stopTicking = () => {
      clearInterval(minutely);
      stopJumps();
    };
    this.stopRunsOverTime();
    this.scheduler.start();
  }

  /** Stops the scheduler, closes the agent sockets and the database; for a dev server that reloads its config. */
  close(): void {
    this.stopTicking();
    this.scheduler.stop();
    for (const id of [...this.servers.keys()]) this.unlisten(id);
    this.store.close();
  }
}
