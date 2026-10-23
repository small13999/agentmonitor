import { Cron } from "croner";

/**
 * AUTO-2: a trigger's schedule: five cron fields (minute hour day month weekday, with ranges,
 * lists, steps, and names) read in an IANA time zone. A day of month and a weekday both given
 * match either, as in cron. Throws on anything else.
 */
export function schedule(cron: string, timezone: string): Cron {
  if (!/^[0-9A-Za-z*,/-]+( +[0-9A-Za-z*,/-]+){4}$/.test(cron.trim())) throw new Error("a cron schedule has five fields: minute hour day month weekday");
  return new Cron(cron.trim(), { timezone, mode: "5-part" });
}

/** The schedule's latest time at or before `now`; null when it has none. */
export function latestTime(scheduled: Cron, now: number): number | null {
  // Cron times are whole minutes; croner's previous runs are strictly before the reference.
  const minute = Math.floor(now / 60_000) * 60_000;
  if (scheduled.match(new Date(minute))) return minute;
  return scheduled.previousRuns(1, new Date(minute))[0]?.getTime() ?? null;
}
