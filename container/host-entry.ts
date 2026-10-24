// Host session entry (HOST-2): the agent runs on the gateway's machine as the user, in its
// own worktree, with the user's credentials and tools. Everything Agent Monitor writes for
// the session stays in its own directories: omp's agent directory in the session's omp home,
// `am` in the run directory. The user's ~/.omp, ~/.ssh, ~/.gitconfig and gh login are only
// read, by the agent's own tools (HOST-5); a session in the main checkout keeps its chats among
// the user's omp chats, as omp there does (HOST-7). The gateway starts it with the session's
// environment (server/runtime/host.ts): AGENTMONITOR_SESSION marks every process of the
// session, so ending it stops them all, including servers the agent started.
// Usage: AGENTMONITOR_SESSION=ID node host-entry.ts RUN_DIR AGENT_DIR OMP_CREDENTIALS
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startSession } from "./launch.ts";

const [run, agentDir, ompCredentials] = process.argv.slice(2);
const sessionId = process.env.AGENTMONITOR_SESSION;
if (run === undefined || agentDir === undefined || ompCredentials === undefined || sessionId === undefined) {
  throw new Error("usage: AGENTMONITOR_SESSION=ID node host-entry.ts RUN_DIR AGENT_DIR OMP_CREDENTIALS");
}
const source = dirname(fileURLToPath(import.meta.url));
console.log(`${new Date().toISOString()} starting host session ${sessionId}`);

// `am` for the agent, ahead of anything else on its PATH.
const bin = join(run, "bin");
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, "am"), `#!/bin/sh\nexec node ${join(source, "am.ts")} "$@"\n`);
chmodSync(join(bin, "am"), 0o755);

await startSession({ run, source, agentDir, ompCredentials, env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
