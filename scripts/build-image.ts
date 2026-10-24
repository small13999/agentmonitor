// Build the workspace image from container/ plus this machine's omp binary.
// Usage: node scripts/build-image.ts [--base IMAGE]
// Env: AGENTMONITOR_OMP_BIN overrides the binary; AGENTMONITOR_WORKSPACE_IMAGE the image's tag.
import { execFileSync } from "node:child_process";
import { copyFileSync, linkSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WORKSPACE_IMAGE } from "../server/runtime/podman.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function which(command: string): string {
  return execFileSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" }).trim();
}

/** Hard links keep the binary out of the copy when the cache shares a filesystem. */
function stage(source: string, target: string): void {
  rmSync(target, { force: true });
  try {
    linkSync(source, target);
  } catch {
    copyFileSync(source, target);
  }
}

export function buildImage(options: { base?: string; quiet?: boolean } = {}): void {
  const context = join(homedir(), ".cache", "agentmonitor", "image-context");
  rmSync(context, { recursive: true, force: true });
  mkdirSync(context, { recursive: true });
  for (const file of readdirSync(join(root, "container"))) stage(join(root, "container", file), join(context, file));
  stage(realpathSync(process.env.AGENTMONITOR_OMP_BIN ?? which("omp")), join(context, "omp"));
  const args = ["build", "-t", WORKSPACE_IMAGE, "-f", join(context, "Containerfile")];
  if (options.base !== undefined) args.push("--build-arg", `BASE=${options.base}`);
  if (options.quiet === true) args.push("--quiet");
  execFileSync("podman", [...args, context], { stdio: options.quiet === true ? ["ignore", "ignore", "inherit"] : "inherit" });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const baseIndex = process.argv.indexOf("--base");
  buildImage({ base: baseIndex === -1 ? undefined : process.argv[baseIndex + 1] });
}
