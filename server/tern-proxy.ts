import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import httpProxy from "http-proxy";
import { hostRole } from "../shared/hosts.ts";
import { sendRefusal, validOrigin, type Auth } from "./auth.ts";
import type { GatewayConfig } from "./config.ts";
import type { StoreService } from "./store/service.ts";
import { StoreError } from "./store/store.ts";

/** The image names Tern's script and wasm with a content version (container/tern-web-assets.ts). */
const VERSIONED_ASSET = /^\/pkg\/[^?]+\?v=[0-9a-f]+$/;
/** Tern's fallback fonts for characters its built-in faces lack: `/fonts?chars=…` names them, `/fonts/<id>` serves one. */
const FONTS = /^\/fonts(?:\/|$)/;
/**
 * Tern 0.9.2's daemon is slow to bring up a web client that connects within about two
 * seconds of the previous client leaving: its chat takes some 11 s to show instead of 2.
 * A reload does exactly that, so a session's next socket waits out this much after the last one closed.
 */
const RECONNECT_SETTLE_MS = 3_000;
/** The browser's credentials for the gateway; an agent in the container could act as the person with them. */
const CREDENTIAL_HEADERS = ["cookie", "authorization", "cf-access-jwt-assertion"];

export interface TernProxyDeps {
  config: Pick<GatewayConfig, "publicOrigin">;
  auth: Auth;
  store: StoreService;
}

function reject(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * Each session's Tern web client on its own host, the session's chat host `am-t-<session id>`
 * (shared/hosts.ts), since Tern's page loads everything from root paths. The gateway checks who the browser is
 * (AUTH-1) and adds what the container's `tern web serve` asks for, the token on /wire and
 * /fonts and the origin it accepts, so neither reaches the browser; the browser's
 * credentials, its cookies and Access token, never reach the container.
 *
 * Tern sends every file uncacheable; the versioned script and wasm are marked immutable
 * instead. Chrome keeps the script but refetches the 60 MB wasm, likely over its cache's entry limit.
 */
export class TernProxy {
  private readonly deps: TernProxyDeps;
  private readonly proxy = httpProxy.createProxyServer({ changeOrigin: true });
  /** When each session's last Tern socket closed. */
  private readonly socketClosed = new Map<string, number>();

  constructor(deps: TernProxyDeps) {
    this.deps = deps;
    this.proxy.on("proxyReq", (proxyRequest) => {
      for (const name of CREDENTIAL_HEADERS) proxyRequest.removeHeader(name);
    });
    this.proxy.on("proxyReqWs", (proxyRequest) => {
      for (const name of CREDENTIAL_HEADERS) proxyRequest.removeHeader(name);
    });
    this.proxy.on("proxyRes", (proxyResponse, request) => {
      if (proxyResponse.statusCode === 200 && VERSIONED_ASSET.test(request.url ?? "")) {
        proxyResponse.headers["cache-control"] = "public, max-age=31536000, immutable";
      }
    });
  }

  private sessionId(request: IncomingMessage): string | null {
    const role = hostRole(request.headers.host, this.deps.config.publicOrigin);
    return role?.kind === "chat" ? role.sessionId : null;
  }

  /** Serves a request for a Tern host; false for every other host. */
  async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const sessionId = this.sessionId(request);
    if (sessionId === null) return false;
    const fail = (status: number, message: string) => {
      response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
      response.end(message);
    };
    const visitor = await this.deps.auth.identify(request);
    if (visitor.kind === "refused") {
      sendRefusal(response, visitor);
      return true;
    }
    // Tern serves fonts to its own page only; a page of another site gets no token added.
    if (FONTS.test(new URL(request.url ?? "/", "http://localhost").pathname) && !validOrigin(request, this.deps.config.publicOrigin)) {
      fail(403, "This origin may not read Tern's fonts.");
      return true;
    }
    try {
      await this.forward(sessionId, request, response, true);
    } catch (cause) {
      if (!(cause instanceof StoreError)) throw cause;
      fail(cause.status, cause.message);
    }
    return true;
  }

  /** A remembered address can be stale (the container was started again): forget it and retry once. */
  private async forward(sessionId: string, request: IncomingMessage, response: ServerResponse, retry: boolean): Promise<void> {
    const upstream = await this.deps.store.ternUpstream(sessionId);
    const raw = request.url ?? "/";
    const mark = raw.indexOf("?");
    const path = mark === -1 ? raw : raw.slice(0, mark);
    if (FONTS.test(path)) {
      // Appended to the raw query: serializing it again would encode the commas in `chars=`.
      const params = mark === -1 ? [] : raw.slice(mark + 1).split("&").filter((param) => param !== "" && !param.startsWith("token="));
      request.url = `${path}?${[...params, `token=${encodeURIComponent(upstream.token)}`].join("&")}`;
      if (request.headers.origin !== undefined) request.headers.origin = upstream.origin;
    }
    this.proxy.web(request, response, { target: `http://${upstream.address}` }, (error) => {
      this.deps.store.forgetTernUpstream(sessionId);
      if (retry && !response.headersSent && request.method === "GET") {
        this.forward(sessionId, request, response, false).catch((cause: unknown) => {
          response.writeHead(cause instanceof StoreError ? cause.status : 502, { "content-type": "text/plain; charset=utf-8" });
          response.end(cause instanceof StoreError ? cause.message : "Tern is unavailable.");
        });
        return;
      }
      console.error("Tern proxy failed", error);
      if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      response.end("Tern is unavailable.");
    });
  }

  /** Proxies Tern's /wire socket for a Tern host; false for every other host. */
  async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> {
    const sessionId = this.sessionId(request);
    if (sessionId === null) return false;
    const visitor = await this.deps.auth.identify(request);
    if (visitor.kind === "refused") reject(socket, visitor.status, "Refused");
    // Pages of other sites must not drive the session from the user's browser.
    else if (request.headers.origin === undefined || !validOrigin(request, this.deps.config.publicOrigin)) reject(socket, 403, "Forbidden");
    else if (new URL(request.url ?? "/", "http://localhost").pathname !== "/wire") reject(socket, 404, "Not Found");
    else {
      try {
        const settle = (this.socketClosed.get(sessionId) ?? 0) + RECONNECT_SETTLE_MS - Date.now();
        if (settle > 0) await sleep(settle);
        if (socket.destroyed) return true;
        socket.on("close", () => this.socketClosed.set(sessionId, Date.now()));
        const upstream = await this.deps.store.ternUpstream(sessionId);
        request.url = `/wire?token=${encodeURIComponent(upstream.token)}`;
        request.headers.origin = upstream.origin;
        // http-proxy closes the socket after a failure, so this one fails; the page's next
        // load finds the container again.
        this.proxy.ws(request, socket, head, { target: `http://${upstream.address}` }, (error) => {
          this.deps.store.forgetTernUpstream(sessionId);
          console.error("Tern proxy failed", error);
        });
      } catch (cause) {
        if (!(cause instanceof StoreError)) throw cause;
        reject(socket, cause.status, "Unavailable");
      }
    }
    return true;
  }
}
