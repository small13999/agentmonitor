import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { handleApi, sendJson } from "./api.ts";
import { Auth, sendRefusal, validHost } from "./auth.ts";
import { loadConfig } from "./config.ts";
import { handlePreview } from "./previews.ts";
import { StoreService } from "./store/service.ts";
import { TernProxy } from "./tern-proxy.ts";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** The built web app; any path without a file extension is the app (its routes are hash routes). */
async function serveStatic(request: IncomingMessage, response: ServerResponse, distDir: string): Promise<boolean> {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const url = new URL(request.url ?? "/", "http://localhost");
  let path = normalize(resolve(distDir, `.${sep}${decodeURIComponent(url.pathname)}`));
  if (path !== distDir && !path.startsWith(distDir + sep)) return false;
  try {
    if ((await stat(path)).isDirectory()) path = join(path, "index.html");
  } catch {
    if (extname(path) !== "") return false;
    path = join(distDir, "index.html");
  }
  try {
    const body = await readFile(path);
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": CONTENT_TYPES[extname(path)] ?? "application/octet-stream",
      "content-length": body.length,
    });
    if (request.method === "GET") response.end(body);
    else response.end();
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new StoreService(config.stateDir, config);
  await store.start();
  const auth = new Auth(config, store.store);
  const tern = new TernProxy({ config, auth, store });
  const distDir = resolve(process.cwd(), "dist");
  const bindHost = process.env.AGENTMONITOR_BIND_HOST ?? "127.0.0.1";

  const server = createServer(async (request, response) => {
    try {
      // Chat and preview hosts first: they are sessions' chats and tasks' previews, not the monitor.
      if (await tern.handleRequest(request, response)) return;
      if (await handlePreview(request, response, { config, auth })) return;
      if (await handleApi(request, response, { config, auth, store })) return;
      const visitor = await auth.identify(request);
      if (visitor.kind === "refused") {
        sendRefusal(response, visitor);
        return;
      }
      if (validHost(request, config.publicOrigin) && (await serveStatic(request, response, distDir))) return;
      sendJson(response, 404, { ok: false, error: "unknown endpoint" });
    } catch (cause) {
      console.error("gateway request failed", cause);
      if (!response.headersSent) sendJson(response, 500, { ok: false, error: "internal error" });
      else response.destroy();
    }
  });

  server.on("upgrade", (request, socket, head) => {
    tern.handleUpgrade(request, socket, head).then(
      (handled) => { if (!handled) socket.destroy(); },
      (cause: unknown) => {
        console.error("upgrade handling failed", cause);
        socket.destroy();
      },
    );
  });

  server.listen(config.port, bindHost, () => {
    console.log(`agentmonitor gateway (${config.authMode}) on http://${bindHost}:${config.port}`);
  });
}

main().catch((cause) => {
  console.error(`gateway startup failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exitCode = 1;
});
