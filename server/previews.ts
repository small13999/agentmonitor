import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { gatewayZone, hostOrigin, hostRole } from "../shared/hosts.ts";
import { sendRefusal, type Auth, type Visitor } from "./auth.ts";
import type { GatewayConfig } from "./config.ts";
import type { PreviewTarget, StoreService } from "./store/service.ts";
import { StoreError } from "./store/store.ts";

/**
 * The preview relay's socket in a session's run directory (container/launch.ts): each
 * connection names a port of the session's workspace on its first line, then carries that
 * port's traffic.
 */
export const PREVIEW_SOCKET = "preview.sock";

/** PREVIEW-3: the stopped page's form posts here to start the session again. */
const START_PATH = "/__agentmonitor/start";

/** Cloudflare Access's credentials: an agent's server could act as the person with them. */
const ACCESS_HEADERS = ["cf-access-jwt-assertion", "cf-access-authenticated-user-email"];
const HOP_HEADERS = ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade"];

export interface PreviewDeps {
  config: Pick<GatewayConfig, "publicOrigin">;
  auth: Auth;
  store: StoreService;
}

type Visit =
  | { kind: "page"; status: number; title: string; body: string }
  | Extract<Visitor, { kind: "refused" }>
  | { kind: "open"; target: Extract<PreviewTarget, { kind: "open" }>; origin: string };

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** The headers the session's server gets: Access's credentials gone, and the request as if made on its own `localhost` (dev servers refuse other hosts). */
function forwarded(headers: IncomingHttpHeaders, port: number, origin: string, upgrade: boolean): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || ACCESS_HEADERS.includes(name) || (!upgrade && HOP_HEADERS.includes(name))) continue;
    result[name] = value;
  }
  const local = `localhost:${port}`;
  result.host = local;
  if (headers.origin === origin) result.origin = `http://${local}`;
  const cookies = (headers.cookie ?? "").split(";").map((part) => part.trim()).filter((part) => part !== "" && !part.startsWith("CF_"));
  if (cookies.length > 0) result.cookie = cookies.join("; ");
  else delete result.cookie;
  return result;
}

/** A redirect to the server's own `localhost` goes to the preview's origin instead. */
function rewriteLocation(headers: IncomingHttpHeaders, port: number, origin: string): IncomingHttpHeaders {
  const location = headers.location;
  if (location === undefined) return headers;
  for (const local of [`http://localhost:${port}`, `http://127.0.0.1:${port}`]) {
    if (location === local || location.startsWith(`${local}/`)) return { ...headers, location: `${origin}${location.slice(local.length)}` };
  }
  return headers;
}

function relay(target: { socket: string; port: number }): Socket {
  const socket = connect(target.socket);
  socket.write(`${target.port}\n`);
  return socket;
}

/**
 * A task's preview host, `am-p-<task id>` (shared/hosts.ts, PREVIEW-2): for a person of the
 * store (AUTH-1), the port of its running session's workspace that the agent opened (`am
 * preview`, PREVIEW-1), through the session's preview relay; or a page that says why there is
 * nothing to show, with a button that starts a stopped session again (PREVIEW-3).
 */
export class Previews {
  private readonly deps: PreviewDeps;

  constructor(deps: PreviewDeps) {
    this.deps = deps;
  }

