import type { IncomingMessage, ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import httpProxy from "http-proxy";
import { defineConfig } from "vite";
import type { Plugin, PreviewServer, ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";

type ServiceTarget = string | { host: string; protocol: "http:"; socketPath: string };

interface AgentctlSession {
  id: string;
  web_host_port: number;
  app_host_port: number;
}

interface AgentctlEnvelope {
  ok: boolean;
  data?: { sessions?: AgentctlSession[] };
  error?: string;
}

const execFileAsync = promisify(execFile);
const agentctlCwd = process.env.AGENTMONITOR_AGENTCTL_CWD
  ?? resolve(homedir(), "projects/draftcoach");
const socketTarget = (sessionId: string, slotId: string): ServiceTarget => ({
  host: "localhost",
  protocol: "http:",
  socketPath: resolve(`prototype/sessions/${sessionId}/state/service-${slotId}.sock`),
});
const prototypeTargets: Record<string, ServiceTarget> = {
  "port-1.workspace-1.localhost": process.env.AGENTMONITOR_WORKSPACE_1_PORT_1_TARGET ?? socketTarget("workspace-1", "port-1"),
  "port-2.workspace-1.localhost": process.env.AGENTMONITOR_WORKSPACE_1_PORT_2_TARGET ?? socketTarget("workspace-1", "port-2"),
  "port-1.workspace-2.localhost": process.env.AGENTMONITOR_WORKSPACE_2_PORT_1_TARGET ?? socketTarget("workspace-2", "port-1"),
  "port-2.workspace-2.localhost": process.env.AGENTMONITOR_WORKSPACE_2_PORT_2_TARGET ?? socketTarget("workspace-2", "port-2"),
};

async function runAgentctl(args: string[]) {
  try {
    const { stdout } = await execFileAsync("agentctl", ["--json", ...args], {
      cwd: agentctlCwd,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
    });
    return JSON.parse(stdout) as AgentctlEnvelope;
  } catch (cause) {
    const error = cause as Error & { stdout?: string };
    if (error.stdout) {
      try {
        return JSON.parse(error.stdout) as AgentctlEnvelope;
      } catch {
        // Use the process error below.
      }
    }
    return { ok: false, error: error.message };
  }
}

let sessionCache: { expiresAt: number; sessions: AgentctlSession[] } | null = null;

async function agentctlSessions(refresh = false) {
  if (!refresh && sessionCache !== null && sessionCache.expiresAt > Date.now()) {
    return sessionCache.sessions;
  }
  const result = await runAgentctl(["list"]);
  if (!result.ok) throw new Error(result.error ?? "agentctl list failed");
  const sessions = result.data?.sessions ?? [];
  sessionCache = { expiresAt: Date.now() + 2_000, sessions };
  return sessions;
}

function serviceAddress(host: string | undefined) {
  return host?.split(":")[0].toLowerCase() ?? "";
}

async function serviceTarget(host: string | undefined) {
  const address = serviceAddress(host);
  const prototypeTarget = prototypeTargets[address];
  if (prototypeTarget !== undefined) return prototypeTarget;
  const match = /^(port-[12])\.([a-z0-9]+(?:-[a-z0-9]+)*)\.localhost$/.exec(address);
  if (match === null) return undefined;
  const session = (await agentctlSessions()).find((candidate) => candidate.id === match[2]);
  if (session === undefined) return undefined;
  const port = match[1] === "port-1" ? session.web_host_port : session.app_host_port;
  return `http://127.0.0.1:${port}`;
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 128 * 1024) throw new Error("request body is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function validMutationOrigin(request: IncomingMessage) {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  const host = request.headers.host;
  return host !== undefined && (origin === `http://${host}` || origin === `https://${host}`);
}

function sessionId(title: string, existing: Set<string>) {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "agent";
  if (!existing.has(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${base.slice(0, 35)}-${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error("could not allocate a unique session id");
}

function agentctlControlPlane(): Plugin {
  const attach = (server: ViteDevServer | PreviewServer) => {
    server.middlewares.use(async (request, response, next) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (!url.pathname.startsWith("/api/agentctl/")) {
        next();
        return;
      }
      if (request.method !== "GET" && !validMutationOrigin(request)) {
        sendJson(response, 403, { ok: false, error: "cross-origin mutation refused" });
        return;
      }
      try {
        if (request.method === "GET" && url.pathname === "/api/agentctl/sessions") {
          sendJson(response, 200, await runAgentctl(["list"]));
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/agentctl/sessions") {
          const body = await readJson(request);
          const title = typeof body.title === "string" ? body.title.trim() : "";
          const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";
          if (title.length === 0 || instruction.length === 0) {
            sendJson(response, 400, { ok: false, error: "title and instruction are required" });
            return;
          }
          const sessions = await agentctlSessions(true);
          const id = sessionId(title, new Set(sessions.map((session) => session.id)));
          const result = await runAgentctl([
            "new", id, "--title", title, "--prompt", instruction, "--no-enter",
          ]);
          sessionCache = null;
          sendJson(response, result.ok ? 201 : 400, result);
          return;
        }
        const action = /^\/api\/agentctl\/sessions\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(pause|resume)$/.exec(url.pathname);
        if (request.method === "POST" && action !== null) {
          const [, id, operation] = action;
          const body = await readJson(request);
          const args = operation === "resume"
            ? ["resume", id, "--no-enter"]
            : ["stop", id, ...(body.force === true ? ["--force"] : [])];
          const result = await runAgentctl(args);
          sessionCache = null;
          const guarded = !result.ok && result.error?.startsWith("pause refused:");
          sendJson(response, result.ok ? 200 : guarded ? 409 : 400, {
            ...result,
            requiresForce: guarded,
          });
          return;
        }
        sendJson(response, 404, { ok: false, error: "unknown agentctl endpoint" });
      } catch (cause) {
        sendJson(response, 500, {
          ok: false,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    });
  };
  return {
    name: "agentmonitor-agentctl-control-plane",
    configureServer: attach,
    configurePreviewServer: attach,
  };
}

function serviceGateway(): Plugin {
  const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true });
  proxy.on("error", (error, _request, response) => {
    console.error("workspace service proxy failed", error);
    if ("writeHead" in response) {
      if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
      response.end("Workspace service is unavailable.");
    } else {
      response.destroy();
    }
  });

  const attach = (server: ViteDevServer | PreviewServer) => {
    server.middlewares.use(async (request, response, next) => {
      const target = await serviceTarget(request.headers.host);
      if (target === undefined) {
        next();
        return;
      }
      proxy.web(request, response, { target });
    });
    server.httpServer?.on("upgrade", (request, socket, head) => {
      void serviceTarget(request.headers.host)
        .then((target) => {
          if (target !== undefined) proxy.ws(request, socket, head, { target });
        })
        .catch((error) => {
          console.error("workspace WebSocket proxy lookup failed", error);
          socket.destroy();
        });
    });
  };

  return {
    name: "agentmonitor-service-gateway",
    configureServer: attach,
    configurePreviewServer: attach,
  };
}

export default defineConfig({
  plugins: [agentctlControlPlane(), serviceGateway(), react()],
  server: {
    allowedHosts: [".localhost"],
    port: 5173,
    strictPort: true,
  },
  preview: {
    allowedHosts: [".localhost"],
    port: 4173,
    strictPort: true,
  },
});
