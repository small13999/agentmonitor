import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";
import type { Automation, Firing, FiringOutcome, Trigger, TriggerContext } from "../../shared/api.ts";
import type { Folders } from "../store/folders.ts";
import type { RunInput } from "../store/http.ts";
import { StoreError, type Session, type Store } from "../store/store.ts";
import type { Clock } from "./clock.ts";
import { latestTime, schedule } from "./cron.ts";
import { runCheck, runGuard, type GateOptions } from "./gates.ts";

/** The scheduler looks at every trigger once a minute, at the start of the minute. */
const TICK_MS = 60_000;

/** What the scheduler fires with: the store, the automations' folders, and the start of a run. */
export interface SchedulerContext {
  store: Store;
  folders: Folders;
  startRun(principal: null, automationId: string, input: RunInput): Promise<Session>;
}

/** What became of a firing, as the store settles it. */
type Settled = Pick<Firing, "guard" | "check" | "outcome" | "sessionId" | "error">;

const evaluated = z.object({ evaluatedAt: z.number() });

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * AUTO-2, AUTO-8, AUTO-9: fires the triggers of every automation of the store, one gateway's
 * scheduler per store. Each tick looks at the times since the last one it looked at, which the
 * state file keeps across restarts: a trigger fires for its latest time in between, so times
 * missed while the gateway was down fire once, for the latest, as caught up. A firing is
 * recorded as its time comes (pending; the store takes each trigger's time once), then runs
 * the trigger's guard, then its check, and starts a run when both pass. An automation that is
 * off, or has a run going, starts nothing, and the firing says so.
 */
export class Scheduler {
  private readonly context: SchedulerContext;
  private readonly clock: Clock;
  /** Where the time the last tick looked up to is kept. */
  private readonly stateFile: string;
  private readonly gates: GateOptions;
  /** When this scheduler started: times before it passed while the gateway was down. */
  private startedAt = 0;
  private timer: NodeJS.Timeout | undefined;
  private stopWatching: (() => void) | null = null;
  /** Pending firings of this scheduler, each aborted when it stops. */
  private readonly firing = new Map<string, AbortController>();

  constructor(context: SchedulerContext, options: { clock: Clock; stateFile: string; gates: GateOptions }) {
    this.context = context;
    this.clock = options.clock;
    this.stateFile = options.stateFile;
    this.gates = options.gates;
  }

  /** Fails what a stopped gateway left pending, fires what is due, and then each minute and on every jump of the clock. */
  start(): void {
    const failed = this.context.store.failPendingFirings("the gateway stopped before the firing was done");
    if (failed > 0) console.log(`scheduler: ${failed} firing(s) left pending by a stopped gateway failed`);
    this.startedAt = this.clock.now();
    this.tick();
    this.stopWatching = this.clock.onJump(() => this.tick());
  }

  /** Stops ticking; the firings still pending stop and fail. */
  stop(): void {
    clearTimeout(this.timer);
    this.stopWatching?.();
    this.stopWatching = null;
    for (const [firingId, controller] of this.firing) {
      controller.abort();
      this.context.store.settleFiring(firingId, { guard: null, check: null, outcome: "failed", sessionId: null, error: "the gateway stopped during the firing" });
    }
    this.firing.clear();
  }

  private tick(): void {
    clearTimeout(this.timer);
    try {
      const now = this.clock.now();
      // A scheduler's first tick fires nothing: it looks at the times from now on.
      const since = existsSync(this.stateFile) ? evaluated.parse(JSON.parse(readFileSync(this.stateFile, "utf8"))).evaluatedAt : now;
      this.fireDue(since, now);
      writeFileSync(`${this.stateFile}.new`, JSON.stringify({ evaluatedAt: Math.max(since, now) }));
      renameSync(`${this.stateFile}.new`, this.stateFile);
    } catch (cause) {
      console.error("scheduler: tick failed", cause);
    }
    this.timer = setTimeout(() => this.tick(), TICK_MS - (Date.now() % TICK_MS));
    this.timer.unref();
  }

  /** Records a pending firing for each trigger's latest time after `since`, up to `now`, and fires it. */
  private fireDue(since: number, now: number): void {
    const { store } = this.context;
    const owner = store.ownerPrincipal();
    for (const project of store.listProjects(owner)) {
      for (const { automation, triggers, sessionId } of store.listAutomations(owner, project.id)) {
        for (const trigger of triggers) {
          let time: number | null;
          try {
            time = latestTime(schedule(trigger.cron, trigger.timezone), now);
          } catch (cause) {
            console.error(`scheduler: trigger ${trigger.id} of "${automation.name}" has no schedule: ${message(cause)}`);
            continue;
          }
          if (time === null || time <= since) continue;
          let claimed: Firing;
          try {
            claimed = store.recordFiring({
              triggerId: trigger.id, scheduledAt: time, firedAt: now, caughtUp: time < this.startedAt,
              guard: null, check: null, outcome: "pending", sessionId: null, error: null,
            });
          } catch (cause) {
            // Fired already: each time of a trigger fires once.
            if (cause instanceof StoreError && cause.status === 409) continue;
            throw cause;
          }
          void this.fire(claimed, automation, trigger, sessionId);
        }
      }
    }
  }

  private async fire(claimed: Firing, automation: Automation, trigger: Trigger, running: string | null): Promise<void> {
    const controller = new AbortController();
    this.firing.set(claimed.id, controller);
    let settled: Settled;
    try {
      settled = await this.decide(claimed, automation, trigger, running, controller.signal);
    } catch (cause) {
      settled = { guard: null, check: null, outcome: "failed", sessionId: null, error: message(cause) };
    }
    // Stopped meanwhile: the firing failed as the scheduler stopped.
    if (controller.signal.aborted) return;
    this.firing.delete(claimed.id);
    this.context.store.settleFiring(claimed.id, settled);
    console.log([
      `scheduler: automation "${automation.name}" fired for ${new Date(claimed.scheduledAt).toISOString()}${claimed.caughtUp ? " (caught up)" : ""}: ${settled.outcome}`,
      ...(settled.sessionId === null ? [] : [`run ${settled.sessionId}`]),
      ...(settled.error === null ? [] : [settled.error]),
    ].join(", "));
  }

  private async decide(claimed: Firing, automation: Automation, trigger: Trigger, running: string | null, signal: AbortSignal): Promise<Settled> {
    const nothing = { guard: null, check: null, sessionId: null, error: null };
    if (!automation.enabled) return { ...nothing, outcome: "off" };
    if (running !== null) return { ...nothing, outcome: "running" };
    const folder = this.context.folders.dir({ kind: "automation", id: automation.id });
    mkdirSync(folder, { recursive: true });
    const gate = { firingId: claimed.id, folder, signal };
    const guard = trigger.guardPath === null ? null : await runGuard(this.gates, { ...gate, path: trigger.guardPath });
    if (guard !== null && !guard.passed) return { ...nothing, guard, outcome: "guard" };
    const check = trigger.checkPath === null ? null : await runCheck(this.gates, { ...gate, path: trigger.checkPath, guardOutput: guard?.output ?? null });
    if (check !== null && !check.passed) return { ...nothing, guard, check, outcome: "check" };
    const triggerContext: TriggerContext = {
      firingId: claimed.id, triggerId: trigger.id, cron: trigger.cron, timezone: trigger.timezone,
      scheduledAt: claimed.scheduledAt, caughtUp: claimed.caughtUp, guard, check,
    };
    try {
      const run = await this.context.startRun(null, automation.id, { triggerContext });
      return { ...nothing, guard, check, outcome: "started", sessionId: run.id };
    } catch (cause) {
      // While the guard and check ran, the automation may have gone off or started a run.
      const now = this.context.store.getAutomation(this.context.store.ownerPrincipal(), automation.id);
      const outcome: FiringOutcome = !now.automation.enabled ? "off" : now.runs.some((run) => run.endedAt === null) ? "running" : "failed";
      return { ...nothing, guard, check, outcome, error: outcome === "failed" ? message(cause) : null };
    }
  }
}
