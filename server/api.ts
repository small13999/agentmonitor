import type { IncomingMessage, ServerResponse } from "node:http";
import { isAuthPath, isHealthPath, type AuthStore } from "./auth.ts";
import type { GatewayConfig } from "./config.ts";
import { HUB_API_PREFIX, type Hubs } from "./hubs.ts";
import { handleStoreApi } from "./store/http.ts";
import type { StoreService } from "./store/service.ts";

export interface ApiDeps {
  config: GatewayConfig;
  auth: AuthStore;
  store: StoreService;
  /** STORE-3: the hubs whose projects this gateway lists beside its own. */
  hubs: Hubs;
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

async function readSecret(request: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 16 * 1024) return null;
    chunks.push(buffer);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof body === "object" && body !== null && "secret" in body && typeof body.secret === "string" ? body.secret : null;
  } catch {
    return null;
  }
}

function clientIp(request: IncomingMessage): string {
  const forwarded = request.headers["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",", 1)[0];
  return (first ?? request.socket.remoteAddress ?? "unknown").trim();
}

/**
 * The monitor's API, shared by the Vite dev plugin and the standalone server: health, login
 * (remote mode), and the store. Returns true when the request was handled.
 */
export async function handleApi(request: IncomingMessage, response: ServerResponse, deps: ApiDeps): Promise<boolean> {
  const { pathname, search } = new URL(request.url ?? "/", "http://localhost");
  const stores = pathname === "/api/stores" || pathname.startsWith(HUB_API_PREFIX);
  if (!isHealthPath(pathname) && !isAuthPath(pathname) && !pathname.startsWith("/api/store/") && !stores) return false;
  const { config, auth, store, hubs } = deps;

  // Only the monitor's own host reaches its API; a Tern host or any other answers as unknown.
  if (!auth.validHost(request, config.publicOrigin)) {
    sendJson(response, 404, { ok: false, error: "unknown endpoint" });
    return true;
  }
  if (request.method === "GET" && isHealthPath(pathname)) {
    sendJson(response, 200, { ok: true, data: { machine: config.machineName, auth: auth.enabled } });
    return true;
  }

  try {
    if (request.method === "GET" && pathname === "/api/auth/status") {
      sendJson(response, 200, { ok: true, data: { authenticated: auth.isAuthenticated(request) } });
      return true;
    }
    if (request.method === "POST" && pathname === "/api/auth/login") {
      if (config.publicOrigin !== null && !auth.validOrigin(request, config.publicOrigin)) {
        sendJson(response, 403, { ok: false, error: "forbidden origin" });
        return true;
      }
      if (!auth.allowLoginAttempt(clientIp(request))) {
        sendJson(response, 429, { ok: false, error: "too many login attempts" });
        return true;
      }
      const secret = await readSecret(request);
      if (secret === null || secret === "" || !auth.checkSecret(secret)) {
        sendJson(response, 401, { ok: false, error: "invalid secret" });
        return true;
      }
      auth.createSession(response);
      sendJson(response, 200, { ok: true, data: { authenticated: true } });
      return true;
    }
    if (request.method === "POST" && pathname === "/api/auth/logout") {
      auth.destroySession(request, response);
      sendJson(response, 200, { ok: true, data: { authenticated: false } });
      return true;
    }

    if (!auth.isAuthenticated(request)) {
      sendJson(response, 401, { ok: false, error: "authentication required" });
      return true;
    }
    if (pathname.startsWith("/api/store/") || stores) {
      if (request.method !== "GET" && !auth.validOrigin(request, config.publicOrigin)) {
        sendJson(response, 403, { ok: false, error: "cross-origin mutation refused" });
        return true;
      }
      // STORE-3: the gateway's own projects, then each hub's.
      if (request.method === "GET" && pathname === "/api/stores") {
        const own = { hub: null, name: config.machineName, url: null, projects: store.store.listProjects(store.store.ownerPrincipal()), unavailable: null };
        sendJson(response, 200, { ok: true, data: [own, ...(await hubs.listings())] });
        return true;
      }
      if (await hubs.handle(request, response, pathname, search)) return true;
      if (pathname.startsWith("/api/store/")) {
        // PERSON-1: until login exists every human request is the store's owner.
        await handleStoreApi(request, response, store, store.store.ownerPrincipal());
        return true;
      }
    }
    sendJson(response, 404, { ok: false, error: "unknown endpoint" });
    return true;
  } catch (cause) {
    console.error("api request failed", cause);
    if (!response.headersSent) sendJson(response, 500, { ok: false, error: "internal error" });
    else response.destroy();
    return true;
  }
}
