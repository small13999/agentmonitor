import { readFileSync, watch } from "node:fs";

/** How often the system's clock ticks. */
const TICK_MS = 60_000;

/**
 * The gateway's time for what it does on its own as time passes (AUTO-14: runs' time limits):
 * the system's clock, which ticks every minute. Tests shift it instead: `offsetFile` holds how
 * many milliseconds it runs ahead of the system's, and it ticks whenever the file changes, so a
 * test moves time forward and the gateway acts on it at once.
 */
export class Clock {
  private readonly offsetFile: string | null;
  private offset = 0;
  private readonly listeners = new Set<() => void>();
  private stopTicking: (() => void) | null = null;

  constructor(offsetFile: string | null) {
    this.offsetFile = offsetFile;
    this.readOffset();
  }

  now(): number {
    return Date.now() + this.offset;
  }

  /** Calls `listener` on every tick from now on, until `close`. */
  onTick(listener: () => void): void {
    this.listeners.add(listener);
    if (this.stopTicking !== null) return;
    if (this.offsetFile === null) {
      const timer = setInterval(() => this.tick(), TICK_MS);
      timer.unref();
      this.stopTicking = () => clearInterval(timer);
    } else {
      const watcher = watch(this.offsetFile, () => {
        this.readOffset();
        this.tick();
      });
      watcher.unref();
      this.stopTicking = () => watcher.close();
    }
  }

  close(): void {
    this.stopTicking?.();
    this.stopTicking = null;
    this.listeners.clear();
  }

  private tick(): void {
    for (const listener of this.listeners) listener();
  }

  /** A file caught mid-write reads as no number; its next change event reads it whole. */
  private readOffset(): void {
    if (this.offsetFile === null) return;
    let text: string;
    try {
      text = readFileSync(this.offsetFile, "utf8").trim();
    } catch {
      return;
    }
    const offset = Number(text);
    if (text !== "" && Number.isFinite(offset)) this.offset = offset;
  }
}
