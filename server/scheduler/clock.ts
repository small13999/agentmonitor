import { readFileSync, watch } from "node:fs";
import { basename, dirname } from "node:path";

/** The time the scheduler goes by (AUTO-2). */
export interface Clock {
  now(): number;
  /** Calls `listener` whenever the time jumps; returns what stops it. The system's clock never jumps. */
  onJump(listener: () => void): () => void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  onJump: () => () => undefined,
};

/**
 * Tests only (AGENTMONITOR_CLOCK_FILE): the time is what the file holds (ISO 8601), standing
 * still until the file changes, which is a jump.
 */
export function fileClock(path: string): Clock {
  return {
    now: () => {
      const at = Date.parse(readFileSync(path, "utf8").trim());
      if (Number.isNaN(at)) throw new Error(`the clock file ${path} holds no time`);
      return at;
    },
    onJump: (listener) => {
      // The directory, not the file: a file replaced by a rename would go unwatched.
      const watcher = watch(dirname(path), (_event, name) => {
        if (name === basename(path)) listener();
      });
      return () => watcher.close();
    },
  };
}
