import { useState, type SubmitEvent } from "react";
import { api, type Person, type Project } from "./api.ts";

/**
 * The project's settings: its name, its repository, and whether it allows host sessions
 * (HOST-1), which only the store's owner switches; the store refuses anyone else. Below them,
 * its Cloudflare tokens (CLOUDFLARE-3).
 */
export function ProjectSettings({ project, me, onSaved }: { project: Project; me: Person | null; onSaved: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const owner = me?.owner === true;
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name")).trim();
    const repo = String(form.get("repoPath")).trim();
    const repoPath = repo === "" ? null : repo;
    const hostSessions = form.get("hostSessions") === "on";
    // Only what changed: a name or repository change never touches the host sessions switch.
    const body = {
      ...(name === project.name ? {} : { name }),
      ...(repoPath === project.repoPath ? {} : { repoPath }),
      ...(owner && hostSessions !== project.hostSessions ? { hostSessions } : {}),
    };
    setError(null);
    setSaved(false);
    setBusy(true);
    api<Project>("PATCH", `/projects/${project.id}`, body).then(
      () => { setBusy(false); setSaved(true); onSaved(); },
      (cause: Error) => { setBusy(false); setError(cause.message); },
    );
  };
  return (
    <>
      <form key={project.id} className="panel new-project" onSubmit={submit} onChange={() => setSaved(false)} aria-label="Project settings">
        <h2>Project settings</h2>
        <label>Name<input name="name" required defaultValue={project.name} /></label>
        <label>
          Repository
          <input name="repoPath" defaultValue={project.repoPath ?? ""} placeholder="/home/you/projects/draftcoach" />
        </label>
        <label className="check">
          <input type="checkbox" name="hostSessions" defaultChecked={project.hostSessions} disabled={!owner} />
          Allow host sessions: agents may run on this machine as you, without a container
        </label>
        {!owner && <p className="muted small">Only the store's owner allows or stops host sessions.</p>}
        {error && <p className="error">{error}</p>}
        {saved && <p className="small" role="status">Saved.</p>}
        <div className="actions">
          <button type="submit" disabled={busy}>Save</button>
          <a className="button ghost" href="#/">Back to the board</a>
        </div>
      </form>
      <CloudflareTokens key={`cloudflare-${project.id}`} project={project} owner={owner} onSaved={onSaved} />
    </>
  );
}

/**
 * CLOUDFLARE-3: the project's Cloudflare tokens, which its sessions' agents use through the
 * gateway (CLOUDFLARE-1/2). Only the store's owner sets or removes them; the store never
 * answers with a token, so this says only which are set.
 */
function CloudflareTokens({ project, owner, onSaved }: { project: Project; owner: boolean; onSaved: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { read, write } = project.cloudflare;
  const change = (request: () => Promise<Project>, message: string, form: HTMLFormElement) => {
    setError(null);
    setDone(null);
    setBusy(true);
    request().then(
      () => { setBusy(false); setDone(message); form.reset(); onSaved(); },
      (cause: Error) => { setBusy(false); setError(cause.message); },
    );
  };
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const writeToken = String(form.get("write")).trim();
    const body = { read: String(form.get("read")).trim(), ...(writeToken === "" ? {} : { write: writeToken }) };
    change(() => api<Project>("PUT", `/projects/${project.id}/cloudflare`, body), "Saved.", event.currentTarget);
  };
  const remove = (form: HTMLFormElement | null) => {
    if (form !== null) change(() => api<Project>("DELETE", `/projects/${project.id}/cloudflare`), "Removed.", form);
  };
  return (
    <form className="panel new-project" onSubmit={submit} onChange={() => setDone(null)} aria-label="Cloudflare">
      <h3>Cloudflare</h3>
      <p className="muted small">
        Agents reach the project's Cloudflare account through Agent Monitor with these tokens and never see them: the read
        token always, the write token only while a task's settings allow it.
      </p>
      <p className="small">
        {!read ? "No Cloudflare tokens." : write ? "Read token set. Write token set." : "Read token set. No write token: agents only read."}
      </p>
      {owner ? (
        <>
          <label>Read token<input name="read" type="password" required autoComplete="off" /></label>
          <label>Write token (optional)<input name="write" type="password" autoComplete="off" /></label>
          {error && <p className="error">{error}</p>}
          {done && <p className="small" role="status">{done}</p>}
          <div className="actions">
            <button type="submit" disabled={busy}>Save</button>
            {read && (
              <button type="button" className="danger" disabled={busy} onClick={(event) => remove(event.currentTarget.form)}>Remove</button>
            )}
          </div>
        </>
      ) : (
        <p className="muted small">Only the store's owner sets the project's Cloudflare tokens.</p>
      )}
    </form>
  );
}
