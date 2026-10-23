import { useState } from "react";
import { api, usePolled, type BranchState, type ChangedFile, type CheckState, type PullRequest, type Session, type Work, type WorkBadge, type WorkCommit } from "./api.ts";

const FILE_STATUS: Record<ChangedFile["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
};

/** CARD-6: what each board badge says. */
export const BADGE_LABEL: Record<WorkBadge, string> = {
  unpushed: "Not pushed",
  open: "PR open",
  deployed: "Deployed",
};

const PR_STATE_LABEL: Record<PullRequest["state"], string> = {
  open: "Open",
  merged: "Deployed",
  closed: "Closed",
};

const CHECKS_LABEL: Record<CheckState, string> = {
  passing: "Checks passing",
  failing: "Checks failing",
  pending: "Checks pending",
};

function plural(count: number, one: string): string {
  return `${count} ${one}${count === 1 ? "" : "s"}`;
}

/** CARD-3: the branch's state in one line: nothing yet, uncommitted in the running session, commits not pushed, or pushed. */
function stateLine(work: Work): string {
  const commits = work.commits ?? [];
  const unpushed = commits.filter((commit) => !commit.pushed).length;
  const lines: Record<BranchState, string> = {
    nothing: work.branch === null ? "Nothing yet: the task's first session creates its branch." : "Nothing yet.",
    uncommitted: `Uncommitted changes in the running session (${plural(work.uncommitted?.length ?? 0, "file")})` +
      (unpushed > 0 ? `, ${plural(unpushed, "commit")} not pushed.` : commits.length > 0 ? `, ${plural(commits.length, "commit")} pushed.` : "."),
    unpushed: `${plural(unpushed, "commit")} not pushed${unpushed < commits.length ? `, ${commits.length - unpushed} pushed` : ""}.`,
    pushed: `${plural(commits.length, "commit")} pushed.`,
  };
  return lines[work.state];
}

/** CARD-3: the overall state of a pull request's checks: failing if any fails, pending while any runs; null without checks or when they cannot be read. */
function checksOf(pr: PullRequest): CheckState | null {
  if (pr.checks === null || pr.checks.length === 0) return null;
  if (pr.checks.some((check) => check.state === "failing")) return "failing";
  if (pr.checks.some((check) => check.state === "pending")) return "pending";
  return "passing";
}

function Checks({ pr }: { pr: PullRequest }) {
  if (pr.checks === null) return <span className="muted small">Checks unavailable</span>;
  const state = checksOf(pr);
  if (state === null) return <span className="muted small">No checks</span>;
  return (
    <span className={`checks checks-${state}`} title={pr.checks.map((check) => `${check.name}: ${check.state}`).join("\n")}>
      {CHECKS_LABEL[state]}
    </span>
  );
}

