import { useEffect, useState } from "react";
import { hostOrigin, zoneOf } from "../shared/hosts.ts";

/** Sessions whose chats stay loaded after you leave them, so going back shows them at once. */
const KEPT = 4;


/**
 * The running sessions' chats: Tern's chat on omp, in Tern's web client, which the gateway
 * serves for each session on its own chat host beside the UI's, `am-t-<session id>`
 * (shared/hosts.ts, server/tern-proxy.ts).
 *
 * Starting Tern's client takes a second or two, so the last few sessions' clients stay
 * loaded, hidden, and the current one shows. Frames keep the order they opened in: moving an
 * iframe in the document reloads it. Until a frame has loaded, a line says what it waits on:
 * a stopped session's container starts first (SESSION-10), which takes some seconds. Another
 * workspace tab covers the frames by hiding them, which keeps them loaded and sized (UI-2); a
 * chat first loads when its Chat tab shows, so a task's page does not start its container.
 */
export function SessionFrames({ current, covered, running, stopped, hub }: {
  current: string | null;
  covered: boolean;
  running: ReadonlySet<string> | null;
  stopped: ReadonlySet<string>;
  /** The hub's origin when the project is a hub's. */
  hub: string | null;
}) {
  const [frames, setFrames] = useState<{ order: string[]; used: string[] }>({ order: [], used: [] });
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (current === null || covered) return;
    setFrames(({ order, used }) => {
      const recent = [current, ...used.filter((id) => id !== current)].slice(0, KEPT);
      const kept = order.filter((id) => recent.includes(id));
      return { order: kept.includes(current) ? kept : [...kept, current], used: recent };
    });
  }, [current, covered]);
  // An ended session's client goes; while cards load, keep everything.
  const shown = frames.order.filter((id) => running === null || running.has(id));
  return (
    <div className={covered ? "session-frames covered" : "session-frames"} hidden={current === null}>
      {shown.map((id) => (
        <iframe
          key={id}
          className={id === current ? "session-frame current" : "session-frame"}
          src={`${hostOrigin(zoneOf(hub === null ? location : new URL(hub)), { kind: "chat", sessionId: id })}/`}
          title={id === current ? "Session" : "Session (hidden)"}
          allow="clipboard-read; clipboard-write"
          onLoad={() => setLoaded((before) => new Set([...before, id]))}
        />
      ))}
      {current !== null && !covered && shown.includes(current) && !loaded.has(current) && (
        <p className="session-frame-status" role="status">
          {stopped.has(current) ? "Starting the session's container…" : "Loading the chat…"}
        </p>
      )}
    </div>
  );
}
