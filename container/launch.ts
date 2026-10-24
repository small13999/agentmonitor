// Starts a session's agent: omp's agent directory, then the chat host (chat-host.ts), which runs
// omp in RPC mode in the worktree and serves the chat to the gateway on run/chat.sock. The
// container entrypoint and the host entry (HOST-2) share it; each says where things live.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, connect, type Socket } from "node:net";
import { join } from "node:path";
import { startChatHost } from "./chat-host.ts";

/** Written by the gateway before every start (server/runtime/runtime.ts). */
interface Launch {
  /** The repository worktree; omp's cwd, so the repository's own AGENTS.md loads (SESSION-4). */
  cwd: string;
  /** omp model for a new chat; null: omp's default. */
  model: string | null;
  /** omp chat (session id) to resume; null: a new chat. */
  resume: string | null;
  /** The new chat's first prompt, for an automation's run (AUTO-9); null: none. */
  prompt: string | null;
  /** The task's or automation's folder as the agent sees it (FOLDER-3); null: none. */
  agentFolder: string | null;
  /** The project has Cloudflare tokens: Wrangler goes through the gateway's broker. */
  cloudflare: boolean;
}

export interface SessionPaths {
  /** The run directory: launch.json, task.md, and the session's sockets. */
  run: string;
  /** This file's directory: AGENTS.md, RULES.md, omp-extension.ts, chat-host.ts, am.ts. */
  source: string;
  /** omp's agent directory for this session (PI_CODING_AGENT_DIR). */
  agentDir: string;
  /** The configured omp agent directory, whose credentials and providers the session uses. */
  ompCredentials: string;
  /** More environment for omp and every tool it runs. */
  env: Record<string, string>;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function readLaunch(run: string): Launch {
  const file = join(run, "launch.json");
  const launch: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof launch !== "object" || launch === null
    || !("cwd" in launch) || typeof launch.cwd !== "string"
    || !("model" in launch) || !nullableString(launch.model)
    || !("resume" in launch) || !nullableString(launch.resume)
    || !("prompt" in launch) || !nullableString(launch.prompt)
    || !("agentFolder" in launch) || !nullableString(launch.agentFolder)
    || !("cloudflare" in launch) || typeof launch.cloudflare !== "boolean") {
    throw new Error(`${file} is no launch file of this version`);
  }
  const { cwd, model, resume, prompt, agentFolder, cloudflare } = launch;
  return { cwd, model, resume, prompt, agentFolder, cloudflare };
}

/** A connection to the port on this machine's loopback, IPv4 or IPv6 (dev servers listen on either for `localhost`); null when nothing listens. */
async function connectLocal(port: number): Promise<Socket | null> {
  for (const host of ["127.0.0.1", "::1"]) {
    const socket = connect(port, host);
    const opened = Promise.withResolvers<boolean>();
    socket.once("connect", () => opened.resolve(true));
    socket.once("error", () => opened.resolve(false));
    if (await opened.promise) return socket;
    socket.destroy();
  }
  return null;
}

/**
 * PREVIEW-1: the gateway reaches the servers in the session's workspace through
 * run/preview.sock (server/previews.ts): each connection names a port on its first line, then
 * carries that port's traffic. When nothing listens there, the gateway gets a 502 that says so.
 */
async function servePreviews(run: string): Promise<void> {
  const path = join(run, "preview.sock");
  rmSync(path, { force: true });
  const server = createServer((client) => {
    client.on("error", () => client.destroy());
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf(10);
      if (end === -1) {
        if (buffered.length > 8) client.destroy();
        return;
      }
      client.off("data", onData);
      client.pause();
      const port = Number(buffered.subarray(0, end).toString());
      const rest = buffered.subarray(end + 1);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        client.destroy();
        return;
      }
      void connectLocal(port).then((upstream) => {
        if (upstream === null) {
          const body = `Nothing in the session listens on port ${port}.\n`;
          client.end(`HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
          return;
        }
        upstream.on("error", () => client.destroy());
        upstream.on("close", () => client.destroy());
        client.on("close", () => upstream.destroy());
        if (rest.length > 0) upstream.write(rest);
        client.pipe(upstream).pipe(client);
      });
    };
    client.on("data", onData);
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(path, listening.resolve);
  await listening.promise;
}

export async function startSession(paths: SessionPaths): Promise<void> {
  const launch = readLaunch(paths.run);
  const { agentDir } = paths;
  mkdirSync(agentDir, { recursive: true });

  // Credentials and providers stay owned by the configured omp agent directory.
  for (const file of ["agent.db", "models.db", "models.yml"]) {
    const source = join(paths.ompCredentials, file);
    const target = join(agentDir, file);
    rmSync(target, { force: true });
    if (existsSync(source)) symlinkSync(source, target);
  }
  // Workflow context ships with Agent Monitor and replaces whatever an older version left
  // behind; the session's task, as the gateway wrote it for this start, follows it (TASK-6).
  const taskFile = join(paths.run, "task.md");
  const task = existsSync(taskFile) ? `\n${readFileSync(taskFile, "utf8")}` : "";
  writeFileSync(join(agentDir, "AGENTS.md"), `${readFileSync(join(paths.source, "AGENTS.md"), "utf8")}${task}`);
  copyFileSync(join(paths.source, "RULES.md"), join(agentDir, "RULES.md"));
  // setupVersion and last-changelog-version skip the first-run wizard and changelog screens.
  writeFileSync(join(agentDir, "config.yml"), ["setupVersion: 2", "extensions:", `  - ${join(paths.source, "omp-extension.ts")}`, ""].join("\n"));
  const ompVersion = execFileSync("omp", ["--version"], { encoding: "utf8" }).trim().split(/[\s/]/).at(-1) ?? "";
  writeFileSync(join(agentDir, "last-changelog-version"), `${ompVersion}\n`);

  // What omp, its extension and `am` need to find this session's agent directory and sockets;
  // every tool omp runs inherits it.
  // SESSION-17: the user's omp settings (compaction, model roles, ...) apply as a read-only
  // overlay, and the session's own config.yml is overlaid after them, so its extension wins.
  const userConfig = join(paths.ompCredentials, "config.yml");
  const configFiles = [...(existsSync(userConfig) ? [userConfig] : []), join(agentDir, "config.yml")];
  const env: Record<string, string> = {
    ...paths.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_CONFIG_FILES: configFiles.join(":"),
    AM_SOCKET: join(paths.run, "am.sock"),
    AGENTMONITOR_OMP_SOCKET: join(paths.run, "omp.sock"),
  };
  // Wrangler wants Cloudflare's API over TCP; the gateway serves it on the session socket, which
  // identifies the session, and holds the project's tokens. The token given here only keeps
  // Wrangler from asking to log in; the gateway ignores it.
  if (launch.cloudflare) {
    const relay = createServer((client) => {
      const upstream = connect(join(paths.run, "am.sock"));
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      client.pipe(upstream).pipe(client);
    });
    const listening = Promise.withResolvers<void>();
    relay.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    const address = relay.address();
    if (address === null || typeof address === "string") throw new Error("the Cloudflare relay has no TCP address");
    env.CLOUDFLARE_API_BASE_URL = `http://127.0.0.1:${address.port}/client/v4`;
    env.CLOUDFLARE_API_TOKEN = "agent-monitor";
  }
  await servePreviews(paths.run);
  await startChatHost({
    run: paths.run,
    cwd: launch.cwd,
    folder: launch.agentFolder,
    model: launch.model,
    resume: launch.resume,
    prompt: launch.prompt,
    env: { ...process.env, ...env },
  });
}
