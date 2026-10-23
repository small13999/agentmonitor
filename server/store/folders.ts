import { randomUUID } from "node:crypto";
import { constants, copyFileSync, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, utimesSync } from "node:fs";
import { open, readlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, extname, join, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32 } from "node:zlib";
import { FileResponse } from "./http.ts";
import { StoreError, type FolderEntry, type FolderFile, type FolderOwner, type Principal, type Store } from "./store.ts";

/** Content types by extension; they decide how the page shows a file (FOLDER-2). Others are plain bytes. */
const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".ogv": "video/ogg",
  ".pdf": "application/pdf",
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ...Object.fromEntries([
    ".txt", ".log", ".tsv", ".yaml", ".yml", ".toml", ".ini", ".xml", ".css", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
    ".py", ".rb", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".sh", ".sql", ".diff", ".patch",
  ].map((extension) => [extension, "text/plain; charset=utf-8"])),
};

export function contentTypeOf(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** Plain zip (no ZIP64): every size and offset in it fits 32 bits. */
const ZIP_MAX_BYTES = 0xffff_ffff;

/**
 * FOLDER-1: a folder path as a route carries it: URL-encoded `/`-separated segments, none
 * empty, `.` or `..`; decoded, joined by `/`.
 */
function folderPath(encoded: string): string {
  const segments = encoded.split("/").map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      throw new StoreError(400, "the file path is not valid URL encoding");
    }
  });
  const bad = segments.some((segment) => segment === "" || segment === "." || segment === ".." || /[/\0]/.test(segment) || Buffer.byteLength(segment) > 255);
  if (bad || segments.length > 32) throw new StoreError(400, `"${segments.join("/")}" is not a file path in a folder`);
  return segments.join("/");
}

/** Every regular file under `dir`; links and special files are not the folder's (an agent can make those). */
function scan(dir: string, prefix = ""): FolderEntry[] {
  const entries: FolderEntry[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      entries.push(...scan(dir, path));
    } else if (entry.isFile()) {
      const found = lstatSync(join(dir, path), { throwIfNoEntry: false });
      if (found?.isFile()) entries.push({ path, size: found.size, contentType: contentTypeOf(path), modifiedAt: Math.floor(found.mtimeMs) });
    }
  }
  return entries;
}

/**
 * The regular file at `path` in `dir`, open for reading; null when there is none, or when
 * the path leads out of the folder through a link: what it opened is checked, not the path.
 * O_NONBLOCK keeps a FIFO from blocking the open.
 */