  private async visit(request: IncomingMessage, taskId: string): Promise<Visit> {
    const visitor = await this.deps.auth.identify(request);
    if (visitor.kind === "refused") return visitor;
    const { publicOrigin } = this.deps.config;
    const origin = publicOrigin === null ? `http://${request.headers.host ?? "localhost"}` : hostOrigin(gatewayZone(publicOrigin), { kind: "preview", taskId });
    let target: PreviewTarget;
    try {
      if (request.method === "POST" && new URL(request.url ?? "/", origin).pathname === START_PATH) {
        if (request.headers.origin !== origin) return { kind: "page", status: 403, title: "Refused", body: "<p>Refused: a start from another site.</p>" };
        await this.deps.store.startPreview(visitor.principal, taskId);
      }
      target = await this.deps.store.previewTarget(visitor.principal, taskId);
    } catch (cause) {
      if (!(cause instanceof StoreError)) throw cause;
      return { kind: "page", status: cause.status, title: "No preview", body: `<p>${escape(cause.message)}.</p>` };
    }
    const title = escape(target.task.title);
    const ui = publicOrigin === null ? origin.replace(/\/\/am-p-[^.]+\./, "//") : hostOrigin(gatewayZone(publicOrigin), { kind: "ui" });
    const chat = `${ui}/#/t/${target.task.id}/chat`;
    switch (target.kind) {
      case "none":
        return { kind: "page", status: 404, title, body: `<p>The task has no running session, so it has no preview. <a href="${chat}">Open the task</a>.</p>` };
      case "stopped":
        return {
          kind: "page",
          status: 503,
          title,
          body: `<p>The session ${escape(target.session.name)} is stopped.</p><form method="post" action="${START_PATH}"><button>Start the session</button></form>`,
        };
      case "closed":
        return {
          kind: "page",
          status: 404,
          title,
          body: `<p>The agent has opened no preview yet: it runs <code>am preview PORT</code> once a server listens in its workspace. <a href="${chat}">Open the chat</a>.</p>`,
        };
      case "open":
        return { kind: "open", target, origin };
    }
  }

  /** Answers a preview host's request; false for every other host. */
  async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const role = hostRole(request.headers.host, this.deps.config.publicOrigin);
    if (role?.kind !== "preview") return false;
    const visit = await this.visit(request, role.taskId);
    if (visit.kind === "refused") {
      sendRefusal(response, visit);
      return true;
    }
    if (visit.kind === "page") {
      response.writeHead(visit.status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${visit.title} · Preview</title></head><body><h1>${visit.title}</h1>${visit.body}</body></html>\n`);
      return true;
    }
    // After a start, the form's POST lands on the preview itself.
    if (request.method === "POST" && new URL(request.url ?? "/", visit.origin).pathname === START_PATH) {
      response.writeHead(303, { location: `${visit.origin}/`, "cache-control": "no-store" });
      response.end();
      return true;
    }
    const { target, origin } = visit;
    const upstream = httpRequest(
      { method: request.method, path: request.url, headers: forwarded(request.headers, target.port, origin, false), createConnection: () => relay(target) },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.statusMessage, rewriteLocation(answer.headers, target.port, origin));
        answer.pipe(response);
      },
    );
    upstream.on("error", () => {
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        response.end(`The session's preview relay did not answer on port ${target.port}.\n`);
      } else response.destroy();
    });
    request.on("aborted", () => upstream.destroy());
    request.pipe(upstream);
    return true;
  }

  /** Takes a preview host's upgrade (a dev server's live reload); false for every other host. */
  async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> {
    const role = hostRole(request.headers.host, this.deps.config.publicOrigin);
    if (role?.kind !== "preview") return false;
    socket.on("error", () => socket.destroy());
    const visit = await this.visit(request, role.taskId);
    if (visit.kind !== "open") {
      socket.end(`HTTP/1.1 ${visit.status} Unavailable\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
      return true;
    }
    const { target, origin } = visit;
    const upstream = httpRequest({ method: request.method, path: request.url, headers: forwarded(request.headers, target.port, origin, true), createConnection: () => relay(target) });
    upstream.on("upgrade", (answer, server, serverHead) => {
      const lines = [`HTTP/1.1 101 ${answer.statusMessage ?? "Switching Protocols"}`];
      for (let index = 0; index < answer.rawHeaders.length; index += 2) lines.push(`${answer.rawHeaders[index]}: ${answer.rawHeaders[index + 1]}`);
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (serverHead.length > 0) socket.write(serverHead);
      if (head.length > 0) server.write(head);
      server.on("error", () => socket.destroy());
      socket.on("close", () => server.destroy());
      server.on("close", () => socket.destroy());
      server.pipe(socket).pipe(server);
    });
    upstream.on("response", (answer) => {
      socket.end(`HTTP/1.1 ${answer.statusCode ?? 502} ${answer.statusMessage ?? ""}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
      answer.resume();
    });
    upstream.on("error", () => socket.destroy());
    upstream.end();
    return true;
  }
}
