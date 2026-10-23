import { useEffect, useState } from "react";
import type {
  Actor, ChangedFile, Card, Comment, EndedSession, FolderFile, HistoryEntry, Person, Project, Session, SessionRuntime, StoreListing, Task, TaskChanges, TaskDetail, TaskState, TaskSummary, Topic, TopicLink, UnpushedWork,
} from "../shared/api.ts";
export type {
  Actor, ChangedFile, Card, Comment, EndedSession, FolderFile, HistoryEntry, Person, Project, Session, SessionRuntime, StoreListing, Task, TaskChanges, TaskDetail, TaskState, TaskSummary, Topic, TopicLink, UnpushedWork,
};

/** A refused call; `details` holds the error's extra fields, e.g. the files that block ending a session. */
export class ApiError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown>) {
    super(message);
    this.details = details;
  }
}

/** The gateway's own store API. */
export const LOCAL_STORE = "/api/store";

/**
 * STORE-3: the store API of the chosen project: the gateway's own, or a hub's, which the
 * gateway passes on. The app shows one project at a time, so every call goes to its store.
 */
let currentStore = LOCAL_STORE;

/** Chooses the store later calls go to: the gateway's own (`hub` null) or the named hub's. */
export function chooseStore(hub: string | null): void {
  currentStore = hub === null ? LOCAL_STORE : `/api/hubs/${encodeURIComponent(hub)}/store`;
}

/** A path of the chosen project's store API as a URL, e.g. for a link to a folder's file. */
export function storeUrl(path: string): string {
  return `${currentStore}${path}`;
}

/**
 * One store API call; the gateway answers `{ ok, data }` or `{ ok: false, error, ...details }`.
 * A Blob body (a file for a task's folder, FOLDER-1) goes as it is; any other as JSON. `store`
 * is the API's base, the chosen project's store unless given.
 */
export async function api<T>(method: string, path: string, body?: unknown, store = currentStore): Promise<T> {
  const json = body !== undefined && !(body instanceof Blob);
  const response = await fetch(`${store}${path}`, {
    method,
    headers: json ? { "content-type": "application/json" } : {},
    body: body instanceof Blob ? body : json ? JSON.stringify(body) : undefined,
  });
  const envelope = await response.json() as { ok: boolean; data?: T; error?: string; [key: string]: unknown };
  if (!envelope.ok) throw new ApiError(envelope.error ?? `${method} ${path} failed (${response.status})`, envelope);
  return envelope.data as T;
}

/**
 * Data that is re-read every `intervalMs` while mounted. `refresh` re-reads now, e.g. after a
 * change; `path` null means nothing to load yet. `store` is as for `api`; choosing another
 * store loads afresh.
 */
export function usePolled<T>(path: string | null, intervalMs: number, store = currentStore): { data: T | null; error: string | null; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    setData(null);
    setError(null);
  }, [path, store]);
  useEffect(() => {
    if (path === null) return;
    let cancelled = false;
    const load = () => {
      api<T>("GET", path, undefined, store).then(
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
  }, [path, store, intervalMs, tick]);
  return { data, error, refresh: () => setTick((value) => value + 1) };
}
