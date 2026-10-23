import { useState, type ReactNode, type SubmitEvent } from "react";
import {
  api, storeUrl, usePolled, type Automation, type AutomationDetail, type AutomationSummary, type Card, type Firing, type FiringOutcome, type FiringVerdict, type FolderFile,
  type Person, type Project, type RunOutcome, type Session, type SessionRuntime, type StoreListing, type Task, type Trigger,
} from "./api.ts";
import { HostMark, Light } from "./Board.tsx";
import { Folder, folderRoute, Preview, sizeOf, type FolderOwner } from "./Folder.tsx";
import { Markdown } from "./Markdown.tsx";
import { ActorName, useDirectory, type Directory } from "./People.tsx";
import { ProjectMenu } from "./TaskList.tsx";
import { WorkspaceTabs, type WorkspaceTab } from "./Workspace.tsx";

/** AUTO-2: the timezone a schedule is read in unless another is given. */
const DEFAULT_TIMEZONE = "Europe/Budapest";

/** AUTO-9: a run is named by the start of its session's id, as its branch `am/<slug>-<run>` and its outputs `runs/<run>/` are. */
function runShortId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

function pageHref(automationId: string): string {
  return `#/a/${automationId}`;
}

function chatHref(automationId: string, sessionId: string): string {
  return `#/a/${automationId}/chat/${sessionId}`;
}

function Time({ at }: { at: number }) {
  return <time className="muted small" dateTime={new Date(at).toISOString()}>{new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</time>;
}

const RUN_OUTCOME_LABEL: Record<RunOutcome, string> = {
  finished: "Finished",
  review: "Waiting for review",
  timed_out: "Timed out",
  failed: "Failed",
  ended: "Ended",
};

const FIRING_OUTCOME_LABEL: Record<FiringOutcome, string> = {
  started: "Started a run",
  off: "Skipped: the automation was off",
  running: "Skipped: a run was still going",
  guard: "Stopped by the guard",
  check: "Stopped by the check",
  failed: "The run failed to start",
};

/** AUTO-10: a Wait-for-review run whose agent is done: its session stays open for a person. */
function waitsForReview(session: Session): boolean {
  return session.run?.outcome === "review" && session.endedAt === null;
}

/** How a run went, or that it goes on, as a pill; a run waiting for review in "waiting on you" yellow. */
function RunState({ session }: { session: Session }) {
  const outcome = session.run?.outcome ?? null;
  if (waitsForReview(session)) return <span className="outcome turn turn-blocked">{RUN_OUTCOME_LABEL.review}</span>;
  if (outcome !== null) return <span className={`outcome outcome-${outcome}`}>{RUN_OUTCOME_LABEL[outcome]}</span>;
  return session.endedAt === null
    ? <span className="outcome turn turn-working"><Light turn="working" />Running</span>
    : <span className="outcome outcome-ended">Ended</span>;
}

/** Runs one call of a button; `busy` while it goes, its error kept to show. */
function useCall(): { busy: boolean; error: string | null; call: (action: () => Promise<unknown>) => void } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const call = (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    action().then(
      () => setBusy(false),
      (cause: unknown) => { setBusy(false); setError(cause instanceof Error ? cause.message : String(cause)); },
    );
  };
  return { busy, error, call };
}

/**
 * AUTO-15: the project's automations, by name, each with its running run's light; the project
 * menu above, as on the Tasks page, and a new automation's form behind "+ Automation".
 */
