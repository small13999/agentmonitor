// Workspace container entrypoint: prepare omp's home, start one Tern daemon whose
// workspace session is Tern's chat on omp (`tern acp`) in the worktree, then serve
// Tern's web client, which the gateway proxies into the workspace page.
// Runs as PID 1 under `podman run --init`.
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** Written by the gateway before every container start. */
interface Launch {
  /** The repository worktree; omp's cwd, so the repository's own AGENTS.md loads (SESSION-4). */
  cwd: string;
  /** omp model for the session (`tern acp --model`); null: omp's default. */
  model: string | null;
  /** omp session id to resume (`tern acp --resume`); null: a new session. */
  resume: string | null;
  /** Origin allowed to open Tern's web socket; the gateway's Tern proxy presents it. */
  ternOrigin: string;
  /** The project has Cloudflare tokens: Wrangler goes through the gateway's broker. */
  cloudflare: boolean;
}

/** Where Wrangler finds Cloudflare's API in the container; clear of `wrangler dev`'s 8787 and 8788. */
const CLOUDFLARE_PORT = 18787;

const RUN = "/run/agentmonitor";
const IMAGE = "/opt/agentmonitor";
/** Tern's chat runs omp through this agent entry (Tern ships no omp entry of its own yet). */
const AGENT_ID = "am-omp";
const launch = JSON.parse(readFileSync(join(RUN, "launch.json"), "utf8")) as Launch;
// Tern panes take HOME from passwd, so omp only finds this home if passwd agrees.
if (userInfo().homedir !== homedir()) {
  throw new Error(`passwd home ${userInfo().homedir} differs from HOME ${homedir()}; the base image has a user with this uid`);
}
const agentDir = join(homedir(), ".omp", "agent");
mkdirSync(agentDir, { recursive: true });

// Credentials and providers stay owned by the configured host omp agent directory.
for (const file of ["agent.db", "models.db", "models.yml"]) {
  const source = join("/host-omp-agent", file);
  const target = join(agentDir, file);
  rmSync(target, { force: true });
  if (existsSync(source)) symlinkSync(source, target);
}
// Workflow context ships with the image and replaces whatever an older image left behind; the
// session's task, as the gateway wrote it for this start, follows it (TASK-6).
const taskFile = join(RUN, "task.md");
const task = existsSync(taskFile) ? `\n${readFileSync(taskFile, "utf8")}` : "";
writeFileSync(join(agentDir, "AGENTS.md"), `${readFileSync(join(IMAGE, "AGENTS.md"), "utf8")}${task}`);
copyFileSync(join(IMAGE, "RULES.md"), join(agentDir, "RULES.md"));
// setupVersion and last-changelog-version skip the first-run wizard and changelog screens.
writeFileSync(join(agentDir, "config.yml"), ["setupVersion: 2", "extensions:", `  - ${IMAGE}/omp-extension.ts`, ""].join("\n"));
const ompVersion = execFileSync("omp", ["--version"], { encoding: "utf8" }).trim().split(/[\s/]/).at(-1) ?? "";
writeFileSync(join(agentDir, "last-changelog-version"), `${ompVersion}\n`);

// The user's ssh keys, git identity and gh login, mounted read-only: copies, so ssh can keep
// known_hosts and gh its token, and ssh accepts the keys' permissions.
const credentials = "/host-credentials";
const ssh = join(homedir(), ".ssh");
rmSync(ssh, { recursive: true, force: true });
if (existsSync(join(credentials, "ssh"))) {
  cpSync(join(credentials, "ssh"), ssh, { recursive: true });
  chmodSync(ssh, 0o700);
  for (const entry of readdirSync(ssh, { withFileTypes: true })) chmodSync(join(ssh, entry.name), entry.isDirectory() ? 0o700 : 0o600);
}
rmSync(join(homedir(), ".gitconfig"), { force: true });
if (existsSync(join(credentials, "gitconfig"))) copyFileSync(join(credentials, "gitconfig"), join(homedir(), ".gitconfig"));
const gh = join(homedir(), ".config", "gh");
rmSync(gh, { recursive: true, force: true });
if (existsSync(join(credentials, "gh"))) {
  cpSync(join(credentials, "gh"), gh, { recursive: true });
  chmodSync(gh, 0o700);
}

// Under ACP omp asks before every tool call; --auto-approve keeps the TUI's default of not asking.
// Tern runs omp through acp-filter.ts, which leaves out file lists Tern cannot draw.
// Dark matches the monitor around the chat.
const ternConfig = join(homedir(), ".config", "tern");
mkdirSync(ternConfig, { recursive: true });
writeFileSync(join(ternConfig, "settings.json"), JSON.stringify({
  theme: "Dark",
  agents: { custom: [{ id: AGENT_ID, name: "omp", command: "node", args: ["/opt/agentmonitor/acp-filter.ts"] }] },
}));

// Wrangler wants Cloudflare's API over TCP; the gateway serves it on the session socket, which
// identifies the session, and holds the project's tokens. The token given here only keeps
// Wrangler from asking to log in; the gateway ignores it. Tern starts a pane's program with
// an environment of its own, so the chat's command line carries these to omp and its tools.
const chatEnv: string[] = [];
if (launch.cloudflare) {
  createServer((client) => {
    const upstream = connect(join(RUN, "am.sock"));
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.pipe(upstream).pipe(client);
  }).listen(CLOUDFLARE_PORT, "127.0.0.1");
  chatEnv.push(`CLOUDFLARE_API_BASE_URL=http://127.0.0.1:${CLOUDFLARE_PORT}/client/v4`, "CLOUDFLARE_API_TOKEN=agent-monitor");
}

// The daemon keeps its sessions next to its socket, in the run directory, which outlives the
// container. Each start runs the chat the launch file names instead of restoring the last one.
const daemonSocket = process.env.TERN_DAEMON_SOCKET;
if (daemonSocket === undefined) throw new Error("TERN_DAEMON_SOCKET is not set");
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
const chat = chatEnv.length === 0 ? ["tern", "acp", AGENT_ID] : ["env", ...chatEnv, "tern", "acp", AGENT_ID];
if (launch.model !== null) chat.push("--model", launch.model);
if (launch.resume !== null) chat.push("--resume", launch.resume);
execFileSync("tern", ["new", "session", "workspace", "--cwd", launch.cwd, "--keep-open", "--", ...chat], { stdio: "inherit" });

const web = spawn("tern", [
  "web", "serve",
  "--listen", "0.0.0.0:8377",
  "--token", join(RUN, "tern-token"),
  "--assets", join(IMAGE, "tern-web"),
  "--allow-origin", launch.ternOrigin,
], { stdio: "inherit" });
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    web.kill(signal);
    daemon.kill(signal);
  });
}
web.on("exit", (code) => process.exit(code ?? 1));
