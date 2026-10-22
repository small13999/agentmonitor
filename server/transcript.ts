import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

/** The live session's transcript: the newest top-level session file (subagent transcripts are nested). */
export function newestTranscript(ompHome: string): string | null {
  const sessions = join(ompHome, "agent", "sessions");
  if (!existsSync(sessions)) return null;
  let newest: { path: string; mtime: number } | null = null;
  for (const dir of readdirSync(sessions, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const file of readdirSync(join(sessions, dir.name), { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      const path = join(sessions, dir.name, file.name);
      const mtime = statSync(path).mtimeMs;
      if (newest === null || mtime > newest.mtime) newest = { path, mtime };
    }
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
