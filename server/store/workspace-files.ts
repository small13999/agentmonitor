import { constants } from "node:fs";
import { open, readlink, realpath, type FileHandle } from "node:fs/promises";
import { join, posix, sep } from "node:path";
import { contentTypeOf } from "./folders.ts";
import { FileResponse } from "./http.ts";
import { StoreError } from "./store.ts";

/** A directory of a session's workspace as its agent sees it (`/workspace/<repo>`, `/task-folder`) and where it is on the gateway's machine. */
export interface WorkspaceRoot {
  agent: string;
  host: string;
}

/** A workspace file never runs as a page: no script, only its own images and inline styles (an SVG's). */
const FILE_POLICY = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";

/**
 * CHAT-5: a file of a session's workspace, for the images and links of the agent's replies.
 * `path` is as the agent sees it: absolute, or relative to its working directory `cwd`. Only
 * files under the roots are served; a link may point anywhere under them, never out of them.
 */
export async function workspaceFile(roots: WorkspaceRoot[], cwd: string, path: string): Promise<FileResponse> {
  const missing = new StoreError(404, `the session's workspace has no file ${path}`);
  const wanted = posix.resolve(cwd, path);
  // The innermost root, should one hold another.
  const root = roots
    .filter((candidate) => wanted === candidate.agent || wanted.startsWith(`${candidate.agent}/`))
    .sort((a, b) => b.agent.length - a.agent.length)[0];
  if (root === undefined) throw missing;
  const allowed = (await Promise.all(roots.map((candidate) => realpath(candidate.host).catch(() => null)))).filter((dir) => dir !== null);
  let handle: FileHandle;
  try {
    handle = await open(join(root.host, wanted.slice(root.agent.length)), constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    throw missing;
  }
  // Where the opened file really is, links resolved, so no link swapped in meanwhile leads out.
  const opened = await readlink(`/proc/self/fd/${handle.fd}`);
  const stats = await handle.stat();
  if (!allowed.some((dir) => opened.startsWith(dir + sep)) || !stats.isFile()) {
    await handle.close();
    throw missing;
  }
  return new FileResponse(200, {
    "content-type": contentTypeOf(opened),
    "content-length": String(stats.size),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": FILE_POLICY,
  }, handle.createReadStream());
}

/** Image types by their first bytes: a blob has no name to go by. */
function imageType(head: Buffer): string {
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (head.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return "application/octet-stream";
}

/**
 * CHAT-4: an image of a prompt as omp keeps it in its session file, `blob:sha256:<hash>`: the
 * bytes in the first of `dirs` (omp's blob stores) that has them. Content-addressed, so it
 * never changes. The content type comes from the bytes, never from the asker.
 */
export async function blobFile(dirs: string[], hash: string): Promise<FileResponse> {
  for (const dir of dirs) {
    let handle: FileHandle;
    try {
      handle = await open(join(dir, hash), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
      continue;
    }
    const stats = await handle.stat();
    if (!stats.isFile()) {
      await handle.close();
      continue;
    }
    const head = Buffer.alloc(12);
    await handle.read(head, 0, head.length, 0);
    return new FileResponse(200, {
      "content-type": imageType(head),
      "content-length": String(stats.size),
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": FILE_POLICY,
    }, handle.createReadStream({ start: 0 }));
  }
  throw new StoreError(404, `the session has no image ${hash}`);
}
