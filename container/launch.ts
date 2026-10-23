// Starts a session's agent: omp's agent directory, Tern's settings, one Tern daemon whose
// `workspace` session is Tern's chat on omp (`tern acp`) in the worktree, then Tern's web
// client, which the gateway proxies into the session page. The container entrypoint and the
// host entry (HOST-2) share it; each says where things live.
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** Written by the gateway before every start (server/runtime/runtime.ts). */
export interface Launch {
  /** The repository worktree; omp's cwd, so the repository's own AGENTS.md loads (SESSION-4). */
  cwd: string;
  /** omp model for the session (`tern acp --model`); null: omp's default. */
  model: string | null;
  /** omp session id to resume (`tern acp --resume`); null: a new session. */
  resume: string | null;
  /** The new chat's first prompt (`tern acp --prompt`), for an automation's run (AUTO-9); null: none. */
  prompt: string | null;
  /** Origin allowed to open Tern's web socket; the gateway's Tern proxy presents it. */
  ternOrigin: string;
  /** Where Tern's web client listens. */
  ternListen: string;
  /** The project has Cloudflare tokens: Wrangler goes through the gateway's broker. */
  cloudflare: boolean;
}

export interface SessionPaths {
  /** The run directory: launch.json, task.md, tern-token, and the session's sockets. */
  run: string;
  /** This file's directory: AGENTS.md, RULES.md, omp-extension.ts, acp-filter.ts, am.ts. */
  source: string;
  /** omp's agent directory for this session (PI_CODING_AGENT_DIR). */
  agentDir: string;
  /** The configured omp agent directory, whose credentials and providers the session uses. */
  ompCredentials: string;
  /** Tern's settings directory for this session (TERN_CONFIG_DIR). */
  ternConfig: string;
  /** Tern's web client, as tern-web-assets.ts stores it. */
  ternAssets: string;
  /** More environment for the chat's command line: omp and every tool it runs. */
  chatEnv: string[];
}

/** Tern's chat runs omp through this agent entry (Tern ships no omp entry of its own yet). */
const AGENT_ID = "am-omp";

export function readLaunch(run: string): Launch {
  return JSON.parse(readFileSync(join(run, "launch.json"), "utf8")) as Launch;
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

  // Under ACP omp asks before every tool call; --auto-approve keeps the TUI's default of not asking.
  // Tern runs omp through acp-filter.ts, which leaves out file lists Tern cannot draw.
  // Dark matches the monitor around the chat.
  mkdirSync(paths.ternConfig, { recursive: true });
  writeFileSync(join(paths.ternConfig, "settings.json"), JSON.stringify({
    theme: "Dark",
    agents: { custom: [{ id: AGENT_ID, name: "omp", command: "node", args: [join(paths.source, "acp-filter.ts")] }] },
  }));
  process.env.TERN_CONFIG_DIR = paths.ternConfig;
  const daemonSocket = process.env.TERN_DAEMON_SOCKET;
  if (daemonSocket === undefined) throw new Error("TERN_DAEMON_SOCKET is not set");

  // Tern starts a pane's program with an environment of its own, so the chat's command line
  // carries what omp, its extension, `am` and `tern` need to find this session's sockets and
  // settings.
  // SESSION-17: the user's omp settings (compaction, model roles, ...) apply as a read-only
  // overlay, and the session's own config.yml is overlaid after them, so its extension wins.
  const userConfig = join(paths.ompCredentials, "config.yml");
  const configFiles = [...(existsSync(userConfig) ? [userConfig] : []), join(agentDir, "config.yml")];
  const chatEnv = [
    ...paths.chatEnv,
    `PI_CODING_AGENT_DIR=${agentDir}`,
    `PI_CONFIG_FILES=${configFiles.join(":")}`,
    `TERN_CONFIG_DIR=${paths.ternConfig}`,
    `TERN_DAEMON_SOCKET=${daemonSocket}`,
    `AM_SOCKET=${join(paths.run, "am.sock")}`,
    `AGENTMONITOR_OMP_SOCKET=${join(paths.run, "omp.sock")}`,
  ];
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
    chatEnv.push(`CLOUDFLARE_API_BASE_URL=http://127.0.0.1:${address.port}/client/v4`, "CLOUDFLARE_API_TOKEN=agent-monitor");
  }

  // The daemon keeps its sessions next to its socket, in the run directory, which outlives the
  // session's processes. Each start runs the chat the launch file names instead of restoring
  // the last one.
  rmSync(`${daemonSocket}.state`, { force: true });
  const daemon = spawn("tern", ["daemon"], { stdio: "inherit" });
  daemon.on("exit", (code) => {
    console.error(`tern daemon exited with ${code}`);
    process.exit(1);
  });
  for (let attempt = 0; ; attempt++) {
    try {
      execFileSync("tern", ["ls"], { stdio: "ignore" });
      break;
    } catch (error) {
      if (attempt === 100) throw error;
      await sleep(100);
    }
  }
  const chat = ["env", ...chatEnv, "tern", "acp", AGENT_ID];
  if (launch.model !== null) chat.push("--model", launch.model);
  if (launch.resume !== null) chat.push("--resume", launch.resume);
  else if (launch.prompt !== null) chat.push("--prompt", launch.prompt);
  execFileSync("tern", ["new", "session", "workspace", "--cwd", launch.cwd, "--keep-open", "--", ...chat], { stdio: "inherit" });

  const web = spawn("tern", [
    "web", "serve",
    "--listen", launch.ternListen,
    "--token", join(paths.run, "tern-token"),
    "--assets", paths.ternAssets,
    "--allow-origin", launch.ternOrigin,
  ], { stdio: "inherit" });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      web.kill(signal);
      daemon.kill(signal);
    });
  }
  web.on("exit", (code) => process.exit(code ?? 1));
}
