import type { Person } from "./api.ts";

/** PERSON-1: a person's initials on their colour stand in for an avatar. */
export function Avatar({ person }: { person: Person }) {
  const initials = person.name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => [...word][0].toUpperCase()).join("");
  return (
    <span className="avatar" style={{ background: person.color }} title={person.name} aria-label={person.name} role="img">
      {initials}
    </span>
  );
}
