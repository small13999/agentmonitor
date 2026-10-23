import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type AuthMode = "local" | "remote-cookie";

export interface GatewayConfig {
  /** "local" preserves current open-loopback behavior; "remote-cookie" requires login. */
  authMode: AuthMode;
  /** Exact public origin of the UI, e.g. https://am.draftcoach.gg; chat and preview hosts derive from it (shared/hosts.ts). */
  publicOrigin: string | null;
  /** Path to the 0600 login-secret file. Remote mode only; env carries the path, never the value. */
  loginSecretFile: string | null;
  /** Opaque session TTL. */
  sessionTtlMs: number;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const authMode = env.AGENTMONITOR_AUTH_MODE ?? "local";
  if (authMode !== "local" && authMode !== "remote-cookie") {
    throw new Error(`AGENTMONITOR_AUTH_MODE must be "local" or "remote-cookie"`);
  }
  const remote = authMode === "remote-cookie";
  const configuredOrigin = env.AGENTMONITOR_PUBLIC_ORIGIN ?? null;
  const loginSecretFile = env.AGENTMONITOR_LOGIN_SECRET_FILE ?? null;
  if (remote && (configuredOrigin === null || loginSecretFile === null)) {
    throw new Error("remote-cookie mode requires AGENTMONITOR_PUBLIC_ORIGIN and AGENTMONITOR_LOGIN_SECRET_FILE");
  }
  let publicOrigin: string | null = null;
  if (configuredOrigin !== null) {
    let origin: URL;
    try {
      origin = new URL(configuredOrigin);
    } catch {
      throw new Error("AGENTMONITOR_PUBLIC_ORIGIN must be an absolute URL");
    }
    // The UI is `am.<zone>`; chats and previews are `am-t-…` and `am-p-…` beside it.
    if (!origin.hostname.startsWith("am.")) throw new Error("AGENTMONITOR_PUBLIC_ORIGIN must name the host am.<zone>");
    if (remote && origin.protocol !== "https:") throw new Error("AGENTMONITOR_PUBLIC_ORIGIN must be https:");
    publicOrigin = origin.origin;
  }
  if (remote) {
    // Fail closed on a world/group-readable secret file at startup.
    const mode = statSync(loginSecretFile as string).mode & 0o777;
    if (mode & 0o077) {
      throw new Error(`login secret file must not be group/world-accessible (mode ${mode.toString(8)})`);
    }
    readFileSync(loginSecretFile as string); // readable by this process, checked before serving
  }
  return {
    authMode,
    publicOrigin,
    loginSecretFile,
    sessionTtlMs: 24 * 60 * 60 * 1_000,
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
