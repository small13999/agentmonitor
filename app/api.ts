import { useEffect, useState } from "react";
import type {
  Actor, ChangedFile, Card, Comment, EndedSession, HistoryEntry, Person, Project, Session, SessionRuntime, Task, TaskChanges, TaskDetail, TaskState, TaskSummary, Topic, TopicLink, UnpushedWork,
} from "../shared/api.ts";
export type {
  Actor, ChangedFile, Card, Comment, EndedSession, HistoryEntry, Person, Project, Session, SessionRuntime, Task, TaskChanges, TaskDetail, TaskState, TaskSummary, Topic, TopicLink, UnpushedWork,
};

/** A refused call; `details` holds the error's extra fields, e.g. the files that block ending a session. */
export class ApiError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown>) {
    super(message);
    this.details = details;
  }
}

/** One store API call; the gateway answers `{ ok, data }` or `{ ok: false, error, ...details }`. */
export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/store${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const envelope = await response.json() as { ok: boolean; data?: T; error?: string; [key: string]: unknown };
  if (!envelope.ok) throw new ApiError(envelope.error ?? `${method} ${path} failed (${response.status})`, envelope);
  return envelope.data as T;
}

/**
 * Data that is re-read every `intervalMs` while mounted. `refresh` re-reads now, e.g. after a
 * change; `path` null means nothing to load yet.
 */
export function usePolled<T>(path: string | null, intervalMs: number): { data: T | null; error: string | null; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    setData(null);
    setError(null);
  }, [path]);
  useEffect(() => {
    if (path === null) return;
    let cancelled = false;
    const load = () => {
      api<T>("GET", path).then(
        (value) => { if (!cancelled) { setData(value); setError(null); } },
        (cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); },
      );
    };
    load();
    const timer = setInterval(load, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [path, intervalMs, tick]);
  return { data, error, refresh: () => setTick((value) => value + 1) };
}