export function AutomationList({ stores, project, onProject, onNewProject, automations, cards, selected }: {
  stores: StoreListing[];
  project: Project;
  onProject: (id: string) => void;
  onNewProject: () => void;
  automations: AutomationSummary[] | null;
  cards: Map<string, Card>;
  /** The automation shown, or "new" for the form. */
  selected: string | null;
}) {
  return (
    <nav className="task-list" aria-label="Automations">
      <ProjectMenu stores={stores} project={project} onProject={onProject} onNewProject={onNewProject} />
      <a className="new-link" href="#/a/new" aria-current={selected === "new" ? "page" : undefined}>+ Automation</a>
      {automations === null && <p className="muted small">Loading…</p>}
      {automations?.length === 0 && <p className="muted small">No automations yet</p>}
      {(automations ?? []).map(({ automation, sessionId }) => {
        const card = sessionId === null ? undefined : cards.get(sessionId);
        return (
          <a
            key={automation.id}
            className="task-link"
            href={pageHref(automation.id)}
            title={automation.name}
            aria-current={automation.id === selected ? "page" : undefined}
          >
            {card === undefined ? <span className="light light-none" aria-label="No run going" title="No run going" /> : <Light turn={card.turn} />}
            <span className="name">{automation.name}</span>
            {!automation.enabled && <span className="off-mark" title="Off: starts no runs">Off</span>}
            <HostMark card={card} />
          </a>
        );
      })}
    </nav>
  );
}

/** A trigger as the form edits it: its fields as typed; `id` null for one not saved yet. */
interface TriggerDraft {
  key: string;
  id: string | null;
  cron: string;
  timezone: string;
  guardPath: string;
  checkPath: string;
}

function draftOf(trigger: Trigger): TriggerDraft {
  return { key: trigger.id, id: trigger.id, cron: trigger.cron, timezone: trigger.timezone, guardPath: trigger.guardPath ?? "", checkPath: trigger.checkPath ?? "" };
}

function triggerBody(draft: TriggerDraft): { cron: string; timezone: string; guardPath: string | null; checkPath: string | null } {
  const path = (value: string) => (value.trim() === "" ? null : value.trim());
  return { cron: draft.cron.trim(), timezone: draft.timezone.trim() === "" ? DEFAULT_TIMEZONE : draft.timezone.trim(), guardPath: path(draft.guardPath), checkPath: path(draft.checkPath) };
}

function sameTrigger(trigger: Trigger, draft: TriggerDraft): boolean {
  const body = triggerBody(draft);
  return trigger.cron === body.cron && trigger.timezone === body.timezone && trigger.guardPath === body.guardPath && trigger.checkPath === body.checkPath;
}

/** The time zones the browser knows, offered while typing one. */
const TIMEZONES = Intl.supportedValuesOf("timeZone");

/**
 * AUTO-1, AUTO-8, AUTO-15: an automation's fields and its triggers, for a new automation
 * (`detail` null) or an existing one. Saving writes the automation, then each trigger added,
 * changed, or removed; a trigger refused keeps the form as typed, with what was saved saved.
 */
