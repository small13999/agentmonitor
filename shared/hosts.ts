/**
 * PREVIEW-2: the UI and each task's preview are each their own origin, as flat hosts under one
 * zone, since Cloudflare's universal certificate covers one level only: `am.<zone>` is the UI,
 * `am-p-<task id>.<zone>` a task's preview. A hub's zone is the rest of its public origin after
 * `am.`; a local monitor's is `localhost`, whose names resolve on the browser's own machine, on
 * whatever port it uses.
 */

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const LABEL = new RegExp(`^(?:am|am-p-(${ID}))$`);
const LOCAL_HOST = /^([^.:]+)\.localhost(?::\d+)?$/;

export type HostRole = { kind: "ui" } | { kind: "preview"; taskId: string };

/** Where the hosts live: `protocol` as URL gives it (`https:`), and `port` empty for the protocol's own. */
export interface Zone {
  protocol: string;
  zone: string;
  port: string;
}

const LOCAL: Zone = { protocol: "http:", zone: "localhost", port: "" };

/** The zone of the UI at this origin (the app passes `location`): a hub's `am.<zone>`, else a local monitor's. */
export function zoneOf(ui: { protocol: string; hostname: string; port: string }): Zone {
  if (!ui.hostname.startsWith("am.")) return { ...LOCAL, protocol: ui.protocol, port: ui.port };
  return { protocol: ui.protocol, zone: ui.hostname.slice("am.".length), port: ui.port };
}

/** The gateway's zone: its public origin's, or for a local monitor `http://*.localhost`. */
export function gatewayZone(publicOrigin: string | null): Zone {
  return publicOrigin === null ? LOCAL : zoneOf(new URL(publicOrigin));
}

/** The origin of a host in the zone, without a trailing slash. */
export function hostOrigin(zone: Zone, role: HostRole): string {
  const label = role.kind === "ui" ? "am" : `am-p-${role.taskId}`;
  return `${zone.protocol}//${label}.${zone.zone}${zone.port === "" ? "" : `:${zone.port}`}`;
}

function labelRole(label: string): HostRole | null {
  const match = LABEL.exec(label);
  if (match === null) return null;
  if (match[1] !== undefined) return { kind: "preview", taskId: match[1] };
  return { kind: "ui" };
}

/**
 * What a request's Host header names. A hub knows its hosts exactly, and any other is none of
 * them (null). A local monitor takes `am-p-…` under `localhost` on any port, and every other
 * host as its UI.
 */
export function hostRole(host: string | undefined, publicOrigin: string | null): HostRole | null {
  const name = (host ?? "").toLowerCase();
  if (publicOrigin === null) {
    const local = LOCAL_HOST.exec(name);
    const role = local === null ? null : labelRole(local[1]);
    return role === null || role.kind === "ui" ? { kind: "ui" } : role;
  }
  const zone = gatewayZone(publicOrigin);
  const tail = `.${zone.zone}${zone.port === "" ? "" : `:${zone.port}`}`;
  return name.endsWith(tail) ? labelRole(name.slice(0, -tail.length)) : null;
}
