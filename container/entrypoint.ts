// Workspace container entrypoint: give the container's home the user's credentials, then
// start the session (launch.ts). Runs as PID 1 under `podman run --init`.
import { chmodSync, copyFileSync, cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { startSession } from "./launch.ts";

// Tern panes take HOME from passwd, so omp only finds this home if passwd agrees.
if (userInfo().homedir !== homedir()) {
  throw new Error(`passwd home ${userInfo().homedir} differs from HOME ${homedir()}; the base image has a user with this uid`);
}

// The user's ssh keys, git identity and gh login, mounted read-only: copies, so ssh can keep
// known_hosts and gh its token, and ssh accepts the keys' permissions. The home is the
// container's own (/home/agent), never the user's.
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

const image = "/opt/agentmonitor";
await startSession({
  run: "/run/agentmonitor",
  source: image,
  agentDir: join(homedir(), ".omp", "agent"),
  ompCredentials: "/host-omp-agent",
  ternConfig: join(homedir(), ".config", "tern"),
  ternAssets: join(image, "tern-web"),
  chatEnv: [],
});