export function AutomationForm({ project, detail, onSaved }: { project: Project; detail: AutomationDetail | null; onSaved: (automation: Automation) => void }) {
  const automation = detail?.automation ?? null;
  // Set once the automation exists, so saving again after a refused trigger changes it instead of creating another.
  const [savedId, setSavedId] = useState<string | null>(automation?.id ?? null);
  const [originals, setOriginals] = useState<Trigger[]>(detail?.triggers ?? []);
  const [drafts, setDrafts] = useState<TriggerDraft[]>(() => (detail?.triggers ?? []).map(draftOf));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const change = (key: string, fields: Partial<TriggerDraft>) => {
    setSaved(false);
    setDrafts((before) => before.map((draft) => (draft.key === key ? { ...draft, ...fields } : draft)));
  };

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const model = String(form.get("model")).trim();
    const fields = {
      name: String(form.get("name")).trim(),
      instructions: String(form.get("instructions")),
      model: model === "" ? null : model,
      endMode: form.get("endMode") === "review" ? "review" : "finish",
      timeLimitMinutes: Number(form.get("timeLimitMinutes")),
      enabled: form.get("enabled") === "on",
    };
    setBusy(true);
    setError(null);
    setSaved(false);
    let kept = drafts;
    let left = originals;
    try {
      const written = savedId === null
        ? await api<Automation>("POST", `/projects/${project.id}/automations`, fields)
        : await api<Automation>("PATCH", `/automations/${savedId}`, fields);
      setSavedId(written.id);
      for (const original of left.filter((trigger) => !kept.some((draft) => draft.id === trigger.id))) {
        await api("DELETE", `/triggers/${original.id}`);
        left = left.filter((trigger) => trigger.id !== original.id);
      }
      for (const draft of kept) {
        const original = left.find((trigger) => trigger.id === draft.id);
        if (original !== undefined && sameTrigger(original, draft)) continue;
        const trigger = draft.id === null
          ? await api<Trigger>("POST", `/automations/${written.id}/triggers`, triggerBody(draft))
          : await api<Trigger>("PATCH", `/triggers/${draft.id}`, triggerBody(draft));
        kept = kept.map((candidate) => (candidate.key === draft.key ? { ...draftOf(trigger), key: draft.key } : candidate));
        left = [...left.filter((candidate) => candidate.id !== trigger.id), trigger];
      }
      setSaved(true);
      onSaved(written);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDrafts(kept);
      setOriginals(left);
      setBusy(false);
    }
  };

  return (
    <form className="panel automation-form" onSubmit={(event) => void submit(event)} aria-label={automation === null ? "New automation" : "Automation settings"}>
      <h3>{automation === null ? "New automation" : "Settings"}</h3>
      <label>Name<input name="name" required defaultValue={automation?.name ?? ""} placeholder="Patch review" autoFocus={automation === null} /></label>
      <label>
        Instructions
        <textarea name="instructions" rows={8} defaultValue={automation?.instructions ?? ""} placeholder="What each run does, in Markdown" />
      </label>
      <div className="form-row">
        <label>Model<input name="model" defaultValue={automation?.model ?? ""} placeholder="omp's default" /></label>
        <label>
          End mode
          <select name="endMode" defaultValue={automation?.endMode ?? "finish"}>
            <option value="finish">Finish: write outputs, deploy, end</option>
            <option value="review">Wait for review: write outputs, wait for you</option>
          </select>
        </label>
        <label>Time limit (minutes)<input name="timeLimitMinutes" type="number" min={1} max={1440} required defaultValue={automation?.timeLimitMinutes ?? 120} /></label>
      </div>
      <label className="check">
        <input type="checkbox" name="enabled" defaultChecked={automation?.enabled ?? true} />
        On: its triggers start runs (off, it starts none)
      </label>
      <section className="triggers-form" aria-label="Triggers">
        <h4>Triggers</h4>
        {drafts.length === 0 && <p className="muted small">No triggers: it runs only when started by hand.</p>}
        {drafts.map((draft, index) => (
          <fieldset key={draft.key} className="trigger-draft">
            <legend>Trigger {index + 1}</legend>
            <label>Schedule (cron)<input value={draft.cron} required placeholder="0 9 * * 1-5" onChange={(event) => change(draft.key, { cron: event.target.value })} /></label>
            <label>
              Timezone
              <input value={draft.timezone} list="automation-timezones" placeholder={DEFAULT_TIMEZONE} onChange={(event) => change(draft.key, { timezone: event.target.value })} />
            </label>
            <label>Guard (file)<input value={draft.guardPath} placeholder="guard.sh" onChange={(event) => change(draft.key, { guardPath: event.target.value })} /></label>
            <label>Check (file)<input value={draft.checkPath} placeholder="check.md" onChange={(event) => change(draft.key, { checkPath: event.target.value })} /></label>
            <button
              type="button"
              className="ghost danger"
              aria-label={`Remove trigger ${index + 1}`}
              onClick={() => { setSaved(false); setDrafts((before) => before.filter((candidate) => candidate.key !== draft.key)); }}
            >
              Remove
            </button>
          </fieldset>
        ))}
        <datalist id="automation-timezones">{TIMEZONES.map((zone) => <option key={zone} value={zone} />)}</datalist>
        <button
          type="button"
          className="ghost add-trigger"
          onClick={() => setDrafts((before) => [...before, { key: crypto.randomUUID(), id: null, cron: "", timezone: DEFAULT_TIMEZONE, guardPath: "", checkPath: "" }])}
        >
          + Trigger
        </button>
        <p className="muted small">
          A guard is code in the automation's folder: exit 0 lets the run start, and its output goes on to the check and the run. A check is a prompt in
          the folder that a cheap model answers yes or no.
        </p>
      </section>
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button type="submit" disabled={busy}>{busy ? "Saving…" : automation === null ? "Create automation" : "Save"}</button>
        {saved && automation !== null && <span className="muted small" role="status">Saved</span>}
      </div>
    </form>
  );
}

