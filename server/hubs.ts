import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { basename, join } from "node:path";
import type { Readable } from "node:stream";
import { json } from "node:stream/consumers";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import type { Project, StoreListing } from "../shared/api.ts";

/** STORE-3: a hub this client lists the projects of, from `<configDir>/hubs.json`. */
export interface HubConfig {
  name: string;
  url: string;
  /** Prints a Cloudflare Access token for the hub on stdout. */
  tokenCommand: string[];
}

const hubsFile = z.array(z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9._-]+$/, "a hub's name is letters, digits, '.', '_' and '-'"),
  url: z.url({ protocol: /^https?$/ }),
  tokenCommand: z.array(z.string().min(1)).min(1).optional(),
}));

/** The hub's URL path prefix on the client's gateway: the browser reaches a hub's store API only through it. */
export const HUB_API_PREFIX = "/api/hubs/";

/** Reads `<configDir>/hubs.json`; no file means no hubs. A malformed file fails the gateway's start. */
export function loadHubs(configDir: string): HubConfig[] {
  const path = join(configDir, "hubs.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return [];
    throw cause;
  }
  let parsed: z.infer<typeof hubsFile>;
  try {
    parsed = hubsFile.parse(JSON.parse(raw));
  } catch (cause) {
    throw new Error(`${path}: ${cause instanceof z.ZodError ? z.prettifyError(cause) : cause instanceof Error ? cause.message : String(cause)}`);
  }
  const names = new Set<string>();
  return parsed.map((hub) => {
    if (names.has(hub.name)) throw new Error(`${path}: two hubs are named ${hub.name}`);
    names.add(hub.name);
    const url = new URL(hub.url).origin;
    return { name: hub.name, url, tokenCommand: hub.tokenCommand ?? ["cloudflared", "access", "token", `-app=${url}`] };
  });
}

/** Why a hub cannot be reached; its message is what the app shows as the reason. */
class HubUnavailable extends Error {}

/** A token is asked for again after this long, or as soon as the hub refuses it. */
const TOKEN_TTL_MS = 60_000;
/** How long listing waits on a hub before calling it unavailable. */
const LIST_TIMEOUT_MS = 5_000;

/** Request headers the hub needs to answer a proxied store request; cookies and origin stay local. */
const FORWARD_REQUEST = ["accept", "content-type", "content-length", "range"];
/** Response headers of a store answer, also for a folder file's bytes (FOLDER-2). */
const FORWARD_RESPONSE = ["content-type", "content-length", "content-range", "content-disposition", "accept-ranges", "cache-control", "etag", "last-modified"];

class Hub {
  readonly config: HubConfig;
  private token: { value: Promise<string>; until: number } | null = null;
  /** The projects the hub last listed, kept so they stay in the picker while it is unavailable. */
  private projects: Project[] = [];

  constructor(config: HubConfig) {
    this.config = config;
  }

  /** What to do about a refused or missing token: logging in again, where the token comes from cloudflared. */
  private loginHint(fallback: string): string {
    return basename(this.config.tokenCommand[0]) === "cloudflared" ? `log in: cloudflared access login ${this.config.url}` : fallback;
  }

  private runTokenCommand(): Promise<string> {
    const [command, ...args] = this.config.tokenCommand;
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    execFile(command, args, { timeout: 15_000, encoding: "utf8" }, (error, stdout, stderr) => {
      const token = stdout.trim();
      if (error === null && token !== "") {
        resolve(token);
        return;
      }
      const detail = stderr.trim().split("\n").pop() || (error?.message ?? "printed no token");
      reject(new HubUnavailable(this.loginHint(`token command failed: ${detail}`)));
    });
    return promise;
  }

  private accessToken(): Promise<string> {
    if (this.token === null || this.token.until <= Date.now()) {
      const value = this.runTokenCommand();
      this.token = { value, until: Date.now() + TOKEN_TTL_MS };
      // A failed command is run again on the next request, not cached.
      value.catch(() => { if (this.token?.value === value) this.token = null; });
    }
    return this.token.value;
  }

