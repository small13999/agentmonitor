import { useEffect, useState, type CSSProperties, type KeyboardEvent, type SubmitEvent } from "react";
import { api, type Actor, type Person, type Session } from "./api.ts";

/** What the page knows to show who did something: the store's people and the sessions agents act for. */
export interface Directory {
  people: Person[];
  /** Sessions by id, with the task each belongs to. */
  sessions: Map<string, Session>;
  /** Who uses the app now: in local mode the store's owner, on a hub the person who logged in. */
  me: Person | null;
}

/** PERSON-1: up to two initials of a name, standing in for a picture. */
function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((word) => Array.from(word)[0] ?? "").join("").toUpperCase();
}

/** PERSON-2: a session's agent gets a colour of its own, from its id. */
const AGENT_COLORS = ["#4c6ef5", "#9c36b5", "#1c7ed6", "#12b886", "#f76707", "#e64980", "#74b816"];

function agentColor(sessionId: string): string {
  let hash = 0;
  for (const char of sessionId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AGENT_COLORS[hash % AGENT_COLORS.length];
}

/** PERSON-2: a session's agent, its spark on a glossy square in the session's colour. */
export function AgentAvatar({ sessionId }: { sessionId: string }) {
  return <span className="avatar avatar-agent" style={{ "--s": agentColor(sessionId) } as CSSProperties} data-initials="AI" aria-hidden="true" />;
}

/**
 * PERSON-1: a person's initials on their colour; the initials are drawn, not text, so they
 * never join a name shown beside them. Alone (a board card) it is labelled with the name.
 */
export function PersonAvatar({ person, alone = false }: { person: Person; alone?: boolean }) {
  const label = alone ? { role: "img", "aria-label": person.name, title: person.name } : { "aria-hidden": true };
  return <span className="avatar" style={{ background: person.color }} data-initials={initials(person.name)} {...label} />;
}

/**
 * PERSON-1, PERSON-2: who did something, with their avatar. A person shows by name; an agent
 * as the agent of its session, on the session's avatar, linking to the session: its chat while
 * it runs, else its task's page, which lists it. A run of an automation (AUTO-9) has no task
 * page to link to.
 */
export function ActorName({ actor, directory }: { actor: Actor | null; directory: Directory }) {
  if (actor === null) return <span className="actor"><span className="avatar avatar-system" data-initials="GH" aria-hidden="true" /><span className="actor-name">GitHub</span></span>;
  if (actor.kind === "person") {
    const person = directory.people.find((candidate) => candidate.id === actor.personId);
    if (person === undefined) return <span className="actor muted"><span className="actor-name">Someone</span></span>;
    return <span className="actor"><PersonAvatar person={person} /><span className="actor-name">{person.name}</span></span>;
  }
  const session = directory.sessions.get(actor.sessionId);
  const label = session === undefined ? "Agent" : `Agent · ${session.name}`;
  const href = session === undefined || session.taskId === null ? undefined : session.endedAt === null ? `#/t/${session.taskId}/chat` : `#/t/${session.taskId}`;
  const title = session === undefined
    ? undefined
    : `The agent of the session started ${new Date(session.startedAt).toLocaleString()}${session.machine === null ? "" : ` on ${session.machine}`}${session.endedAt === null ? "" : ", ended"}`;
  return (
    <a className="actor agent" href={href} title={title} data-session={actor.sessionId}>
      <AgentAvatar sessionId={actor.sessionId} />
      <span className="actor-name">{label}</span>
    </a>
  );
}

/**
 * The people of the store and the sessions behind the given agents. Sessions the caller does
 * not know (an agent of another task) are asked for once.
 */
export function useDirectory(people: Person[] | null, me: Person | null, known: Session[], agentSessionIds: string[]): Directory {
  const [fetched, setFetched] = useState<Map<string, Session>>(new Map());
  const missing = agentSessionIds.filter((id) => !known.some((session) => session.id === id) && !fetched.has(id));
  const key = [...new Set(missing)].sort().join(",");
  useEffect(() => {
    if (key === "") return;
    let cancelled = false;
    Promise.all(key.split(",").map((id) => api<{ session: Session }>("GET", `/sessions/${id}`).then(({ session }) => session, () => null)))
      .then((sessions) => {
        if (cancelled) return;
        setFetched((before) => {
          const next = new Map(before);
          for (const session of sessions) if (session !== null) next.set(session.id, session);
          return next;
        });
      });
    return () => { cancelled = true; };
  }, [key]);
  const sessions = new Map(fetched);
  for (const session of known) sessions.set(session.id, session);
  return { people: people ?? [], me, sessions };
}

/** PERSON-1: a person's name, renamed in place by the owner or the person; Enter or leaving the field saves. */
function PersonRow({ person, canRename, onChanged }: { person: Person; canRename: boolean; onChanged: () => void }) {
  const [name, setName] = useState(person.name);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setName(person.name), [person.name]);
  const save = () => {
    const next = name.trim();
    if (next === "" || next === person.name) {
      setName(person.name);
      return;
    }
    setError(null);
    api<Person>("PATCH", `/people/${person.id}`, { name: next }).then(onChanged, (cause: Error) => setError(cause.message));
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") event.currentTarget.blur();
    if (event.key === "Escape") setName(person.name);
  };
  return (
    <li className="person">
      <PersonAvatar person={person} />
      {canRename
        ? <input value={name} aria-label={`Name of ${person.name}`} onChange={(event) => setName(event.target.value)} onBlur={save} onKeyDown={onKey} />
        : <span>{person.name}</span>}
      {person.owner && <span className="muted small">owner</span>}
      {person.email !== null && <span className="muted small">{person.email}</span>}
      {error && <span className="error small">{error}</span>}
    </li>
  );
}

/** AUTH-2, AUTH-3: the owner adds a person with the email they log in with through Cloudflare Access. */
function AddPerson({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open) return <button type="button" className="ghost" onClick={() => setOpen(true)}>+ Add person</button>;
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    api<Person>("POST", "/people", { name: String(form.get("name")).trim(), email: String(form.get("email")).trim() }).then(
      () => { setBusy(false); setOpen(false); onAdded(); },
      (cause: Error) => { setBusy(false); setError(cause.message); },
    );
  };
  return (
    <form className="inline-create" onSubmit={submit} aria-label="Add person">
      <input name="name" required autoFocus placeholder="Name" aria-label="Name of the new person" disabled={busy} />
      <input name="email" type="email" required placeholder="Email" aria-label="Email of the new person" disabled={busy} />
      <button type="submit" disabled={busy}>{busy ? "…" : "Add"}</button>
      <button type="button" className="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

/** PERSON-1, AUTH-3: the store's people; its owner adds them and renames anyone, a person renames themselves. */
export function PeopleDialog({ people, me, onChanged, onClose }: { people: Person[]; me: Person | null; onChanged: () => void; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <section className="panel people-dialog" role="dialog" aria-label="People">
      <header className="settings-head">
        <h3>People</h3>
        <button type="button" className="ghost close" aria-label="Close people" onClick={onClose}>×</button>
      </header>
      <ul className="people">
        {people.map((person) => (
          <PersonRow key={person.id} person={person} canRename={me !== null && (me.owner || me.id === person.id)} onChanged={onChanged} />
        ))}
      </ul>
      {me?.owner === true && <AddPerson onAdded={onChanged} />}
    </section>
  );
}
