// AUTO-8: a trigger's check, in the session image (server/scheduler/gates.ts starts it): omp's
// `tiny` model, as the user's omp settings define it (SESSION-17), answers the prompt on stdin
// in one turn with read-only tools, the folder (the working directory) and the web, and prints
// its reply.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const credentials = process.env.AGENTMONITOR_OMP_AGENT;
if (credentials === undefined) throw new Error("AGENTMONITOR_OMP_AGENT is not set");
const agentDir = join(tmpdir(), "omp-agent");
mkdirSync(agentDir, { recursive: true });
// Credentials and providers stay owned by the configured omp agent directory, as in a session (launch.ts).
for (const file of ["agent.db", "models.db", "models.yml"]) {
  const source = join(credentials, file);
  if (existsSync(source)) symlinkSync(source, join(agentDir, file));
}
// The user's settings (model roles among them) apply, then this file's: no first-run screens.
writeFileSync(join(agentDir, "config.yml"), "setupVersion: 2\n");
const userConfig = join(credentials, "config.yml");
const configFiles = [...(existsSync(userConfig) ? [userConfig] : []), join(agentDir, "config.yml")];

const answered = spawnSync("omp", [
  "--print", "--no-session", "--no-extensions", "--no-skills",
  "--model", "@tiny",
  "--tools", "read,grep,glob,web_search",
  readFileSync(0, "utf8"),
], {
  stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_CONFIG_FILES: configFiles.join(":") },
});
if (answered.error !== undefined) throw answered.error;
process.exit(answered.status ?? 1);
