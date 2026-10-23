// STORE-6: moves a project from one store to another through their store APIs: the source
// exports it as one bundle, the target imports it in parts, and the source deletes it once the
// target confirms it holds what was exported. Both ends need their store's owner.
//
//   node scripts/move-project.ts <source url> <project name or id> <target url> [options]
//
//   --confirm                     leave behind what does not move: snapshots and a stopped
//                                 session's uncommitted files (deleted), commits no remote has
//                                 (kept on the source machine's branch)
//   --target-repo <path>          the project's main checkout on the target's machine
//   --source-token-command <cmd>  prints a Cloudflare Access token for that store, sent as
//   --target-token-command <cmd>  `cf-access-token`; for a store not on this machine the
//                                 default is `cloudflared access token -app=<url>`
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, mkdtempSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { z } from "zod";

/** A bundle goes up in parts this large, below the request size limit of Cloudflare's proxy (100 MB). */
const PART_BYTES = 32 * 1024 * 1024;

class MoveError extends Error {}

const answer = z.looseObject({ ok: z.boolean(), data: z.unknown().optional(), error: z.string().optional() });
const owner = z.object({ kind: z.literal("human"), person: z.object({ name: z.string(), owner: z.boolean() }) });
const projects = z.array(z.object({ id: z.string(), name: z.string() }));
const leftBehind = z.array(z.object({ title: z.string(), snapshot: z.boolean(), uncommitted: z.array(z.string()), unpushed: z.array(z.string()) }));
const receipt = z.object({
  project: z.object({ id: z.string(), name: z.string() }),
  digest: z.string(),
  added: z.array(z.object({ name: z.string() })),
  counts: z.record(z.string(), z.number()),
});

/** One store: its URL and the Cloudflare Access token its requests carry, if any. */
class StoreClient {
  readonly url: string;
  private readonly tokenCommand: string[] | null;
  private token: string | null = null;

  constructor(url: string, tokenCommand: string | undefined) {
    this.url = new URL(url).origin;
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
    this.tokenCommand = tokenCommand !== undefined
      ? tokenCommand.split(/\s+/).filter(Boolean)
      : local ? null : ["cloudflared", "access", "token", `-app=${this.url}`];
  }

  private headers(): Record<string, string> {
    if (this.tokenCommand === null) return {};
    if (this.token === null) {
      const [command, ...args] = this.tokenCommand;
      try {
        this.token = execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      } catch (cause) {
        throw new MoveError(`${this.url}: the token command failed: ${cause instanceof Error ? cause.message : String(cause)}${this.loginHint()}`);
      }
      if (this.token === "") throw new MoveError(`${this.url}: the token command printed no token${this.loginHint()}`);
    }
    return { "cf-access-token": this.token };
  }

  private loginHint(): string {
    return this.tokenCommand !== null && basename(this.tokenCommand[0]) === "cloudflared" ? `; log in: cloudflared access login ${this.url}` : "";
  }

  /** A store API request; its answer, or why there is none. */
  async request(method: string, path: string, body?: unknown, query = ""): Promise<Response> {
    const bytes = body instanceof Buffer;
    return fetch(`${this.url}/api/store${path}${query}`, {
      method,
      redirect: "manual",
      headers: { ...this.headers(), ...(body === undefined ? {} : { "content-type": bytes ? "application/octet-stream" : "application/json" }) },
      body: body === undefined ? undefined : bytes ? body : JSON.stringify(body),
    });
  }

  /** The store's JSON answer; anything else (Access's login page, a proxy's error) is the store being out of reach. */
  async read(response: Response, what: string): Promise<z.infer<typeof answer>> {
    const parsed = answer.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new MoveError(`${this.url} answered ${what} with ${response.status}, not the store API${this.loginHint()}`);
    return parsed.data;
  }

