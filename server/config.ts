import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export type AuthMode = "local" | "access";

/** AUTH-1: the Cloudflare Access application whose tokens the hub accepts. */
export interface AccessConfig {
  /** The team domain, which issues the tokens, e.g. https://draftcoach.cloudflareaccess.com; its keys are at /cdn-cgi/access/certs. */
  teamDomain: string;
  /** The Access application's audience tag. */
  audience: string;
}

export interface GatewayConfig {
  /** "local": the user's PC, every request is the owner; "access": Cloudflare Access tokens decide who a request is. */
  authMode: AuthMode;
  /** Access mode only. */
  access: AccessConfig | null;
  /** The store owner's email (AUTH-2), lower-cased; required in access mode. */
  ownerEmail: string | null;
  /**
   * The UI's exact origin, e.g. https://am.draftcoach.gg; chat and preview hosts derive from it
   * (shared/hosts.ts). Required in access mode; without it, the local naming under localhost.
   */
  publicOrigin: string | null;
  /** Display name for this machine's gateway. */
  machineName: string;
  /** Gateway state dir: store, session worktrees and run directories. Default ~/.local/state/agentmonitor. */
  stateDir: string;
  /** "podman" launches a container per workspace; "none" keeps records only (store tests). */
  workspaceRuntime: "podman" | "none";
  /** Memory limit of each workspace container. */
  workspaceMemoryMib: number;
  /** Port the gateway listens on. */
  port: number;
  /** The omp agent directory whose credentials (agent.db) and providers (models.db, models.yml) workspaces use. */
  ompAgentDir: string;
  /** Home whose ~/.ssh, ~/.gitconfig and ~/.config/gh session containers get copies of. */
  credentialsHome: string;
  /** Agent Monitor's own settings, e.g. cloudflare/<project>.env. Default ~/.config/agentmonitor. */
  configDir: string;
  /** Cloudflare's API origin, which the gateway's Cloudflare broker forwards agents' requests to. */
  cloudflareApi: string;
}

/** People's emails are compared case-insensitively: the store keeps them lower-cased. */
export const email = z.email().max(320).transform((value) => value.toLowerCase());

function positiveInt(raw: string | undefined, name: string): number {
  if (raw === undefined) throw new Error(`${name} is required`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer in MiB`);
  return value;
}

function workspaceRuntime(raw: string | undefined): GatewayConfig["workspaceRuntime"] {
  if (raw === undefined || raw === "podman") return "podman";
  if (raw === "none") return "none";
  throw new Error(`AGENTMONITOR_WORKSPACE_RUNTIME must be "podman" or "none"`);
}

function gatewayPort(raw: string | undefined): number {
  const port = Number(raw ?? "4173");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("AGENTMONITOR_PORT must be a valid port");
  return port;
}

/** The team domain's origin; https, or http on loopback for a local fake issuer. */
function teamDomain(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("AGENTMONITOR_ACCESS_TEAM_DOMAIN must be an absolute URL");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("AGENTMONITOR_ACCESS_TEAM_DOMAIN must be https:");
  }
  return url.origin;
}

function ownerEmail(raw: string | undefined): string | null {
  if (raw === undefined || raw === "") return null;
  const parsed = email.safeParse(raw.trim());
  if (!parsed.success) throw new Error("AGENTMONITOR_OWNER_EMAIL must be an email address");
  return parsed.data;
}

/** The UI's origin: host `am.<zone>`, https except under `localhost`, which resolves on the browser's machine. */
function publicOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("AGENTMONITOR_PUBLIC_ORIGIN must be an absolute URL");
  }
  // The UI is `am.<zone>`; chats and previews are `am-t-…` and `am-p-…` beside it.
  if (!url.hostname.startsWith("am.")) throw new Error("AGENTMONITOR_PUBLIC_ORIGIN must name the host am.<zone>");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname.endsWith(".localhost"))) {
    throw new Error("AGENTMONITOR_PUBLIC_ORIGIN must be https:");
  }
  return url.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const authMode = env.AGENTMONITOR_AUTH_MODE ?? "local";
  if (authMode !== "local" && authMode !== "access") {
    throw new Error(`AGENTMONITOR_AUTH_MODE must be "local" or "access"`);
  }
  const owner = ownerEmail(env.AGENTMONITOR_OWNER_EMAIL);
  const origin = env.AGENTMONITOR_PUBLIC_ORIGIN ? publicOrigin(env.AGENTMONITOR_PUBLIC_ORIGIN) : null;
  let access: AccessConfig | null = null;
  if (authMode === "access") {
    const domain = env.AGENTMONITOR_ACCESS_TEAM_DOMAIN;
    const audience = env.AGENTMONITOR_ACCESS_AUD;
    if (!domain || !audience || owner === null || origin === null) {
      throw new Error("access mode requires AGENTMONITOR_ACCESS_TEAM_DOMAIN, AGENTMONITOR_ACCESS_AUD, AGENTMONITOR_OWNER_EMAIL and AGENTMONITOR_PUBLIC_ORIGIN");
    }
    access = { teamDomain: teamDomain(domain), audience };
  }
  return {
    authMode,
    access,
    ownerEmail: owner,
    publicOrigin: origin,
    machineName: env.AGENTMONITOR_MACHINE_NAME ?? "Agent Monitor",
    stateDir: env.AGENTMONITOR_STATE_DIR || join(homedir(), ".local", "state", "agentmonitor"),
    workspaceRuntime: workspaceRuntime(env.AGENTMONITOR_WORKSPACE_RUNTIME),
    workspaceMemoryMib: env.AGENTMONITOR_WORKSPACE_MEMORY_MIB === undefined
      ? 5120
      : positiveInt(env.AGENTMONITOR_WORKSPACE_MEMORY_MIB, "AGENTMONITOR_WORKSPACE_MEMORY_MIB"),
    port: gatewayPort(env.AGENTMONITOR_PORT),
    ompAgentDir: env.AGENTMONITOR_OMP_AGENT_DIR ?? join(homedir(), ".omp", "agent"),
    credentialsHome: env.AGENTMONITOR_CREDENTIALS_HOME ?? homedir(),
    configDir: env.AGENTMONITOR_CONFIG_DIR ?? join(homedir(), ".config", "agentmonitor"),
    cloudflareApi: env.AGENTMONITOR_CLOUDFLARE_API ?? "https://api.cloudflare.com",
  };
}
