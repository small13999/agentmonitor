import { useEffect, useState, type DragEvent, type SubmitEvent } from "react";
import { api, storeUrl, usePolled, type FolderFile } from "./api.ts";
import { Markdown } from "./Markdown.tsx";
import { ActorName, type Directory } from "./People.tsx";

/** A text file shows up to this much; the rest is a download away. Larger files are not edited here. */
const TEXT_PREVIEW_BYTES = 1024 * 1024;

/** FOLDER-1, AUTO-1: whose folder: a task's, or an automation's (shared by all its runs). */
export interface FolderOwner {
  kind: "task" | "automation";
  id: string;
}

/** The owner's folder route in the store API: `/tasks/<id>/folder` or `/automations/<id>/folder`. */
export function folderRoute(owner: FolderOwner): string {
  return `/${owner.kind}s/${owner.id}/folder`;
}

/** A folder file's store route: its path's segments, each URL-encoded. */
export function fileRoute(owner: FolderOwner, path: string): string {
  return `${folderRoute(owner)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** A folder file's URL, inline; `download` makes it an attachment. */
export function fileUrl(owner: FolderOwner, file: FolderFile, download = false): string {
  // The modification time in the URL shows a file again once it changed.
  return `${storeUrl(fileRoute(owner, file.path))}?${download ? "download&" : ""}v=${file.updatedAt}`;
}

export function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function mediaType(file: FolderFile): string {
  return file.contentType.split(";")[0];
}

/** Text the page shows as text and edits in place. */
function isText(file: FolderFile): boolean {
  const type = mediaType(file);
  return type.startsWith("text/") || type === "application/json";
}

/** The start of a text file, read through a byte range so a large log does not stall the page. */
function TextPreview({ url, markdown }: { url: string; markdown: boolean }) {
  const [text, setText] = useState<{ body: string; cut: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setText(null);
    fetch(url, { headers: { range: `bytes=0-${TEXT_PREVIEW_BYTES - 1}` } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const body = await response.text();
        const total = Number(/\/(\d+)$/.exec(response.headers.get("content-range") ?? "")?.[1] ?? 0);
        if (!cancelled) setText({ body, cut: response.status === 206 && total > TEXT_PREVIEW_BYTES });
      })
      .catch((cause: Error) => { if (!cancelled) setError(cause.message); });
    return () => { cancelled = true; };
  }, [url]);
  if (error !== null) return <p className="error">{error}</p>;
  if (text === null) return <p className="muted">Loading…</p>;
  return (
    <>
      {markdown ? <Markdown text={text.body} /> : <pre className="folder-text">{text.body}</pre>}
      {text.cut && <p className="muted small">Shows the first {sizeOf(TEXT_PREVIEW_BYTES)}; download the file for the rest.</p>}
    </>
  );
}

/** FOLDER-2: a file shown inline by its kind. */
export function Preview({ owner, file }: { owner: FolderOwner; file: FolderFile }) {
  const url = fileUrl(owner, file);
  const type = mediaType(file);
  if (type.startsWith("image/")) return <img className="folder-media" src={url} alt={file.path} />;
  if (type.startsWith("video/")) return <video className="folder-media" src={url} controls aria-label={file.path} />;
  if (type === "application/pdf") return <iframe className="folder-pdf" src={url} title={file.path} />;
  if (type === "text/markdown") return <TextPreview url={url} markdown />;
  if (isText(file)) return <TextPreview url={url} markdown={false} />;
  return <p className="muted">This kind of file does not show here; download it.</p>;
}

/**
 * A text file written in place: an existing one (`file`) loads first; a new one (`file` null)
 * is named here. Saving puts the text into the folder as the file.
 */
function TextEditor({ owner, file, onSaved, onCancel }: { owner: FolderOwner; file: FolderFile | null; onSaved: (path: string) => void; onCancel: () => void }) {
  const [text, setText] = useState<string | null>(file === null ? "" : null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (file === null) return;
    let cancelled = false;
    fetch(fileUrl(owner, file))
      .then(async (response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const body = await response.text();
        if (!cancelled) setText(body);
      })
      .catch((cause: Error) => { if (!cancelled) setError(cause.message); });
    return () => { cancelled = true; };
    // Once: a change the folder's agents make meanwhile does not replace what is being written.
  }, []);
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const path = file?.path ?? String(new FormData(event.currentTarget).get("path")).trim();
    setSaving(true);
    setError(null);
    api<FolderFile>("PUT", fileRoute(owner, path), new Blob([text ?? ""], { type: "text/plain" })).then(
      () => { setSaving(false); onSaved(path); },
      (cause: Error) => { setSaving(false); setError(cause.message); },
    );
  };
  return (
    <form className="folder-editor edit-task" onSubmit={submit} aria-label={file === null ? "New file" : `Edit ${file.path}`}>
      {file === null
        ? <label>Name<input name="path" required autoFocus placeholder="memory.md" /></label>
        : <h4>{file.path}</h4>}
      {text === null && error === null
        ? <p className="muted">Loading…</p>
        : <textarea rows={12} value={text ?? ""} onChange={(event) => setText(event.target.value)} aria-label="Text" autoFocus={file !== null} />}
      {error && <p className="error small">{error}</p>}
      <div className="actions">
        <button type="submit" disabled={saving || text === null}>{saving ? "Saving…" : "Save file"}</button>
        <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/**
 * FOLDER-1, FOLDER-2, AUTO-1: a task's or an automation's folder: files dropped here (or
 * chosen) upload into it, and text files are written in place; each shows who added it and
 * when, opens inline by kind, and downloads, as does the whole folder as a zip. What the
 * owner's agents write into the folder's directory shows here within a poll (FOLDER-3).
 */
export function Folder({ owner, directory, hint }: { owner: FolderOwner; directory: Directory; hint: string }) {
  const files = usePolled<FolderFile[]>(folderRoute(owner), 2_000);
  const [shown, setShown] = useState<string | null>(null);
  // The file being written in place; "new" a file not there yet.
  const [editing, setEditing] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = async (chosen: File[]) => {
    setError(null);
    setUploading(chosen.map((file) => file.name));
    try {
      for (const file of chosen) {
        await api<FolderFile>("PUT", fileRoute(owner, file.name), file).catch((cause: Error) => {
          throw new Error(`${file.name}: ${cause.message}`);
        });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setUploading([]);
      files.refresh();
    }
  };

  const remove = (path: string) => {
    if (!window.confirm(`Delete ${path} from the ${owner.kind}'s folder?`)) return;
    if (shown === path) setShown(null);
    if (editing === path) setEditing(null);
    api<FolderFile[]>("DELETE", fileRoute(owner, path)).then(files.refresh, (cause: Error) => setError(cause.message));
  };

  const drop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    const dropped = [...event.dataTransfer.files];
    if (dropped.length > 0) void upload(dropped);
  };

  const saved = (path: string) => {
    setEditing(null);
    setShown(path);
    files.refresh();
  };

  const list = files.data ?? [];
  const current = list.find((file) => file.path === shown) ?? null;
  const edited = editing === "new" ? null : list.find((file) => file.path === editing) ?? null;
  return (
    <section
      className={`folder${dragging ? " dragging" : ""}`}
      aria-label="Folder"
      onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
      onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
      onDrop={drop}
    >
      <header className="folder-head">
        <h3>Folder</h3>
        <span className="muted small">{hint}</span>
        <label className="button">
          Add files
          <input type="file" multiple hidden onChange={(event) => { void upload([...(event.target.files ?? [])]); event.target.value = ""; }} />
        </label>
        <button type="button" className="button" onClick={() => setEditing("new")}>New file</button>
        {list.length > 0 && <a className="button" href={storeUrl(`${folderRoute(owner)}.zip`)} download>Download all (.zip)</a>}
      </header>
      {error && <p className="error">{error}</p>}
      {files.error && <p className="error">{files.error}</p>}
      {uploading.length > 0 && <p className="muted small" aria-live="polite">Uploading {uploading.join(", ")}…</p>}
      {editing !== null && (editing === "new" || edited !== null) && (
        <TextEditor key={editing} owner={owner} file={edited} onSaved={saved} onCancel={() => setEditing(null)} />
      )}
      {files.data === null ? (
        <p className="muted">Loading…</p>
      ) : list.length === 0 ? (
        <p className="muted folder-empty">No files yet.</p>
      ) : (
        <table className="folder-files">
          <thead>
            <tr><th>Name</th><th>Size</th><th>Added by</th><th>When</th><th><span hidden>Actions</span></th></tr>
          </thead>
          <tbody>
            {list.map((file) => (
              <tr key={file.path} aria-current={file.path === shown ? "true" : undefined}>
                <td>
                  <button type="button" className="ghost file-name" onClick={() => setShown(file.path === shown ? null : file.path)}>{file.path}</button>
                </td>
                <td className="muted">{sizeOf(file.size)}</td>
                <td>{file.addedBy === null ? <span className="muted">unknown</span> : <ActorName actor={file.addedBy} directory={directory} />}</td>
                <td className="muted"><time dateTime={new Date(file.addedAt).toISOString()}>{new Date(file.addedAt).toLocaleString()}</time></td>
                <td className="file-actions">
                  {isText(file) && file.size <= TEXT_PREVIEW_BYTES && (
                    <button type="button" className="ghost" aria-label={`Edit ${file.path}`} onClick={() => setEditing(file.path)}>Edit</button>
                  )}
                  <a href={fileUrl(owner, file, true)} download={file.path.split("/").pop()} aria-label={`Download ${file.path}`}>Download</a>
                  <button type="button" className="ghost danger" aria-label={`Delete ${file.path}`} onClick={() => remove(file.path)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {current !== null && (
        <figure className="folder-preview" aria-label={`Preview of ${current.path}`}>
          <figcaption>{current.path}</figcaption>
          <Preview owner={owner} file={current} />
        </figure>
      )}
    </section>
  );
}
