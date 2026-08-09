import type { SessionProfile } from "./model";

export interface ManagedSession {
  id: string;
  title: string;
  runtime_state: string;
  monitor_websocket_url: string;
  cmux_token: string;
  web_url: string;
  app_url: string;
  memory_limit_bytes: number;
  compose_project: string;
}

export interface SessionResources {
  id: string;
  runtimeState: string;
  memoryUsageBytes: number | null;
  memoryLimitBytes: number;
}

export interface SystemResources {
  collectedAtEpochMs: number;
  host: {
    memoryTotalBytes: number;
    memoryAvailableBytes: number;
    memoryUsedBytes: number;
    swapTotalBytes: number;
    swapUsedBytes: number;
  };
  sessions: SessionResources[];
  collectionError?: string;
}

interface AgentctlEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
  requiresForce?: boolean;
}

async function request<T>(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  const result = await response.json() as AgentctlEnvelope<T>;
  if (!response.ok || !result.ok || result.data === undefined) {
    const error = new Error(result.error ?? `request failed with HTTP ${response.status}`);
    Object.assign(error, { requiresForce: result.requiresForce === true });
    throw error;
  }
  return result.data;
}

export async function listManagedSessions() {
  const data = await request<{ sessions: ManagedSession[] }>("/api/agentctl/sessions");
  return data.sessions;
}

export function getSystemResources() {
  return request<SystemResources>("/api/system/resources");
}

export function createManagedSession(title: string) {
  return request<ManagedSession>("/api/agentctl/sessions", {
    method: "POST",
    body: JSON.stringify({ title }),
  });
}

export function resumeManagedSession(id: string) {
  return request<ManagedSession>(`/api/agentctl/sessions/${encodeURIComponent(id)}/resume`, {
    method: "POST",
    body: "{}",
  });
}

export function pauseManagedSession(id: string, force = false) {
  return request<{ id: string; action: string }>(
    `/api/agentctl/sessions/${encodeURIComponent(id)}/pause`,
    { method: "POST", body: JSON.stringify({ force }) },
  );
}

export function managedSessionProfile(session: ManagedSession): SessionProfile {
  return {
    workingDirectory: "/workspace/draftcoach",
    id: session.id,
    name: session.title || session.id,
    websocketUrl: session.monitor_websocket_url,
    token: session.cmux_token,
  };
}

export function requiresForce(error: unknown) {
  return error instanceof Error
    && "requiresForce" in error
    && (error as Error & { requiresForce: unknown }).requiresForce === true;
}
