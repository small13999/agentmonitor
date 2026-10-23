import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

/** The working directory a chat ran in, from its header; null if the header has none. */
function chatCwd(path: string): string | null {
  const buffer = Buffer.alloc(4096);
  const fd = openSync(path, "r");
  let read: number;
  try {
    read = readSync(fd, buffer, 0, buffer.length, 0);
  } finally {
    closeSync(fd);
  }
  // The header's first lines: a title, then the session entry with its cwd.
  for (const line of buffer.subarray(0, read).toString("utf8").split("\n").slice(0, 3)) {
    const escaped = /^\{"type":"session",.*?"cwd":"((?:[^"\\]|\\.)*)"/.exec(line)?.[1];
    if (escaped === undefined) continue;
    const cwd: unknown = JSON.parse(`"${escaped}"`);
    return typeof cwd === "string" ? cwd : null;
  }
  return null;
}

/**
 * The live session's transcript: the newest top-level session file (subagent transcripts are
 * nested). With `cwd`, only chats that ran there count: a checkout session's chats sit among
 * all of the user's (HOST-7).
 */
export function newestTranscript(ompHome: string, cwd: string | null): string | null {
  const sessions = join(ompHome, "agent", "sessions");
  if (!existsSync(sessions)) return null;
  let newest: { path: string; mtime: number } | null = null;
  for (const dir of readdirSync(sessions, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    // omp keeps the chats of one working directory per folder; its newest chat tells which.
    let folderNewest: { path: string; mtime: number } | null = null;
    for (const file of readdirSync(join(sessions, dir.name), { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      const path = join(sessions, dir.name, file.name);
      const mtime = statSync(path).mtimeMs;
      if (folderNewest === null || mtime > folderNewest.mtime) folderNewest = { path, mtime };
    }
    if (folderNewest === null || (newest !== null && folderNewest.mtime <= newest.mtime)) continue;
    if (cwd === null || chatCwd(folderNewest.path) === cwd) newest = folderNewest;
  }
  return newest?.path ?? null;
}

/** omp's message objects from the message entries in the last `tailBytes` of a transcript, oldest first. */
export function readTranscript(path: string, tailBytes: number): unknown[] {
  const size = statSync(path).size;
  const start = Math.max(0, size - tailBytes);
  const buffer = Buffer.alloc(size - start);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    closeSync(fd);
  }
  const lines = buffer.toString("utf8").split("\n");
  // A tail that starts mid-file starts mid-line.
  if (start > 0) lines.shift();
  const messages: unknown[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry === "object" && entry !== null && "type" in entry && entry.type === "message" && "message" in entry) {
      messages.push(entry.message);
    }
  }
  return messages;
}