  /** A JSON request that must succeed; its data. */
  async data(method: string, path: string, body?: unknown): Promise<unknown> {
    const result = await this.read(await this.request(method, path, body), `${method} ${path}`);
    if (!result.ok) throw new MoveError(`${this.url}: ${result.error ?? "refused"}`);
    return result.data;
  }
}

async function move(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      confirm: { type: "boolean", default: false },
      "target-repo": { type: "string" },
      "source-token-command": { type: "string" },
      "target-token-command": { type: "string" },
    },
  });
  if (positionals.length !== 3) throw new MoveError("usage: node scripts/move-project.ts <source url> <project name or id> <target url> [--confirm] [--target-repo PATH] [--source-token-command CMD] [--target-token-command CMD]");
  const source = new StoreClient(positionals[0], values["source-token-command"]);
  const target = new StoreClient(positionals[2], values["target-token-command"]);
  for (const store of [source, target]) {
    const me = owner.safeParse(await store.data("GET", "/me"));
    if (!me.success || !me.data.person.owner) throw new MoveError(`${store.url}: only the store's owner moves projects`);
  }
  const project = projects.parse(await source.data("GET", "/projects")).find((found) => found.id === positionals[1] || found.name === positionals[1]);
  if (project === undefined) throw new MoveError(`${source.url} has no project ${positionals[1]}`);

  const exported = await source.request("POST", `/projects/${project.id}/export`, { confirm: values.confirm });
  if (!exported.ok || exported.body === null) {
    const result = await source.read(exported, "the export");
    const left = leftBehind.safeParse(result.leftBehind);
    if (!left.success) throw new MoveError(`${source.url}: ${result.error ?? "the export failed"}`);
    const lines = left.data.map((task) => [
      `  ${task.title}:`,
      ...(task.snapshot ? ["    uncommitted work kept as its snapshot (deleted)"] : []),
      ...(task.uncommitted.length > 0 ? [`    uncommitted in its stopped session (deleted): ${task.uncommitted.join(", ")}`] : []),
      ...(task.unpushed.length > 0 ? [`    commits no remote has (kept on ${source.url}'s machine): ${task.unpushed.join("; ")}`] : []),
    ].join("\n"));
    throw new MoveError(`${project.name} has work that does not move:\n${lines.join("\n")}\nPush or commit what should move, or move with --confirm to leave it behind.`);
  }
  const scratch = mkdtempSync(join(tmpdir(), "am-move-"));
  try {
    const bundle = join(scratch, "bundle.tar.gz");
    await pipeline(exported.body, createWriteStream(bundle));
    const uploadId = randomUUID();
    const file = await open(bundle);
    try {
      const { size } = await file.stat();
      for (let offset = 0; offset < size;) {
        const { bytesRead, buffer } = await file.read(Buffer.alloc(Math.min(PART_BYTES, size - offset)), 0, Math.min(PART_BYTES, size - offset), offset);
        const sent = await target.read(await target.request("PUT", `/imports/${uploadId}`, buffer, `?offset=${offset}`), "an upload");
        if (!sent.ok) throw new MoveError(`${target.url}: ${sent.error ?? "the upload failed"}`);
        offset += bytesRead;
      }
    } finally {
      await file.close();
    }
    const moved = receipt.parse(await target.data("POST", `/imports/${uploadId}`, values["target-repo"] === undefined ? {} : { repoPath: values["target-repo"] }));
    await source.data("POST", `/projects/${project.id}/moved`, { digest: moved.digest });
    const counts = Object.entries(moved.counts).map(([kind, count]) => `${count} ${kind}`).join(", ");
    console.log(`moved ${moved.project.name} (${moved.project.id}) from ${source.url} to ${target.url}: ${counts}`);
    if (moved.added.length > 0) console.log(`added to ${target.url}: ${moved.added.map((person) => person.name).join(", ")}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

try {
  await move(process.argv.slice(2));
} catch (cause) {
  console.error(cause instanceof MoveError ? cause.message : cause);
  process.exit(1);
}
