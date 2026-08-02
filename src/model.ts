import type { Id, Tree } from "cmux/browser";

export interface SessionProfile {
  id: string;
  name: string;
  websocketUrl: string;
  token: string;
  workingDirectory?: string;
}

export interface MachineProfile {
  id: string;
  name: string;
  sessions: SessionProfile[];
}

export interface ServiceSlot {
  id: "port-1" | "port-2";
  name: string;
}

export const SERVICE_SLOTS: ServiceSlot[] = [
  { id: "port-1", name: "Port 1" },
  { id: "port-2", name: "Port 2" },
];

export function serviceUrl(sessionId: string, slotId: ServiceSlot["id"]) {
  const { hostname, port, protocol } = window.location;
  const gatewayHost = hostname === "127.0.0.1" || hostname === "::1" ? "localhost" : hostname;
  const authority = port === "" ? `${slotId}.${sessionId}.${gatewayHost}` : `${slotId}.${sessionId}.${gatewayHost}:${port}`;
  return `${protocol}//${authority}/`;
}

export interface TerminalView {
  key: string;
  surface: Id;
  pane: Id;
  internalWorkspace: string;
  screen: string;
  paneName: string;
  tab: string;
}

export interface SessionView {
  terminals: TerminalView[];
  mainTerminal: TerminalView | null;
}

export const DEFAULT_MACHINE: MachineProfile = {
  id: "local-agentctl",
  name: "Local machine",
  sessions: [],
};

const MACHINES_STORAGE_KEY = "agentmonitor.machines.v3";

function validSession(value: unknown): value is SessionProfile {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string"
    && typeof candidate.name === "string"
    && typeof candidate.websocketUrl === "string"
    && typeof candidate.token === "string";
}

export function loadMachines(): MachineProfile[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(MACHINES_STORAGE_KEY) ?? "null") as unknown;
    if (!Array.isArray(parsed)) return [DEFAULT_MACHINE];
    const machines = parsed.filter((item): item is MachineProfile => {
      if (typeof item !== "object" || item === null) return false;
      const candidate = item as Record<string, unknown>;
      return typeof candidate.id === "string"
        && typeof candidate.name === "string"
        && Array.isArray(candidate.sessions)
        && candidate.sessions.every(validSession);
    });
    return machines.length === 0 ? [DEFAULT_MACHINE] : machines;
  } catch {
    return [DEFAULT_MACHINE];
  }
}

export function saveMachines(machines: MachineProfile[]) {
  localStorage.setItem(MACHINES_STORAGE_KEY, JSON.stringify(machines));
}

export function projectSession(tree: Tree | null): SessionView {
  if (tree === null) return { terminals: [], mainTerminal: null };
  const terminals: TerminalView[] = [];
  let mainTerminal: TerminalView | null = null;
  for (const workspace of tree.workspaces) {
    for (const screen of workspace.screens) {
      for (const pane of screen.panes) {
        if ("dead" in pane) continue;
        for (const [index, tab] of pane.tabs.entries()) {
          if (tab.kind !== "pty" || tab.dead) continue;
          const terminal = {
            key: String(tab.surface),
            surface: tab.surface,
            pane: pane.id,
            internalWorkspace: workspace.name || `cmux workspace ${workspace.id}`,
            screen: screen.name || `screen ${screen.id}`,
            paneName: pane.name || `pane ${pane.id}`,
            tab: tab.name || tab.title || `terminal ${index + 1}`,
          };
          terminals.push(terminal);
          if (mainTerminal === null || (workspace.name === "main" && mainTerminal.internalWorkspace !== "main")) {
            mainTerminal = terminal;
          }
        }
      }
    }
  }
  return { terminals, mainTerminal };
}
