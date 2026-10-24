import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import type { ChatDraft } from "../../shared/chat.ts";
import { FileResponse } from "./http.ts";
import { StoreError, type Principal, type Store } from "./store.ts";

/**
 * CHAT-6: what each person has typed into each session's prompt box, a file per session and
 * person under the gateway's state directory, so it shows again after a reload, a lost
 * connection, or in another browser. A session that has ended keeps its drafts readable.
 */
export class Drafts {
  private readonly store: Store;
  private readonly root: string;

  constructor(store: Store, root: string) {
    this.store = store;
    this.root = root;
  }

  /** The person's draft file of a session they may see; agents have no prompt box. */
  private file(principal: Principal, sessionId: string): string {
    if (principal.kind !== "human") throw new StoreError(403, "drafts are people's: an agent has no prompt box");
    this.store.getSession(principal, sessionId);
    return join(this.root, sessionId, `${principal.personId}.json`);
  }

  /** The draft as the API's envelope, its file's bytes as they are: it was valid when written, and can be large. */
  get(principal: Principal, sessionId: string): FileResponse | null {
    let saved: Buffer;
    try {
      saved = readFileSync(this.file(principal, sessionId));
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;
      throw cause;
    }
    return new FileResponse(
      200,
      { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
      Readable.from([Buffer.from('{"ok":true,"data":'), saved, Buffer.from("}\n")]),
    );
  }

  /** Saves the draft, replacing the file at once (a reader never sees half of it); an empty one deletes it. */
  put(principal: Principal, sessionId: string, draft: ChatDraft): null {
    const path = this.file(principal, sessionId);
    if (draft.text === "" && draft.attachments.length === 0) {
      rmSync(path, { force: true });
      return null;
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const staging = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(staging, JSON.stringify(draft), { mode: 0o600 });
      renameSync(staging, path);
    } catch (cause) {
      rmSync(staging, { force: true });
      throw cause;
    }
    return null;
  }

  /** Removes every draft of a session that is no longer in the store. */
  delete(sessionId: string): void {
    rmSync(join(this.root, sessionId), { recursive: true, force: true });
  }
}