  /**
   * One request to the hub's store API with the client's Access token. Anything that is not the
   * store's own answer is the hub being unavailable: no answer, a refused token (401), a
   * redirect to Access's login, or an error page instead of the API's JSON (Cloudflare's 403, 502).
   */
  async request(path: string, method: string, headers: OutgoingHttpHeaders, body: Readable | null, signal?: AbortSignal): Promise<IncomingMessage> {
    const token = await this.accessToken();
    const url = new URL(`/api/store${path}`, this.config.url);
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const { promise, resolve, reject } = Promise.withResolvers<IncomingMessage>();
    const outgoing = send(url, { method, headers: { ...headers, "cf-access-token": token }, signal }, resolve);
    outgoing.on("error", (cause) => {
      reject(new HubUnavailable(signal?.aborted === true ? `no answer within ${LIST_TIMEOUT_MS / 1_000} s` : `unreachable: ${cause.message}`));
    });
    if (body === null) outgoing.end();
    else body.pipe(outgoing);
    const answer = await promise;
    const status = answer.statusCode ?? 0;
    const isJson = answer.headers["content-type"]?.startsWith("application/json") === true;
    if (status === 401 || (status >= 300 && status < 400) || (status >= 400 && !isJson)) {
      answer.resume();
      if (status === 401 || status === 403) this.token = null;
      const answered = `the hub answered ${status}${answer.statusMessage ? ` ${answer.statusMessage}` : ""}`;
      throw new HubUnavailable(status === 401 || status === 403 || status < 400 ? this.loginHint(answered) : answered);
    }
    return answer;
  }

  /** STORE-3: the hub's projects, or why it is unavailable. */
  async listing(): Promise<StoreListing> {
    const base = { hub: this.config.name, name: this.config.name, url: this.config.url };
    try {
      const answer = await this.request("/projects", "GET", { accept: "application/json" }, null, AbortSignal.timeout(LIST_TIMEOUT_MS));
      const envelope = z.object({ ok: z.boolean(), data: z.unknown().optional(), error: z.string().optional() }).parse(await json(answer));
      if (!envelope.ok) throw new HubUnavailable(`the hub answered ${answer.statusCode}: ${envelope.error ?? "no reason given"}`);
      this.projects = z.array(projectSchema).parse(envelope.data);
      return { ...base, projects: this.projects, unavailable: null };
    } catch (cause) {
      const reason = cause instanceof HubUnavailable ? cause.message : cause instanceof Error ? `unreadable answer: ${cause.message}` : String(cause);
      return { ...base, projects: this.projects, unavailable: reason };
    }
  }

  /** Passes one store API request of the browser on to the hub and its answer back, streamed both ways. */
  async proxy(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
    const headers: OutgoingHttpHeaders = {};
    for (const name of FORWARD_REQUEST) {
      const value = request.headers[name];
      if (value !== undefined) headers[name] = value;
    }
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    let answer: IncomingMessage;
    try {
      answer = await this.request(path, request.method ?? "GET", headers, hasBody ? request : null);
    } catch (cause) {
      if (!(cause instanceof HubUnavailable)) throw cause;
      // STORE-4: what fails because the hub is unavailable names the hub.
      response.writeHead(502, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" });
      response.end(`${JSON.stringify({ ok: false, error: `hub ${this.config.name} is unavailable: ${cause.message}` })}\n`);
      return;
    }
    const out: IncomingHttpHeaders = {};
    for (const name of FORWARD_RESPONSE) {
      const value = answer.headers[name];
      if (value !== undefined) out[name] = value;
    }
    response.writeHead(answer.statusCode ?? 502, out);
    await pipeline(answer, response).catch(() => response.destroy());
  }
}

/** A project as a hub sends it (shared/api.ts); a hub of another version may send more. */
const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  repoPath: z.string().nullable(),
  hostSessions: z.boolean(),
  createdAt: z.number(),
});

/** STORE-3, STORE-4: the hubs this client is configured with; the gateway reaches their store APIs for the browser. */
export class Hubs {
  private readonly hubs: Map<string, Hub>;

  constructor(configs: HubConfig[]) {
    this.hubs = new Map(configs.map((config) => [config.name, new Hub(config)]));
  }

  /** Every hub's projects, or why it is unavailable, in the order of hubs.json. */
  listings(): Promise<StoreListing[]> {
    return Promise.all([...this.hubs.values()].map((hub) => hub.listing()));
  }

  /** Handles `/api/hubs/<name>/store/...`; false for any other path. */
  async handle(request: IncomingMessage, response: ServerResponse, pathname: string, search: string): Promise<boolean> {
    const match = /^\/api\/hubs\/([^/]+)\/store(\/.*)$/.exec(pathname);
    if (match === null) return false;
    const hub = this.hubs.get(decodeURIComponent(match[1]));
    if (hub === undefined) {
      response.writeHead(404, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" });
      response.end(`${JSON.stringify({ ok: false, error: `no hub is named ${match[1]}` })}\n`);
      return true;
    }
    await hub.proxy(request, response, `${match[2]}${search}`);
    return true;
  }
}
