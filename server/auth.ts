import type { IncomingMessage, ServerResponse } from "node:http";
import { gatewayZone, hostOrigin, hostRole } from "../shared/hosts.ts";
import { AccessVerifier } from "./access.ts";
import type { GatewayConfig } from "./config.ts";
import type { Principal, Store } from "./store/store.ts";

/** Who a request is: a person of the store, or refused with why. */
export type Visitor = { kind: "person"; principal: Principal } | { kind: "refused"; status: 401 | 403 | 503; reason: string };

/** Non-sensitive liveness probe; safe to exempt from authentication. */
export function isHealthPath(pathname: string): boolean {
  return pathname === "/api/health";
}

/** The Access token: the header Cloudflare's edge sets on every request through the tunnel, else its cookie. */
function accessToken(request: IncomingMessage): string | null {
  const header = request.headers["cf-access-jwt-assertion"];
  if (typeof header === "string" && header !== "") return header;
  for (const part of request.headers.cookie?.split(";") ?? []) {
    const index = part.indexOf("=");
    if (index !== -1 && part.slice(0, index).trim() === "CF_Authorization") return part.slice(index + 1).trim();
  }
  return null;
}

/**
 * Decides who every request to the gateway is: the store API, the app, Tern hosts.
 * Local mode is the user's PC, where every request is the owner. Access mode (AUTH-1,
 * AUTH-2) takes the person whose email a valid Cloudflare Access token names.
 */
export class Auth {
  private readonly store: Store;
  private readonly access: AccessVerifier | null;

  constructor(config: Pick<GatewayConfig, "access">, store: Store) {
    this.store = store;
    this.access = config.access === null ? null : new AccessVerifier(config.access);
  }

  async identify(request: IncomingMessage): Promise<Visitor> {
    if (this.access === null) return { kind: "person", principal: this.store.ownerPrincipal() };
    const token = accessToken(request);
    if (token === null) return { kind: "refused", status: 401, reason: "no Cloudflare Access token: sign in through Cloudflare Access" };
    const verified = await this.access.verify(token);
    if (!verified.ok) return { kind: "refused", status: verified.status, reason: verified.reason };
    const principal = this.store.personByEmail(verified.email);
    if (principal === null) {
      return { kind: "refused", status: 403, reason: `${verified.email} is not a person of this hub: ask its owner to add you` };
    }
    return { kind: "person", principal };
  }
}

/**
 * Same-host Origin check for state changes and socket upgrades; requests without Origin (CLIs)
 * pass. A hub knows its hosts (shared/hosts.ts): the Origin is the request's own host's, and
 * a host that is none of the hub's is refused.
 */
export function validOrigin(request: IncomingMessage, publicOrigin: string | null): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  const host = request.headers.host;
  if (publicOrigin === null) return host !== undefined && (origin === `http://${host}` || origin === `https://${host}`);
  const role = hostRole(host, publicOrigin);
  return role !== null && origin === hostOrigin(gatewayZone(publicOrigin), role);
}

/** Whether the request is for the UI's host: chat, preview, and unknown hosts never reach the monitor's API or app. */
export function validHost(request: IncomingMessage, publicOrigin: string | null): boolean {
  return hostRole(request.headers.host, publicOrigin)?.kind === "ui";
}

/** A page that says why the request was refused, for what a browser opens (the app, a Tern host). */
export function sendRefusal(response: ServerResponse, visitor: Extract<Visitor, { kind: "refused" }>): void {
  const reason = visitor.reason.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
  response.writeHead(visitor.status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Agent Monitor</title></head><body><h1>Agent Monitor</h1><p>Refused: ${reason}.</p></body></html>\n`);
}