async function openInside(dir: string, path: string): Promise<FileHandle | null> {
  let handle: FileHandle;
  try {
    handle = await open(join(dir, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  const opened = await readlink(`/proc/self/fd/${handle.fd}`);
  if (!opened.startsWith(realpathSync(dir) + sep) || !(await handle.stat()).isFile()) {
    await handle.close();
    return null;
  }
  return handle;
}

/** What every file answer carries: a file never runs as a page of the app's origin. */
function fileHeaders(path: string, contentType: string, attachment: boolean): Record<string, string> {
  return {
    "content-type": contentType,
    "content-disposition": `${attachment ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(basename(path))}`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    // Chrome does not show PDFs in a sandboxed document; its viewer runs no page script anyway.
    ...(contentType === "application/pdf" ? {} : { "content-security-policy": "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'" }),
  };
}

/** A single `Range: bytes=…` as an inclusive [start, end]; null for the whole file; "unsatisfiable" past its end. */
function byteRange(header: string | undefined, size: number): [number, number] | null | "unsatisfiable" {
  const match = header === undefined ? null : /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null || size === 0 || (match[1] === "" && match[2] === "")) return null;
  const [start, end] = match[1] === ""
    ? [Math.max(0, size - Number(match[2])), size - 1]
    : [Number(match[1]), match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1)];
  return start > end || start >= size ? "unsatisfiable" : [start, end];
}

function dosDateTime(ms: number): { time: number; date: number } {
  const at = new Date(Math.max(ms, Date.UTC(1980, 0, 1)));
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1),
    date: ((at.getFullYear() - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  };
}

/**
 * FOLDER-2: the files as one zip, streamed: stored (folder files are mostly images and video,
 * which do not shrink), each followed by a data descriptor with its CRC and size as read. Each
 * is named by its path without `prefix`, the subfolder the zip holds.
 */
async function* zipOf(dir: string, files: FolderFile[], prefix: string): AsyncGenerator<Buffer> {
  // Bit 3: sizes and CRC follow the data; bit 11: names are UTF-8.
  const flags = 0x0808;
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const handle = await openInside(dir, file.path);
    if (handle === null) continue;
    const name = Buffer.from(file.path.slice(prefix.length), "utf8");
    const { time, date } = dosDateTime(file.updatedAt);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt16LE(name.length, 26);
    const start = offset;
    yield Buffer.concat([local, name]);
    offset += local.length + name.length;
    let crc = 0;
    let size = 0;
    for await (const chunk of handle.createReadStream()) {
      if (!Buffer.isBuffer(chunk)) throw new Error("a file read yielded text");
      crc = crc32(chunk, crc);
      size += chunk.length;
      if (offset + size > ZIP_MAX_BYTES) throw new Error("the folder grew past what a zip holds");
      yield chunk;
    }
    offset += size;
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(size, 8);
    descriptor.writeUInt32LE(size, 12);
    yield descriptor;
    offset += descriptor.length;
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(0x0314, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(flags, 8);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(size, 20);
    entry.writeUInt32LE(size, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    entry.writeUInt32LE(start, 42);
    central.push(entry, name);
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  yield Buffer.concat([directory, end]);
}

/**
 * FOLDER-1..3, AUTO-1: every task's and every automation's folder, a directory per owner (by its
 * id) under the gateway's state directory, outside any repository. The store records who added
 * each file and when; the directory is what counts, since a session's agent writes into it
 * directly (FOLDER-3), so every read brings the records in line with it first.
 */
export class Folders {
  private readonly store: Store;
  private readonly root: string;

  constructor(store: Store, root: string) {
    this.store = store;
    this.root = root;
  }

  /** The owner's folder on this machine, created on first use. */
  dir(owner: FolderOwner): string {
    const dir = join(this.root, owner.id);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** The owner's files as its folder holds them now, by path. */
  sync(owner: FolderOwner): FolderFile[] {
    return this.store.syncFolder(owner, scan(this.dir(owner)));
  }

  /**
   * STORE-6: `from`, a directory on this filesystem holding a moved task's or automation's
   * folder, becomes its folder, its files modified when the records say; refused when it has
   * files here.
   */
  adopt(owner: FolderOwner, from: string, files: Array<{ path: string; updatedAt: number }>): void {
    mkdirSync(this.root, { recursive: true });
    try {
      renameSync(from, join(this.root, owner.id));
    } catch (cause) {
      throw new StoreError(409, `${owner.kind} ${owner.id} already has a folder here: ${String(cause)}`);
    }
    for (const file of files) {
      const path = join(this.root, owner.id, file.path);
      // Half a millisecond on: seconds as a double are inexact, and the folder counts modification times in whole milliseconds.
      const at = (file.updatedAt + 0.5) / 1000;
      if (lstatSync(path, { throwIfNoEntry: false })?.isFile()) utimesSync(path, at, at);
    }
  }

  /** STORE-6: removes the folder of a task or an automation that is no longer in this store. */
  delete(owner: FolderOwner): void {
    rmSync(join(this.root, owner.id), { recursive: true, force: true });
  }

  list(principal: Principal, owner: FolderOwner): FolderFile[] {
    this.store.folderName(principal, owner);
    return this.sync(owner);
  }

  /**
   * AUTO-12: copies the files under `dir` of one folder into the same directory of another, as
   * added now by `principal`, replacing files of the same path there; answers the copies. Links
   * are not copied (scan).
   */
  copy(principal: Principal, from: FolderOwner, dir: string, to: FolderOwner): FolderFile[] {
    this.store.folderName(principal, from);
    this.store.folderName(principal, to);
    const source = join(this.dir(from), dir);
    if (!existsSync(source)) return [];
    const target = join(this.dir(to), dir);
    for (const file of scan(source)) {
      mkdirSync(dirname(join(target, file.path)), { recursive: true });
      copyFileSync(join(source, file.path), join(target, file.path));
    }
    return scan(target).map((file) => this.store.addFolderFile(principal, to, { ...file, path: `${dir}/${file.path}` }));
  }

  /**
   * Streams `body` into the folder as `path`, replacing a file there. It lands in a staging
   * directory first, so the folder never shows a partial file, and moves in only through
   * real directories of the folder, never through a link.
   */
  async upload(principal: Principal, owner: FolderOwner, encodedPath: string, body: Readable): Promise<FolderFile> {
    this.store.folderName(principal, owner);
    const path = folderPath(encodedPath);
    const staging = join(this.root, ".uploads");
    mkdirSync(staging, { recursive: true });
    const temp = join(staging, randomUUID());
    try {
      await pipeline(body, createWriteStream(temp, { flags: "wx" }));
      let target = realpathSync(this.dir(owner));
      const segments = path.split("/");
      for (const segment of segments.slice(0, -1)) {
        target = join(target, segment);
        const found = lstatSync(target, { throwIfNoEntry: false });
        if (found === undefined) mkdirSync(target);
        else if (!found.isDirectory()) throw new StoreError(409, `${path}: ${segment} is a file, not a folder`);
      }
      target = join(target, segments[segments.length - 1]);
      if (lstatSync(target, { throwIfNoEntry: false })?.isDirectory()) throw new StoreError(409, `${path} is a folder`);
      renameSync(temp, target);
      const written = lstatSync(target);
      return this.store.addFolderFile(principal, owner, { path, size: written.size, contentType: contentTypeOf(path), modifiedAt: Math.floor(written.mtimeMs) });
    } finally {
      rmSync(temp, { force: true });
    }
  }

  /** FOLDER-2: one file, inline with its content type or as an attachment; a single byte range for video. */
  async download(principal: Principal, owner: FolderOwner, encodedPath: string, range: string | undefined, attachment: boolean): Promise<FileResponse> {
    this.store.folderName(principal, owner);
    const path = folderPath(encodedPath);
    const handle = await openInside(this.dir(owner), path);
    if (handle === null) throw new StoreError(404, `the ${owner.kind}'s folder has no file ${path}`);
    const { size } = await handle.stat();
    const headers = { ...fileHeaders(path, contentTypeOf(path), attachment), "accept-ranges": "bytes" };
    const wanted = byteRange(range, size);
    if (wanted === "unsatisfiable") {
      await handle.close();
      return new FileResponse(416, { ...headers, "content-range": `bytes */${size}` }, Readable.from([]));
    }
    if (wanted === null) return new FileResponse(200, { ...headers, "content-length": String(size) }, handle.createReadStream());
    const [start, end] = wanted;
    return new FileResponse(
      206,
      { ...headers, "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${size}` },
      handle.createReadStream({ start, end }),
    );
  }

  /** Deletes a file, never what a link in the folder points to; answers the files left. */
  remove(principal: Principal, owner: FolderOwner, encodedPath: string): FolderFile[] {
    this.store.folderName(principal, owner);
    const path = folderPath(encodedPath);
    const dir = realpathSync(this.dir(owner));
    let parent: string;
    try {
      parent = realpathSync(join(dir, dirname(path)));
    } catch {
      throw new StoreError(404, `the ${owner.kind}'s folder has no file ${path}`);
    }
    const target = join(parent, basename(path));
    if ((parent !== dir && !parent.startsWith(dir + sep)) || !lstatSync(target, { throwIfNoEntry: false })?.isFile()) {
      throw new StoreError(404, `the ${owner.kind}'s folder has no file ${path}`);
    }
    unlinkSync(target);
    return this.sync(owner);
  }

  /**
   * FOLDER-2: the whole folder as a zip named after its task or automation; AUTO-7: with `under`,
   * only that subfolder (a run's outputs, `runs/<run>`), its files named as in it.
   */
  zip(principal: Principal, owner: FolderOwner, under: string | null): FileResponse {
    const title = this.store.folderName(principal, owner);
    const prefix = under === null ? "" : `${under}/`;
    const files = this.sync(owner).filter((file) => file.path.startsWith(prefix));
    if (under !== null && files.length === 0) throw new StoreError(404, `the ${owner.kind}'s folder has no files in ${under}`);
    // Per file: local header, data descriptor, and directory entry (30 + 16 + 46 bytes) and its name twice.
    const total = files.reduce((sum, file) => sum + 92 + 2 * Buffer.byteLength(file.path) + file.size, 22);
    if (total > ZIP_MAX_BYTES) throw new StoreError(413, "the folder is too large for one zip; download its files one by one");
    const named = under === null ? title : `${title} ${basename(under)}`;
    const name = `${named.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-|-$/g, "") || "folder"}.zip`;
    return new FileResponse(200, {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      "cache-control": "no-store",
    }, Readable.from(zipOf(this.dir(owner), files, prefix)));
  }
}
