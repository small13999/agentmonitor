import { useEffect, useState, type KeyboardEvent, type ReactNode, type SubmitEvent } from "react";
import {
  api, ApiError, usePolled, type Card, type Comment, type HistoryEntry, type Person, type Task, type TaskDetail, type TaskState, type TaskSummary, type Topic,
} from "./api.ts";
import { HostMark, Light, LIGHT_LABEL, STATE_LABEL } from "./Board.tsx";
import { InlineCreate } from "./InlineCreate.tsx";
import { TaskFolder } from "./Folder.tsx";
import { Markdown } from "./Markdown.tsx";
import { ActorName, PeopleDialog, PersonAvatar, useDirectory, type Directory } from "./People.tsx";
import { TopicName } from "./Topics.tsx";

const UNFINISHED: TaskState[] = ["open", "in_progress", "in_review"];

function when(at: number): string {
  return new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function Time({ at }: { at: number }) {
  return <time className="muted small" dateTime={new Date(at).toISOString()}>{when(at)}</time>;
}

/** TASK-12: the title, edited in place; Enter or leaving the field saves, Escape goes back. */
function TitleField({ task, onSaved }: { task: Task; onSaved: () => void }) {
  const [title, setTitle] = useState(task.title);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setTitle(task.title), [task.title]);
  const save = () => {
    const next = title.trim();
    if (next === "" || next === task.title) {
      setTitle(task.title);
      return;
    }
    setError(null);
    api<Task>("PATCH", `/tasks/${task.id}`, { title: next }).then(onSaved, (cause: Error) => setError(cause.message));
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") event.currentTarget.blur();
    if (event.key === "Escape") setTitle(task.title);
  };
  return (
    <div className="title-field">
      <input className="title-input" aria-label="Title" value={title} onChange={(event) => setTitle(event.target.value)} onBlur={save} onKeyDown={onKey} />
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/** TASK-12: the description, rendered Markdown, edited in place. */
function DescriptionField({ task, onSaved }: { task: Task; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const description = String(new FormData(event.currentTarget).get("description")).trim();
    setError(null);
    api<Task>("PATCH", `/tasks/${task.id}`, { description }).then(
      () => { setEditing(false); onSaved(); },
      (cause: Error) => setError(cause.message),
    );
  };
  return (
    <section className="panel" aria-label="Description">
      <h3>Description</h3>
      {editing ? (
        <form className="edit-task" onSubmit={submit}>
          <textarea name="description" rows={8} defaultValue={task.description} aria-label="Description" autoFocus />
          <div className="actions">
            <button type="submit">Save</button>
            <button type="button" className="ghost" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </form>
      ) : (
        <>
          {task.description.trim() === "" ? <p className="muted small">No description.</p> : <Markdown text={task.description} />}
          <button type="button" className="ghost" onClick={() => setEditing(true)}>Edit description</button>
        </>
      )}
      {error && <p className="error small">{error}</p>}
    </section>
  );
}

/** The commits an unconfirmed finish was refused for; null for any other failure. */
function unpushedOf(cause: Error): string[] | null {
  if (!(cause instanceof ApiError) || !Array.isArray(cause.details.unpushed)) return null;
  return cause.details.unpushed.filter((commit) => typeof commit === "string");
}

/**
 * TASK-9: marking the task done or cancelled ends its session and deletes its branch here;
 * when the branch has commits no remote has, the gateway refuses and they are listed before
 * asking again.
 */
function FinishTask({ task, onFinished }: { task: Task; onFinished: () => void }) {
  const [state, setState] = useState<"done" | "cancelled" | null>(null);
  const [busy, setBusy] = useState(false);
  const [unpushed, setUnpushed] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const finish = (target: "done" | "cancelled", confirm: boolean) => {
    setState(target);
    setBusy(true);
    setError(null);
    api<Task>("POST", `/tasks/${task.id}/finish`, { state: target, ...(confirm ? { confirm } : {}) }).then(
      () => { setBusy(false); setUnpushed(null); onFinished(); },
      (cause: Error) => {
        setBusy(false);
        const commits = unpushedOf(cause);
        if (commits !== null) setUnpushed(commits);
        else setError(cause.message);
      },
    );
  };
  return (
    <div className="finish-task" role="region" aria-label="Finish task">
      {unpushed === null ? (
        <div className="actions">
          <button type="button" disabled={busy} onClick={() => finish("done", false)}>Mark done</button>
          <button type="button" className="ghost danger" disabled={busy} onClick={() => finish("cancelled", false)}>Cancel task</button>
        </div>
      ) : (
        <>
          <p className="error small">No remote has these commits; finishing deletes them with the branch:</p>
          <ul className="files unpushed">{unpushed.map((commit) => <li key={commit}><code>{commit}</code></li>)}</ul>
          <div className="actions">
            <button type="button" className="danger" disabled={busy} onClick={() => state !== null && finish(state, true)}>
              {state === "done" ? "Mark done" : "Cancel task"} and delete them
            </button>
            <button type="button" className="ghost" disabled={busy} onClick={() => setUnpushed(null)}>Keep working</button>
          </div>
        </>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/** TASK-1, TASK-12: the state, changed in place; finishing (TASK-9) and reopening have their own buttons. */
function StateField({ task, onChanged }: { task: Task; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const update = (state: TaskState) => {
    setError(null);
    api<Task>("PATCH", `/tasks/${task.id}`, { state }).then(onChanged, (cause: Error) => setError(cause.message));
  };
  const finished = !UNFINISHED.includes(task.state);
  return (
    <section className="field" aria-label="State">
      <h3>State</h3>
      {finished ? (
        <div className="actions">
          <span>{STATE_LABEL[task.state]}</span>
          <button type="button" className="ghost" onClick={() => update("open")}>Reopen</button>
        </div>
      ) : (
        <>
          <select value={task.state} aria-label="State" onChange={(event) => {
            const state = UNFINISHED.find((candidate) => candidate === event.target.value);
            if (state !== undefined) update(state);
          }}>
            {UNFINISHED.map((state) => <option key={state} value={state}>{STATE_LABEL[state]}</option>)}
          </select>
          <FinishTask task={task} onFinished={onChanged} />
        </>
      )}
      {error && <p className="error small">{error}</p>}
    </section>
  );
}

/** TASK-13: one person or nobody; PERSON-1: the people come from the store, where its owner adds them. */
function AssigneeField({ task, directory, onChanged, onPeopleChanged }: {
  task: Task;
  directory: Directory;
  onChanged: () => void;
  onPeopleChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
  const assignee = directory.people.find((person) => person.id === task.assigneeId) ?? null;
  const assign = (assigneeId: string | null) => {
    setError(null);
    api<Task>("PATCH", `/tasks/${task.id}`, { assigneeId }).then(onChanged, (cause: Error) => setError(cause.message));
  };
  return (
    <section className="field" aria-label="Assignee">
      <h3>Assignee</h3>
      <div className="actions">
        {assignee !== null && <PersonAvatar person={assignee} />}
        <select value={task.assigneeId ?? ""} aria-label="Assignee" onChange={(event) => assign(event.target.value === "" ? null : event.target.value)}>
          <option value="">Nobody</option>
          {directory.people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
        </select>
        <button type="button" className="ghost" onClick={() => setManaging(true)}>People…</button>
      </div>
      {error && <p className="error small">{error}</p>}
      {managing && <PeopleDialog people={directory.people} me={directory.me} onChanged={onPeopleChanged} onClose={() => setManaging(false)} />}
    </section>
  );
}

/** TASK-2, TASK-12: the task's topics, linked and unlinked in place, or a new one created and linked. */
function TopicsField({ summary, topics, onChanged }: { summary: TaskSummary; topics: Topic[]; onChanged: () => void }) {
  const taskId = summary.task.id;
  const [error, setError] = useState<string | null>(null);
  const linked = summary.topics;
  const change = (method: "PUT" | "DELETE", topicId: string) => {
    setError(null);
    api(method, `/tasks/${taskId}/topics/${topicId}`).then(onChanged, (cause: Error) => setError(cause.message));
  };
  const available = topics.filter((topic) => !linked.some((candidate) => candidate.id === topic.id));
  return (
    <section className="field" aria-label="Topics">
      <h3>Topics</h3>
      <div className="chips">
        {linked.length === 0 && <span className="muted small">No topics.</span>}
        {linked.map((topic) => (
          <span key={topic.id} className="chip">
            <TopicName topic={topic} />
            <button type="button" className="chip-x" aria-label={`Unlink ${topic.name}`} onClick={() => change("DELETE", topic.id)}>×</button>
          </span>
        ))}
      </div>
      {available.length > 0 && (
        <select value="" onChange={(event) => change("PUT", event.target.value)} aria-label="Link topic">
          <option value="">Link a topic…</option>
          {available.map((topic) => <option key={topic.id} value={topic.id}>{topic.name}</option>)}
        </select>
      )}
      <InlineCreate
        label="New topic"
        placeholder="Topic name"
        submit={async (name) => {
          const created = await api<Topic>("POST", `/projects/${summary.task.projectId}/topics`, { name });
          await api("PUT", `/tasks/${taskId}/topics/${created.id}`);
          onChanged();
        }}
      />
      {error && <p className="error small">{error}</p>}
    </section>
  );
}

/** TASK-12: every session the task has had; CARD-1: the running one's state. */
function SessionsField({ task, detail, card, directory }: { task: Task; detail: TaskDetail | null; card: Card | null; directory: Directory }) {
  const sessions = detail?.sessions ?? [];
  const running = sessions.some((session) => session.endedAt === null);
  return (
    <section className="field" aria-label="Sessions">
      <h3>Sessions</h3>
      {detail === null && <p className="muted small">Loading…</p>}
      {detail !== null && sessions.length === 0 && <p className="muted small">No session has worked on this task yet.</p>}
      <ul className="sessions">
        {sessions.map((session) => (
          <li key={session.id} className="session-row">
            <ActorName actor={{ kind: "agent", sessionId: session.id }} directory={directory} />
            <span className="muted small">
              {when(session.startedAt)}{session.machine === null ? "" : ` on ${session.machine}`}
              {session.endedAt === null ? "" : `, ended ${when(session.endedAt)}`}
            </span>
            {session.endedAt === null && card?.session.id === session.id && (
              <span className="session-state"><Light turn={card.turn} />{LIGHT_LABEL[card.turn]}</span>
            )}
            {session.endedAt === null && <HostMark card={card?.session.id === session.id ? card : null} />}
          </li>
        ))}
      </ul>
      {running
        ? <a className="button-link" href={`#/t/${task.id}/chat`}>Open chat</a>
        : UNFINISHED.includes(task.state) && <a className="button-link" href={`#/t/${task.id}/chat`}>Start a session</a>}
    </section>
  );
}

/** TASK-7: what the task's agents last wrote about where the work stands. */
function StatusSection({ task }: { task: Task }) {
  return (
    <section className="panel" aria-label="Status">
      <h3>Status <span className="muted small">rev {task.statusRevision}</span></h3>
      {task.status.trim() === "" ? <p className="muted small">No status yet. The task's agents write it.</p> : <Markdown text={task.status} />}
    </section>
  );
}

/** COMMENT-1, COMMENT-2: one comment, rendered, with its author and time; its author edits or deletes it. */
function CommentView({ comment, directory, onChanged }: { comment: Comment; directory: Directory; onChanged: () => void }) {
  const [mode, setMode] = useState<"view" | "edit" | "delete">("view");
  const [error, setError] = useState<string | null>(null);
  const mine = comment.author.kind === "person" && comment.author.personId === directory.me?.id;
  const run = (call: Promise<unknown>) => {
    setError(null);
    call.then(() => { setMode("view"); onChanged(); }, (cause: Error) => setError(cause.message));
  };
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    run(api("PATCH", `/comments/${comment.id}`, { body: String(new FormData(event.currentTarget).get("body")) }));
  };
  return (
    <article className="comment" id={`comment-${comment.id}`}>
      <header className="comment-head">
        <ActorName actor={comment.author} directory={directory} />
        <Time at={comment.createdAt} />
        {comment.editedAt !== null && <span className="muted small" title={`Edited ${when(comment.editedAt)}`}>(edited)</span>}
        {mine && mode === "view" && (
          <span className="comment-actions">
            <button type="button" className="ghost" onClick={() => setMode("edit")}>Edit</button>
            <button type="button" className="ghost danger" onClick={() => setMode("delete")}>Delete</button>
          </span>
        )}
      </header>
      {mode === "edit" ? (
        <form className="edit-task" onSubmit={submit}>
          <textarea name="body" rows={5} defaultValue={comment.body} aria-label="Edit comment" autoFocus />
          <div className="actions">
            <button type="submit">Save</button>
            <button type="button" className="ghost" onClick={() => setMode("view")}>Cancel</button>
          </div>
        </form>
      ) : <Markdown text={comment.body} />}
      {mode === "delete" && (
        <div className="actions">
          <span className="small">Delete this comment?</span>
          <button type="button" className="danger" onClick={() => run(api("DELETE", `/comments/${comment.id}`))}>Delete comment</button>
          <button type="button" className="ghost" onClick={() => setMode("view")}>Keep it</button>
        </div>
      )}
      {error && <p className="error small">{error}</p>}
    </article>
  );
}

/** COMMENT-1: people comment from the page; COMMENT-3: comments never reach a running chat. */
function CommentsSection({ taskId, comments, directory, onChanged }: {
  taskId: string;
  comments: Comment[] | null;
  directory: Directory;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const body = String(new FormData(form).get("body")).trim();
    if (body === "") return;
    setBusy(true);
    setError(null);
    api<Comment>("POST", `/tasks/${taskId}/comments`, { body }).then(
      () => { setBusy(false); form.reset(); onChanged(); },
      (cause: Error) => { setBusy(false); setError(cause.message); },
    );
  };
  return (
    <section className="panel" aria-label="Comments">
      <h3>Comments</h3>
      {comments === null && <p className="muted small">Loading…</p>}
      {comments?.length === 0 && <p className="muted small">No comments yet.</p>}
      {comments?.map((comment) => <CommentView key={comment.id} comment={comment} directory={directory} onChanged={onChanged} />)}
      <form className="comment-form" onSubmit={submit} aria-label="New comment">
        <textarea
          name="body"
          rows={3}
          aria-label="Comment"
          placeholder="Comment in Markdown. Agents read comments when their session starts, never in a running chat."
          disabled={busy}
        />
        <div className="actions"><button type="submit" disabled={busy}>Comment</button></div>
        {error && <p className="error small">{error}</p>}
      </form>
    </section>
  );
}

/** TASK-14: one history entry, said as what its actor did. */
function describe(entry: HistoryEntry, directory: Directory, comments: Comment[]): ReactNode {
  switch (entry.kind) {
    case "created":
      return "created the task";
    case "state":
      return `moved it from ${STATE_LABEL[entry.from]} to ${STATE_LABEL[entry.to]}`;
    case "assignee": {
      if (entry.personId === null) return "unassigned it";
      const person = directory.people.find((candidate) => candidate.id === entry.personId);
      return <>assigned it to {person === undefined ? "someone" : <span className="actor"><PersonAvatar person={person} />{person.name}</span>}</>;
    }
    case "topic":
      return `${entry.linked ? "linked" : "unlinked"} topic ${entry.name}`;
    case "session":
      return `${entry.event} a ${entry.runtime === "host" ? "host " : ""}session${entry.machine === null ? "" : ` on ${entry.machine}`}`;
    case "comment":
      return comments.some((comment) => comment.id === entry.commentId)
        ? <>wrote a <a href={`#comment-${entry.commentId}`} onClick={(event) => {
            event.preventDefault();
            document.getElementById(`comment-${entry.commentId}`)?.scrollIntoView({ behavior: "smooth" });
          }}>comment</a></>
        : "wrote a comment, since deleted";
    case "file":
      return <>added <code>{entry.path}</code></>;
    case "pull_request":
      return <>pull request <a href={entry.url} target="_blank" rel="noreferrer">#{entry.number}</a> {entry.title} opened</>;
  }
}

function HistorySection({ entries, directory, comments }: { entries: HistoryEntry[] | null; directory: Directory; comments: Comment[] }) {
  return (
    <section className="panel" aria-label="History">
      <h3>History</h3>
      {entries === null && <p className="muted small">Loading…</p>}
      <ol className="history">
        {entries?.map((entry, index) => (
          <li key={index} data-kind={entry.kind}>
            <ActorName actor={entry.actor} directory={directory} />
            <span>{describe(entry, directory, comments)}</span>
            <Time at={entry.at} />
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * TASK-12: the task's page, its primary place: title, description, state, assignee, and
 * topics, edited in place; its status, folder, comments, history, and sessions. CARD-1: the
 * running session's state shows by the title.
 */
export function TaskPage({ summary, card, topics, onChanged }: { summary: TaskSummary; card: Card | null; topics: Topic[]; onChanged: () => void }) {
  const { task } = summary;
  const detail = usePolled<TaskDetail>(`/tasks/${task.id}`, 3_000);
  const comments = usePolled<Comment[]>(`/tasks/${task.id}/comments`, 3_000);
  const history = usePolled<HistoryEntry[]>(`/tasks/${task.id}/history`, 5_000);
  const people = usePolled<Person[]>("/people", 10_000);
  const me = usePolled<{ kind: string; person?: Person }>("/me", 60_000);
  const agents = [...(comments.data ?? []).map((comment) => comment.author), ...(history.data ?? []).flatMap((entry) => (entry.actor === null ? [] : [entry.actor]))]
    .flatMap((actor) => (actor.kind === "agent" ? [actor.sessionId] : []));
  const directory = useDirectory(people.data, me.data?.person ?? null, detail.data?.sessions ?? [], agents);
  const changed = () => {
    onChanged();
    detail.refresh();
    history.refresh();
  };
  const commented = () => {
    comments.refresh();
    history.refresh();
  };
  return (
    <article className="workspace-page task-page" aria-label="Task page">
      <header className="page-head">
        <TitleField task={task} onSaved={changed} />
        {card !== null && (
          <span className="session-state" role="status" aria-label="Session state">
            <Light turn={card.turn} />{LIGHT_LABEL[card.turn]}
          </span>
        )}
        <HostMark card={card} />
      </header>
      <div className="page-grid">
        <div className="page-main">
          <DescriptionField task={task} onSaved={changed} />
          <StatusSection task={task} />
          <TaskFolder taskId={task.id} directory={directory} />
          <CommentsSection taskId={task.id} comments={comments.data} directory={directory} onChanged={commented} />
          <HistorySection entries={history.data} directory={directory} comments={comments.data ?? []} />
        </div>
        <aside className="page-side" aria-label="Task fields">
          <StateField task={task} onChanged={changed} />
          <AssigneeField task={task} directory={directory} onChanged={changed} onPeopleChanged={people.refresh} />
          <TopicsField summary={summary} topics={topics} onChanged={changed} />
          <SessionsField task={task} detail={detail.data} card={card} directory={directory} />
        </aside>
      </div>
    </article>
  );
}
