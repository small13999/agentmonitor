import { useState, type SubmitEvent } from "react";
import { api, type Person, type Project } from "./api.ts";

/**
 * The project's settings: its name, its repository, and whether it allows host sessions
 * (HOST-1), which only the store's owner switches; the store refuses anyone else.
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
  );
}