/** Only people delete automations, with their runs' records and chats, and their folder. */
function DeleteAutomation({ automation }: { automation: Automation }) {
  const { busy, error, call } = useCall();
  const remove = () => {
    if (!window.confirm(`Delete ${automation.name} with its runs' records and chats, and its folder?`)) return;
    call(async () => {
      await api("DELETE", `/automations/${automation.id}`);
      window.location.hash = "#/a";
    });
  };
  return (
    <section className="panel" aria-label="Delete automation">
      <h3>Delete</h3>
      <p className="muted small">Deletes the automation, its runs' records and chats, and its folder. Branches stay.</p>
      <div className="actions"><button type="button" className="danger" disabled={busy} onClick={remove}>Delete automation</button></div>
      {error && <p className="error small">{error}</p>}
    </section>
  );
}

/**
 * AUTO-9, AUTO-11, AUTO-12: what a person does with a run: open its session while it goes, make
 * a task of it (its branch and outputs), or start a session on the automation from it.
 */
function RunActions({ automation, run, onChanged }: { automation: Automation; run: Session; onChanged: () => void }) {
  const { busy, error, call } = useCall();
  const short = runShortId(run.id);
  return (
    <div className="run-actions">
      <div className="actions">
        {run.endedAt === null && <a className="button-link" href={chatHref(automation.id, run.id)} aria-label={`Open session of run ${short}`}>Open session</a>}
        <button
          type="button"
          className="ghost"
          disabled={busy}
          aria-label={`Make a task from run ${short}`}
          onClick={() => call(async () => {
            const task = await api<Task>("POST", `/automations/${automation.id}/runs/${run.id}/task`);
            window.location.hash = `#/t/${task.id}`;
          })}
        >
          Make a task from this run
        </button>
        <button
          type="button"
          className="ghost"
          disabled={busy}
          aria-label={`Start a session from run ${short}`}
          onClick={() => call(async () => {
            const session = await api<Session>("POST", `/automations/${automation.id}/sessions`, { fromRun: run.id });
            onChanged();
            window.location.hash = chatHref(automation.id, session.id);
          })}
        >
          Start a session from this run
        </button>
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/** A run's outputs: the files of `runs/<run>/` in the automation's folder. */
interface OutputGroup {
  dir: string;
  short: string;
  /** The run that wrote them; null when the store has no such run. */
  run: Session | null;
  files: FolderFile[];
  /** When the run started, or for an unknown run its newest file. */
  at: number;
}

/** AUTO-7: the folder's `runs/<run>/` folders, the newest run first. */
function outputGroups(files: FolderFile[], runs: Session[]): OutputGroup[] {
  const byRun = new Map<string, FolderFile[]>();
  for (const file of files) {
    const match = /^runs\/([^/]+)\/./.exec(file.path);
    if (match !== null) byRun.set(match[1], [...(byRun.get(match[1]) ?? []), file]);
  }
  return [...byRun].map(([short, grouped]) => {
    const run = runs.find((candidate) => runShortId(candidate.id) === short) ?? null;
    return { dir: `runs/${short}`, short, run, files: grouped, at: run?.startedAt ?? Math.max(...grouped.map((file) => file.updatedAt)) };
  }).sort((a, b) => b.at - a.at);
}

/** One output: images and video inline; any other kind shows when its name is clicked. */
function OutputFile({ owner, file, dir }: { owner: FolderOwner; file: FolderFile; dir: string }) {
  const [open, setOpen] = useState(false);
  const type = file.contentType.split(";")[0];
  const name = file.path.slice(dir.length + 1);
  if (type.startsWith("image/") || type.startsWith("video/")) {
    return (
      <figure className="output output-media">
        <Preview owner={owner} file={file} />
        <figcaption className="file-name">{name}</figcaption>
      </figure>
    );
  }
  return (
    <div className="output">
      <button type="button" className="ghost file-name" aria-expanded={open} onClick={() => setOpen(!open)}>
        {name} <span className="muted small">{sizeOf(file.size)}</span>
      </button>
      {open && <div className="folder-preview" aria-label={`Preview of ${file.path}`}><Preview owner={owner} file={file} /></div>}
    </div>
  );
}

/** AUTO-7: what one run produced, downloadable as one zip, with what can be done with the run. */
function RunOutputs({ automation, group, onChanged }: { automation: Automation; group: OutputGroup; onChanged: () => void }) {
  const owner: FolderOwner = { kind: "automation", id: automation.id };
  return (
    <article className="card run-outputs" aria-label={`Outputs of run ${group.short}`}>
      <header>
        <span className="run-name">Run <code>{group.short}</code></span>
        {group.run !== null && <Time at={group.run.startedAt} />}
        {group.run !== null && <RunState session={group.run} />}
        <a
          className="button download-outputs"
          href={storeUrl(`${folderRoute(owner)}.zip?path=${encodeURIComponent(group.dir)}`)}
          download
          aria-label={`Download outputs of run ${group.short}`}
        >
          Download (.zip)
        </a>
      </header>
      <div className="outputs">
        {group.files.map((file) => <OutputFile key={file.path} owner={owner} file={file} dir={group.dir} />)}
      </div>
      {group.run !== null && <RunActions automation={automation} run={group.run} onChanged={onChanged} />}
    </article>
  );
}

/** AUTO-10: the runs that wait for a person, each with its session to open. */
function ReviewSection({ automation, runs, outputs, onChanged }: { automation: Automation; runs: Session[]; outputs: OutputGroup[]; onChanged: () => void }) {
  const waiting = runs.filter(waitsForReview);
  if (waiting.length === 0) return null;
  return (
    <section className="panel review-section" aria-label="Waiting for review">
      <h3>Waiting for review <span className="badge">{waiting.length}</span></h3>
      <ul className="sessions">
        {waiting.map((run) => {
          const files = outputs.find((group) => group.run?.id === run.id)?.files.length ?? 0;
          return (
            <li key={run.id} className="session-row review-row">
              <span className="run-name">Run <code>{runShortId(run.id)}</code></span>
              <Time at={run.startedAt} />
              <span className="muted small">{files === 0 ? "no outputs" : files === 1 ? "1 output" : `${files} outputs`}</span>
              <RunActions automation={automation} run={run} onChanged={onChanged} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** AUTO-7: every run's outputs, the newest run first. */
function OutputsSection({ automation, outputs, loaded, onChanged }: { automation: Automation; outputs: OutputGroup[]; loaded: boolean; onChanged: () => void }) {
  return (
    <section className="panel outputs-section" aria-label="Outputs">
      <h3>Outputs</h3>
      {!loaded && <p className="muted small">Loading…</p>}
      {loaded && outputs.length === 0 && <p className="muted small">No run has written outputs yet. Each run writes its own into <code>runs/&lt;run&gt;/</code> in the folder.</p>}
      {outputs.map((group) => <RunOutputs key={group.dir} automation={automation} group={group} onChanged={onChanged} />)}
    </section>
  );
}

/** AUTO-8: what a guard or check said at a firing. */
function Verdict({ verdict }: { verdict: FiringVerdict | null }) {
  if (verdict === null) return <span className="muted">—</span>;
  return (
    <span className="verdict">
      <span className={verdict.passed ? "verdict-mark verdict-pass" : "verdict-mark verdict-fail"}>{verdict.passed ? "Passed" : "Failed"}</span>
      {verdict.output.trim() !== "" && <span className="verdict-output" title={verdict.output}>{verdict.output}</span>}
    </span>
  );
}

/**
 * A line of the runs and firings: a firing (and the run it started), or a run nothing fired
 * ("run now"). `at` orders them: when it fired or started; a firing shows its scheduled time,
 * which a firing caught up after downtime (AUTO-2) is long past.
 */
interface HistoryRow {
  key: string;
  at: number;
  shown: number;
  firing: Firing | null;
  run: Session | null;
}

/** AUTO-7, AUTO-8, AUTO-9: the runs and firings, newest first, with what the guard and check said and how each went. */
function RunsSection({ automation, runs, firings, triggers, directory }: {
  automation: Automation;
  runs: Session[];
  firings: Firing[] | null;
  triggers: Trigger[];
  directory: Directory;
}) {
  const fired = new Set((firings ?? []).flatMap((firing) => (firing.sessionId === null ? [] : [firing.sessionId])));
  const rows: HistoryRow[] = [
    ...(firings ?? []).map((firing) => ({ key: firing.id, at: firing.firedAt, shown: firing.scheduledAt, firing, run: runs.find((run) => run.id === firing.sessionId) ?? null })),
    ...runs.filter((run) => !fired.has(run.id)).map((run) => ({ key: run.id, at: run.startedAt, shown: run.startedAt, firing: null, run })),
  ].sort((a, b) => b.at - a.at);
  const cause = (row: HistoryRow): ReactNode => {
    if (row.firing !== null) {
      const trigger = triggers.find((candidate) => candidate.id === row.firing?.triggerId);
      return trigger === undefined
        ? <span className="muted">A removed trigger</span>
        : <span>Schedule <code>{trigger.cron}</code> <span className="muted small">{trigger.timezone}</span></span>;
    }
    const startedBy = row.run?.run?.startedBy ?? null;
    return startedBy === null ? <span className="muted">A trigger</span> : <span className="started-by">Run now by <ActorName actor={startedBy} directory={directory} /></span>;
  };
  return (
    <section className="panel runs-section" aria-label="Runs and firings">
      <h3>Runs and firings</h3>
      {firings === null && <p className="muted small">Loading…</p>}
      {firings !== null && rows.length === 0 && <p className="muted small">Nothing has run yet.</p>}
      {rows.length > 0 && (
        <table className="runs-table">
          <thead>
            <tr><th>When</th><th>Started by</th><th>Guard</th><th>Check</th><th>Outcome</th><th>Session</th></tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td><Time at={row.shown} /></td>
                <td>{cause(row)}</td>
                <td><Verdict verdict={row.firing?.guard ?? null} /></td>
                <td><Verdict verdict={row.firing?.check ?? null} /></td>
                <td>
                  {row.run !== null
                    ? <RunState session={row.run} />
                    : <span className={`outcome outcome-firing-${row.firing?.outcome ?? "started"}`}>{FIRING_OUTCOME_LABEL[row.firing?.outcome ?? "started"]}</span>}
                </td>
                <td>
                  {row.run === null ? (
                    <span className="muted">—</span>
                  ) : row.run.endedAt === null ? (
                    <a href={chatHref(automation.id, row.run.id)}>Run <code>{runShortId(row.run.id)}</code></a>
                  ) : (
                    <span className="muted small">Run <code>{runShortId(row.run.id)}</code>, ended <Time at={row.run.endedAt} /></span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** "Run now" and "Start a session": a run as its triggers start one, or a person's session on the automation (AUTO-11). */
function StartButtons({ automation, hostSessions, onStarted }: { automation: Automation; hostSessions: boolean; onStarted: () => void }) {
  const { busy, error, call } = useCall();
  const start = (path: string, body: Record<string, unknown>) => call(async () => {
    const session = await api<Session>("POST", path, body);
    onStarted();
    window.location.hash = chatHref(automation.id, session.id);
  });
  const runNow = (runtime: SessionRuntime) => start(`/automations/${automation.id}/runs`, { runtime });
  return (
    <div className="start-buttons">
      <div className="actions">
        <button type="button" disabled={busy || !automation.enabled} title={automation.enabled ? undefined : "It is off: turn it on in its settings"} onClick={() => runNow("container")}>
          Run now
        </button>
        {hostSessions && (
          <button type="button" className="danger" disabled={busy || !automation.enabled} title="The run's agent works on this machine as you, without a container" onClick={() => runNow("host")}>
            Run now on host
          </button>
        )}
        <button type="button" className="ghost" disabled={busy} onClick={() => start(`/automations/${automation.id}/sessions`, {})}>Start a session</button>
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/** AUTO-1: what the automation runs and how, beside its outputs. */
function AutomationFields({ automation, triggers, sessions, directory }: { automation: Automation; triggers: Trigger[]; sessions: Session[]; directory: Directory }) {
  return (
    <aside className="page-side" aria-label="Automation fields">
      <section className="field" aria-label="Triggers">
        <h3>Triggers</h3>
        {triggers.length === 0 && <p className="muted small">None: it runs only when started by hand.</p>}
        <ul className="trigger-list">
          {triggers.map((trigger) => (
            <li key={trigger.id}>
              <code>{trigger.cron}</code> <span className="muted small">{trigger.timezone}</span>
              {trigger.guardPath !== null && <div className="small">Guard <code>{trigger.guardPath}</code></div>}
              {trigger.checkPath !== null && <div className="small">Check <code>{trigger.checkPath}</code></div>}
            </li>
          ))}
        </ul>
      </section>
      <section className="field" aria-label="Runs">
        <h3>Runs</h3>
        <dl className="run-settings">
          <dt>Model</dt><dd>{automation.model ?? <span className="muted">omp's default</span>}</dd>
          <dt>End mode</dt><dd>{automation.endMode === "review" ? "Wait for review" : "Finish"}</dd>
          <dt>Time limit</dt><dd>{automation.timeLimitMinutes} minutes</dd>
          <dt>Branches</dt><dd><code>am/{automation.slug}-&lt;run&gt;</code></dd>
        </dl>
      </section>
      <section className="field" aria-label="Instructions">
        <h3>Instructions</h3>
        {automation.instructions.trim() === "" ? <p className="muted small">No instructions yet.</p> : <Markdown text={automation.instructions} />}
      </section>
      {sessions.length > 0 && (
        <section className="field" aria-label="Sessions">
          <h3>Sessions</h3>
          <ul className="sessions">
            {sessions.map((session) => (
              <li key={session.id} className="session-row">
                <ActorName actor={{ kind: "agent", sessionId: session.id }} directory={directory} />
                <Time at={session.startedAt} />
                {session.endedAt === null
                  ? <a href={chatHref(automation.id, session.id)}>Open chat</a>
                  : <span className="muted small">ended</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}

/**
 * AUTO-7: an automation's page: first what its runs produced and what waits for review, then
 * its runs and firings; beside them its triggers and fields, below them its folder (AUTO-1).
 */
function AutomationPage({ detail, firings, files, hostSessions, directory, onChanged }: {
  detail: AutomationDetail;
  firings: Firing[] | null;
  files: FolderFile[] | null;
  hostSessions: boolean;
  directory: Directory;
  onChanged: () => void;
}) {
  const { automation, triggers } = detail;
  const runs = detail.runs.filter((session) => session.run !== null);
  const outputs = outputGroups(files ?? [], runs);
  return (
    <article className="workspace-page task-page automation-page" aria-label="Automation page">
      <header className="page-head">
        <h2 className="automation-name">{automation.name}</h2>
        <span className={automation.enabled ? "outcome outcome-on" : "outcome outcome-off"} role="status" aria-label="On or off">{automation.enabled ? "On" : "Off"}</span>
        <StartButtons automation={automation} hostSessions={hostSessions} onStarted={onChanged} />
      </header>
      <div className="page-grid">
        <div className="page-main">
          <ReviewSection automation={automation} runs={runs} outputs={outputs} onChanged={onChanged} />
          <OutputsSection automation={automation} outputs={outputs} loaded={files !== null} onChanged={onChanged} />
          <RunsSection automation={automation} runs={runs} firings={firings} triggers={triggers} directory={directory} />
          <Folder
            owner={{ kind: "automation", id: automation.id }}
            directory={directory}
            hint="Drop files here to add them: memory.md, guards, checks. Every run finds them in its folder."
          />
        </div>
        <AutomationFields automation={automation} triggers={triggers} sessions={detail.runs.filter((session) => session.run === null)} directory={directory} />
      </div>
    </article>
  );
}

/**
 * AUTO-7, AUTO-15: one automation in the workspace: its Page, the Chat of one of its sessions
 * (the chats themselves are SessionFrames, as a task's), and its Settings.
 */
export function AutomationWorkspace({ project, automationId, tab, chatSessionId, hostSessions, onChanged }: {
  project: Project;
  automationId: string;
  tab: WorkspaceTab;
  /** The session whose chat the Chat tab shows. */
  chatSessionId: string | null;
  hostSessions: boolean;
  onChanged: () => void;
}) {
  const detail = usePolled<AutomationDetail>(`/automations/${automationId}`, 3_000);
  const firings = usePolled<Firing[]>(`/automations/${automationId}/firings`, 5_000);
  const files = usePolled<FolderFile[]>(`/automations/${automationId}/folder`, 3_000);
  const people = usePolled<Person[]>("/people", 10_000);
  const me = usePolled<{ person: Person }>("/me", 60_000);
  const agents = (files.data ?? []).flatMap((file) => (file.addedBy?.kind === "agent" ? [file.addedBy.sessionId] : []));
  const directory = useDirectory(people.data, me.data?.person ?? null, detail.data?.runs ?? [], agents);
  const changed = () => {
    detail.refresh();
    firings.refresh();
    onChanged();
  };
  if (detail.data === null) return <p className="workspace-page muted">{detail.error ?? "Loading…"}</p>;
  const sessions = detail.data.runs;
  const going = sessions.find((session) => session.endedAt === null) ?? null;
  const chatOf = chatSessionId ?? going?.id ?? null;
  const chatSession = sessions.find((session) => session.id === chatSessionId) ?? null;
  return (
    <>
      <WorkspaceTabs base={pageHref(automationId)} tab={tab} chat={chatOf === null ? null : chatHref(automationId, chatOf)} />
      {tab === "page" && (
        <AutomationPage
          detail={detail.data}
          firings={firings.data}
          files={files.data}
          hostSessions={hostSessions}
          directory={directory}
          onChanged={changed}
        />
      )}
      {tab === "chat" && chatSession !== null && chatSession.endedAt !== null && (
        <p className="workspace-page muted">
          {chatSession.run === null ? "This session has ended." : `Run ${runShortId(chatSession.id)} has ended; its outputs stay on the automation's page.`}
        </p>
      )}
      {tab === "settings" && (
        <div className="workspace-page automation-settings">
          <AutomationForm key={automationId} project={project} detail={detail.data} onSaved={changed} />
          <DeleteAutomation automation={detail.data.automation} />
        </div>
      )}
    </>
  );
}

/** AUTO-15: a new automation; created, its page opens. */
export function NewAutomation({ project, onCreated }: { project: Project; onCreated: () => void }) {
  return (
    <div className="workspace-page automation-settings">
      <AutomationForm
        project={project}
        detail={null}
        onSaved={(automation) => {
          onCreated();
          window.location.hash = pageHref(automation.id);
        }}
      />
    </div>
  );
}
