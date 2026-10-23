import { useEffect, useState, type DragEvent } from "react";
import { api, storeUrl, usePolled, type FolderFile } from "./api.ts";
import { Markdown } from "./Markdown.tsx";
import { ActorName, type Directory } from "./People.tsx";

/** A text file shows up to this much; the rest is a download away. */
const TEXT_PREVIEW_BYTES = 1024 * 1024;

/** A folder file's store route: its path's segments, each URL-encoded. */
function fileRoute(taskId: string, path: string): string {
  return `/tasks/${taskId}/folder/${path.split("/").map(encodeURIComponent).join("/")}`;
}

function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
function Preview({ taskId, file }: { taskId: string; file: FolderFile }) {
  // The modification time in the URL shows a file again once it changed.
  const url = `${storeUrl(fileRoute(taskId, file.path))}?v=${file.updatedAt}`;
  const type = file.contentType.split(";")[0];
  if (type.startsWith("image/")) return <img className="folder-media" src={url} alt={file.path} />;
  if (type.startsWith("video/")) return <video className="folder-media" src={url} controls aria-label={file.path} />;
  if (type === "application/pdf") return <iframe className="folder-pdf" src={url} title={file.path} />;
  if (type === "text/markdown") return <TextPreview url={url} markdown />;
  if (type.startsWith("text/") || type === "application/json") return <TextPreview url={url} markdown={false} />;
  return <p className="muted">This kind of file does not show here; download it.</p>;
}

/**
 * FOLDER-1, FOLDER-2: the task's folder: files dropped here (or chosen) upload into it; each
 * shows who added it and when, opens inline by kind, and downloads, as does the whole folder
 * as a zip. What the task's agent writes into the folder's directory shows here within a poll
 * (FOLDER-3).
 */
export function TaskFolder({ taskId, directory }: { taskId: string; directory: Directory }) {
  const files = usePolled<FolderFile[]>(`/tasks/${taskId}/folder`, 2_000);
  const [shown, setShown] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = async (chosen: File[]) => {
    setError(null);
    setUploading(chosen.map((file) => file.name));
    try {
      for (const file of chosen) {
        await api<FolderFile>("PUT", fileRoute(taskId, file.name), file).catch((cause: Error) => {
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
    if (!window.confirm(`Delete ${path} from the task's folder?`)) return;
    if (shown === path) setShown(null);
    api<FolderFile[]>("DELETE", fileRoute(taskId, path)).then(files.refresh, (cause: Error) => setError(cause.message));
  };

  const drop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    const dropped = [...event.dataTransfer.files];
    if (dropped.length > 0) void upload(dropped);
  };

  const list = files.data ?? [];
  const current = list.find((file) => file.path === shown) ?? null;
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
        <span className="muted small">Drop files here to add them; the task's agent finds them in its folder.</span>
        <label className="button">
          Add files
          <input type="file" multiple hidden onChange={(event) => { void upload([...(event.target.files ?? [])]); event.target.value = ""; }} />
        </label>
        {list.length > 0 && <a className="button" href={storeUrl(`/tasks/${taskId}/folder.zip`)} download>Download all (.zip)</a>}
      </header>
      {error && <p className="error">{error}</p>}
      {files.error && <p className="error">{files.error}</p>}
      {uploading.length > 0 && <p className="muted small" aria-live="polite">Uploading {uploading.join(", ")}…</p>}
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
                  <a href={`${storeUrl(fileRoute(taskId, file.path))}?download`} download={file.path.split("/").pop()} aria-label={`Download ${file.path}`}>Download</a>
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
          <Preview taskId={taskId} file={current} />
        </figure>
      )}
    </section>
  );
}
