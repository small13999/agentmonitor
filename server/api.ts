import type { IncomingMessage, ServerResponse } from "node:http";
import { isHealthPath, validHost, validOrigin, type Auth } from "./auth.ts";
import type { GatewayConfig } from "./config.ts";
import { HUB_API_PREFIX, type Hubs } from "./hubs.ts";
import { handleStoreApi } from "./store/http.ts";
import type { StoreService } from "./store/service.ts";

export interface ApiDeps {
  config: GatewayConfig;
  auth: Auth;
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

/**
 * The monitor's API, shared by the Vite dev plugin and the standalone server: health and the
 * store. Returns true when the request was handled.
 */
export async function handleApi(request: IncomingMessage, response: ServerResponse, deps: ApiDeps): Promise<boolean> {
  const { pathname, search } = new URL(request.url ?? "/", "http://localhost");
  const stores = pathname === "/api/stores" || pathname.startsWith(HUB_API_PREFIX);
  if (!isHealthPath(pathname) && !pathname.startsWith("/api/store/") && !stores) return false;
  const { config, auth, store, hubs } = deps;

  // Only the monitor's own host reaches its API; a preview or unknown host answers as unknown.
  if (!validHost(request, config.publicOrigin)) {
    sendJson(response, 404, { ok: false, error: "unknown endpoint" });
    return true;
  }
  if (request.method === "GET" && isHealthPath(pathname)) {
    sendJson(response, 200, { ok: true, data: { machine: config.machineName, auth: config.authMode } });
    return true;
  }

  try {
    const visitor = await auth.identify(request);
    if (visitor.kind === "refused") {
      sendJson(response, visitor.status, { ok: false, error: visitor.reason });
      return true;
    }
    if (pathname.startsWith("/api/store/") || stores) {
      if (request.method !== "GET" && !validOrigin(request, config.publicOrigin)) {
        sendJson(response, 403, { ok: false, error: "cross-origin mutation refused" });
        return true;
      }
      // STORE-3: the gateway's own projects, then each hub's.
      if (request.method === "GET" && pathname === "/api/stores") {
        const own = { hub: null, name: config.machineName, url: null, projects: store.store.listProjects(visitor.principal), unavailable: null };
        sendJson(response, 200, { ok: true, data: [own, ...(await hubs.listings())] });
        return true;
      }
      if (await hubs.handle(request, response, pathname, search)) return true;
      if (pathname.startsWith("/api/store/")) {
        await handleStoreApi(request, response, store, visitor.principal);
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