/** CARD-3: a commit: its subject, which shows its description when it has one, its time, and its short sha linking to the remote. */
function Commit({ commit }: { commit: WorkCommit }) {
  const [open, setOpen] = useState(false);
  const short = commit.sha.slice(0, 7);
  return (
    <li className={commit.pushed ? "commit" : "commit commit-unpushed"}>
      <div className="commit-line">
        {commit.body === ""
          ? <span className="commit-subject">{commit.subject}</span>
          : <button type="button" className="ghost commit-subject" aria-expanded={open} onClick={() => setOpen(!open)}>{commit.subject}</button>}
        {!commit.pushed && <span className="unpushed-mark">Not pushed</span>}
        <time className="muted small" dateTime={new Date(commit.at).toISOString()}>{new Date(commit.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</time>
        {commit.url === null
          ? <code className="sha">{short}</code>
          : <a className="sha" href={commit.url} target="_blank" rel="noreferrer" title={commit.sha}>{short}</a>}
      </div>
      {open && <pre className="commit-body">{commit.body}</pre>}
    </li>
  );
}

/** CARD-3: how many files the commits changed, with lines added and deleted; expands to the list. */
function Files({ files }: { files: ChangedFile[] }) {
  const [open, setOpen] = useState(false);
  const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0);
  const deleted = files.reduce((sum, file) => sum + (file.deleted ?? 0), 0);
  return (
    <div className="work-files">
      <button type="button" className="ghost files-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {plural(files.length, "file")} changed, <span className="lines-added">+{added}</span> <span className="lines-deleted">−{deleted}</span>
      </button>
      {open && (
        <ul className="files changed-files">
          {files.map((file) => (
            <li key={file.path}>
              <span className={`file-status file-${file.status}`} title={file.status}>{FILE_STATUS[file.status]}</span> <code>{file.path}</code>
              {file.added !== null && file.deleted !== null && <span className="small"> <span className="lines-added">+{file.added}</span> <span className="lines-deleted">−{file.deleted}</span></span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** DEPLOY-1: Deploy, or instead what deploying is at: a pull request open with its checks, or merged. */
function Deploy({ work, deployPath, onDeployed }: { work: Work; deployPath: string; onDeployed: () => void }) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = work.pullRequests?.find((pr) => pr.state === "open");
  if (open !== undefined) {
    const checks = checksOf(open);
    return <p className="deploy-state small" role="status">Pull request <a href={open.url} target="_blank" rel="noreferrer">#{open.number}</a> open{checks === null ? "" : `, ${CHECKS_LABEL[checks].toLowerCase()}`}</p>;
  }
  if (!work.deployable) return null;
  const deploy = () => {
    setBusy(true);
    setError(null);
    api<Session>("POST", deployPath).then(
      () => { setBusy(false); setSent(true); onDeployed(); },
      (cause: Error) => { setBusy(false); setError(cause.message); },
    );
  };
  return (
    <div className="deploy">
      <button type="button" className="deploy-button" disabled={busy || sent} onClick={deploy}>{busy ? "Deploying…" : "Deploy"}</button>
      {sent && <span className="muted small" role="status">Sent to the agent: it opens a pull request and merges it once its checks pass.</span>}
      {!sent && !busy && <span className="muted small">The agent opens a pull request to the default branch and merges it once its checks pass.</span>}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/**
 * CARD-3, CARD-4, DEPLOY-1, AUTO-16: a task's or a run's Work section: its branch's state, its
 * commits with their descriptions, its pull requests with their checks, the files it changed,
 * the other running tasks that changed the same files, and Deploy.
 */
export function WorkSection({ path, deployPath, onDeployed }: {
  /** The store route of its Work (`/tasks/<id>/changes`, `/runs/<id>/changes`). */
  path: string;
  /** Where Deploy posts (`/tasks/<id>/deploy`, `/runs/<id>/deploy`). */
  deployPath: string;
  onDeployed: () => void;
}) {
  const work = usePolled<Work>(path, 5_000);
  if (work.data === null) {
    return <section className="panel work" aria-label="Work"><h3>Work</h3><p className="muted small">{work.error ?? "Loading…"}</p></section>;
  }
  const { branch, commits, files, uncommitted, pullRequests, overlaps } = work.data;
  return (
    <section className="panel work" aria-label="Work">
      <header className="work-head">
        <h3>Work</h3>
        {branch !== null && <code className="branch" title="Branch">{branch}</code>}
      </header>
      <p className={`work-state work-state-${work.data.state}`} role="status" aria-label="Branch state">{stateLine(work.data)}</p>
      {work.data.state === "uncommitted" && uncommitted !== null && (
        <ul className="files uncommitted">{uncommitted.map((file) => <li key={file}><code>{file}</code></li>)}</ul>
      )}
      {branch !== null && commits === null && <p className="muted small">The branch cannot be read on this machine.</p>}
      {commits !== null && commits.length > 0 && (
        <ul className="commits" aria-label="Commits">{commits.map((commit) => <Commit key={commit.sha} commit={commit} />)}</ul>
      )}
      {branch !== null && (
        <div className="pull-requests" aria-label="Pull requests">
          {pullRequests === null && <p className="muted small">Pull requests unavailable.</p>}
          {pullRequests?.map((pr) => (
            <p key={pr.number} className="pull-request small">
              <span className={`pr-state pr-${pr.state}`}>{PR_STATE_LABEL[pr.state]}</span>
              <a href={pr.url} target="_blank" rel="noreferrer">PR #{pr.number}</a>
              <span className="pr-title">{pr.title}</span>
              <Checks pr={pr} />
            </p>
          ))}
        </div>
      )}
      {files !== null && files.length > 0 && <Files files={files} />}
      {overlaps.length > 0 && (
        <div className="overlaps">
          <p className="muted small">Same files changed in</p>
          {overlaps.map((overlap) => (
            <p key={overlap.taskId} className="overlap small"><a href={`#/t/${overlap.taskId}`}>{overlap.title}</a>: {overlap.files.join(", ")}</p>
          ))}
        </div>
      )}
      <Deploy work={work.data} deployPath={deployPath} onDeployed={() => { work.refresh(); onDeployed(); }} />
    </section>
  );
}
