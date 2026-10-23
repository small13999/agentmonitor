import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { gatewayZone, hostOrigin, hostRole } from "../shared/hosts.ts";
import type { GatewayConfig } from "./config.ts";

export const SESSION_COOKIE = "__Host-agentmonitor";

/** Non-sensitive liveness probe; safe to exempt from authentication. */
export function isHealthPath(pathname: string): boolean {
  return pathname === "/api/health";
}

export function isAuthPath(pathname: string): boolean {
  return pathname === "/api/auth/status" || pathname === "/api/auth/login" || pathname === "/api/auth/logout";
}

interface BrowserSession {
  expiresAt: number;
}

export class AuthStore {
  private readonly secret: Buffer | null;
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly loginAttempts = new Map<string, number[]>();
  private readonly ttlMs: number;

  constructor(config: GatewayConfig) {
    this.ttlMs = config.sessionTtlMs;
    this.secret = config.loginSecretFile === null
      ? null
      : Buffer.from(readFileSync(config.loginSecretFile, "utf8").trim(), "utf8");
    // 16 bytes (128 bits) is far beyond online guessing against the
    // 10-attempts-per-10-minutes login rate limit; typable secrets welcome.
    if (this.secret !== null && this.secret.length < 16) {
      throw new Error("login secret must be at least 16 bytes");
    }
  }

  get enabled(): boolean {
    return this.secret !== null;
  }

  /**
   * Exact-origin check for cookie-authenticated state changes and upgrades: the page asking is
   * on the host it asks (shared/hosts.ts). No reflected Host in a hub: its hosts are known.
   */
  validOrigin(request: IncomingMessage, publicOrigin: string | null): boolean {
    const origin = request.headers.origin;
    const host = request.headers.host;
    if (publicOrigin === null) {
      // Local mode preserves the existing same-host Origin behavior.
      if (origin === undefined) return true;
      return host !== undefined && (origin === `http://${host}` || origin === `https://${host}`);
    }
    const role = hostRole(host, publicOrigin);
    return role !== null && origin === hostOrigin(gatewayZone(publicOrigin), role);
  }

  /** Exact-host check: chat, preview, and unknown hosts must never reach monitor APIs. */
  validHost(request: IncomingMessage, publicOrigin: string | null): boolean {
    return hostRole(request.headers.host, publicOrigin)?.kind === "ui";
  }

  sessionId(request: IncomingMessage): string | null {
    const header = request.headers.cookie;
    if (header === undefined) return null;
    for (const part of header.split(";")) {
      const index = part.indexOf("=");
      if (index === -1) continue;
      if (part.slice(0, index).trim() === SESSION_COOKIE) {
        const value = part.slice(index + 1).trim();
        if (/^[A-Za-z0-9_-]{43}$/.test(value)) return value;
        return null;
      }
    }
    return null;
  }

  isAuthenticated(request: IncomingMessage): boolean {
    if (this.secret === null) return true;
    const id = this.sessionId(request);
    if (id === null) return false;
    const session = this.sessions.get(id);
    if (session === undefined) return false;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      return false;
    }
    return true;
  }

  checkSecret(candidate: string): boolean {
    if (this.secret === null) return false;
    const buffer = Buffer.from(candidate, "utf8");
    if (buffer.length !== this.secret.length) return false;
    return timingSafeEqual(buffer, this.secret);
  }

  /** Sliding-window login rate limit per client IP. Returns false when limited. */
  allowLoginAttempt(clientIp: string): boolean {
    const now = Date.now();
    const windowStart = now - 10 * 60 * 1_000;
    const recent = (this.loginAttempts.get(clientIp) ?? []).filter((at) => at > windowStart);
    if (recent.length >= 10) {
      this.loginAttempts.set(clientIp, recent);
      return false;
    }
    recent.push(now);
    this.loginAttempts.set(clientIp, recent);
    return true;
  }

  createSession(response: ServerResponse): void {
    const id = randomBytes(32).toString("base64url");
    this.sessions.set(id, { expiresAt: Date.now() + this.ttlMs });
    response.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE}=${id}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(this.ttlMs / 1_000)}`,
    );
  }

  destroySession(request: IncomingMessage, response: ServerResponse): void {
    const id = this.sessionId(request);
    if (id !== null) this.sessions.delete(id);
    response.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
    );
  }

  /** Revoke every browser session, e.g. after secret rotation or logout-all. Test hook. */
  revokeAll(): void {
    this.sessions.clear();
  }
}
