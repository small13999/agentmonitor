import { readFileSync } from "node:fs";
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";

/** How long one "allow writes" on the session page lasts (CLOUDFLARE-2). */
export const WRITE_GRANT_MS = 10 * 60_000;
/** Cloudflare's API path; agents' Wrangler sends it to their session socket. */
export const CLOUDFLARE_API_PREFIX = "/client/v4";
/** Wrangler uploads whole Workers and assets. */
const MAX_REQUEST_BYTES = 256 * 1024 * 1024;
const STRIPPED_REQUEST_HEADERS = new Set([
  "authorization", "connection", "cookie", "host", "proxy-authorization", "proxy-connection",
  "te", "trailer", "transfer-encoding", "upgrade", "x-auth-email", "x-auth-key",
]);
const STRIPPED_RESPONSE_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
]);

export interface CloudflareTokens {
  read: string;
  /** Null: the project's agents only ever read. */
  write: string | null;
}

function parseEnv(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match !== null) values.set(match[1], match[2].replace(/^(["'])(.*)\1$/, "$2"));
  }
  return values;
}

/** Wrangler prints the messages of Cloudflare's own error shape. */
function refuse(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "cache-control": "no-store", "content-type": "application/json" });
  response.end(`${JSON.stringify({ success: false, errors: [{ code: 10000, message }], messages: [], result: null })}\n`);
}

/** Reads: safe methods and GraphQL queries (Cloudflare's analytics); writes: every other change. */
function access(method: string | undefined, pathname: string): "read" | "write" | null {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return "read";
  if (method === "POST" && pathname === `${CLOUDFLARE_API_PREFIX}/graphql`) return "read";
  if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") return "write";
  return null;
}

function keep(headers: IncomingMessage["headers"], stripped: Set<string>): OutgoingHttpHeaders {
  return Object.fromEntries(Object.entries(headers).filter(([name, value]) => value !== undefined && !stripped.has(name)));
}

/**
 * Cloudflare access for sessions. A project's tokens stay in the gateway, in
 * <config dir>/cloudflare/<project name>.env (CLOUDFLARE_READ_TOKEN, optional
 * CLOUDFLARE_WRITE_TOKEN). An agent's Wrangler sends Cloudflare API requests to its session
 * socket, which identifies the session; the broker forwards them with the read token, or,
 * while the user allows writes for that session, the write token. Grants live in memory, so
 * a gateway restart revokes them.
 */
export class CloudflareBroker {
  private readonly options: { configDir: string; upstream: string };
  /** When each session's writes stop being allowed. */
  private readonly grants = new Map<string, number>();

  constructor(options: { configDir: string; upstream: string }) {
    this.options = options;
  }

  /** The project's tokens; null when it has none (its agents get no Cloudflare access). */
  tokens(projectName: string): CloudflareTokens | null {
    let text: string;
    try {
      text = readFileSync(join(this.options.configDir, "cloudflare", `${projectName}.env`), "utf8");
    } catch {
      return null;
    }
    const values = parseEnv(text);
    const read = values.get("CLOUDFLARE_READ_TOKEN") ?? "";
    const write = values.get("CLOUDFLARE_WRITE_TOKEN") ?? "";
    return read === "" ? null : { read, write: write === "" ? null : write };
  }

  writesUntil(sessionId: string): number | null {
    const until = this.grants.get(sessionId);
    if (until === undefined) return null;
    if (until > Date.now()) return until;
    this.grants.delete(sessionId);
    return null;
  }

  /** Allows the session's writes for the next WRITE_GRANT_MS; until when. */
  allowWrites(sessionId: string): number {
    const until = Date.now() + WRITE_GRANT_MS;
    this.grants.set(sessionId, until);
    return until;
  }

  revokeWrites(sessionId: string): void {
    this.grants.delete(sessionId);
  }

  /** Forwards one Cloudflare API request of the session's agent. */
  handle(request: IncomingMessage, response: ServerResponse, sessionId: string, projectName: string): void {
    const tokens = this.tokens(projectName);
    if (tokens === null) {
      refuse(response, 403, `project ${projectName} has no Cloudflare tokens in Agent Monitor`);
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    const kind = access(request.method, url.pathname);
    if (kind === null) {
      refuse(response, 405, `${request.method ?? "this method"} is not a Cloudflare API method`);
      return;
    }
    let token = tokens.read;
    if (kind === "write") {
      if (tokens.write === null) {
        refuse(response, 403, `project ${projectName} has no Cloudflare write token in Agent Monitor; its agents only read`);
        return;
      }
      if (this.writesUntil(sessionId) === null) {
        refuse(response, 403, "Cloudflare writes are off for this session. Ask the user to allow them in the task's settings in Agent Monitor (10 minutes at a time).");
        return;
      }
      token = tokens.write;
    }
    const length = Number(request.headers["content-length"] ?? 0);
    if (!Number.isFinite(length) || length < 0 || length > MAX_REQUEST_BYTES) {
      refuse(response, 413, "the request body is too large");
      return;
    }
    const target = new URL(`${url.pathname}${url.search}`, this.options.upstream);
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const outgoing = send(target, { method: request.method, headers: { ...keep(request.headers, STRIPPED_REQUEST_HEADERS), authorization: `Bearer ${token}` } }, (incoming) => {
      response.writeHead(incoming.statusCode ?? 502, keep(incoming.headers, STRIPPED_RESPONSE_HEADERS));
      incoming.pipe(response);
    });
    outgoing.setTimeout(120_000, () => outgoing.destroy(new Error("Cloudflare did not answer within 120 s")));
    outgoing.on("error", (error) => {
      if (!response.headersSent) refuse(response, 502, `the Cloudflare API request failed: ${error.message}`);
      else response.destroy(error);
    });
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) outgoing.destroy(new Error("the request body is too large"));
    });
    request.on("aborted", () => outgoing.destroy());
    request.pipe(outgoing);
  }
}
