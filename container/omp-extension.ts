// The gateway's channel into the live omp session: JSON lines over a Unix socket in the
// workspace run directory. Requests carry an `id` and get one reply with the same id:
//   {op:"state"}          turn, model, session file, context usage
//   {op:"system_prompt"}
// Every client is also pushed {type:"turn", turn} whenever the main agent's turn changes.
// The conversation itself reaches the web UI through the chat host (chat-host.ts, omp's RPC mode), not this channel.
import { rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";

// The slice of omp's extension API this file uses; omp's type package is not a dependency.
interface Ctx {
  agent?: { kind: string };
  model?: { id: string };
  sessionManager?: { getSessionFile?(): string | undefined; ensureOnDisk?(): unknown };
  getContextUsage?(): unknown;
  getSystemPrompt(): string | string[];
}

interface Event {
  toolName?: string;
}

interface ExtensionApi {
  on(event: string, handler: (event: Event, ctx: Ctx) => unknown): void;
}

/** done: no turn running; working: a turn is running; blocked: the turn waits for the user. */
type Turn = "done" | "working" | "blocked";

// The session's chats get the channel's path from their launch (container/launch.ts), and every
// omp the agent starts itself (a test suite, `omp -p`) inherits it with this extension. Only the
// chat's omp, whose parent is the chat host, takes the channel; a newer chat takes it over.
const socketPath = process.env.AGENTMONITOR_CHAT === String(process.ppid) ? process.env.AGENTMONITOR_OMP_SOCKET : undefined;

const clients = new Set<Socket>();
let server: Server | null = null;
let live: Ctx | null = null;
let running = false;
// Open ask dialogs and approval prompts; the turn is blocked while any is open.
let waitingOnUser = 0;

function turn(): Turn {
  if (waitingOnUser > 0) return "blocked";
  return running ? "working" : "done";
}

function send(socket: Socket, body: Record<string, unknown>): void {
  socket.write(`${JSON.stringify(body)}\n`);
}

function handle(socket: Socket, line: string): void {
  const request: unknown = JSON.parse(line);
  if (typeof request !== "object" || request === null || !("op" in request)) {
    send(socket, { ok: false, error: "missing op" });
    return;
  }
  const id = "id" in request ? request.id : undefined;
  if (live === null) {
    send(socket, { id, ok: false, error: "session not started" });
    return;
  }
  if (request.op === "state") {
    send(socket, {
      id,
      ok: true,
      turn: turn(),
      sessionFile: live.sessionManager?.getSessionFile?.() ?? null,
      model: live.model?.id ?? null,
      usage: live.getContextUsage?.() ?? null,
    });
  } else if (request.op === "system_prompt") {
    const prompt = live.getSystemPrompt();
    send(socket, { id, ok: true, systemPrompt: Array.isArray(prompt) ? prompt.join("\n") : prompt });
  } else {
    send(socket, { id, ok: false, error: `unknown op ${String(request.op)}` });
  }
}

function listen(path: string): void {
  // A newer chat of the session (and omp's next session in this process) takes the channel over.
  rmSync(path, { force: true });
  server = createServer((socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          handle(socket, line);
        } catch (error) {
          send(socket, { ok: false, error: String(error) });
        }
      }
    });
  });
  // An extension that throws takes the session down with it; a dead channel must not.
  server.on("error", (error) => console.error(`agentmonitor channel: ${error.message}`));
  server.listen(path);
}

export default function agentmonitor(api: ExtensionApi): void {
  // Only the main agent is the session; subagents and advisors do not move its turn.
  const main = (name: string, handler: (event: Event, ctx: Ctx) => void) => {
    api.on(name, (event, ctx) => {
      if (ctx.agent?.kind === "main") handler(event, ctx);
    });
  };
  const track = (name: string, change: (event: Event) => void) => {
    main(name, (event) => {
      const before = turn();
      change(event);
      if (turn() === before) return;
      for (const client of clients) send(client, { type: "turn", turn: turn() });
    });
  };

  main("session_start", (_event, ctx) => {
    live = ctx;
    if (server === null && socketPath !== undefined) listen(socketPath);
  });
  // omp keeps a new chat in memory until its first reply. The chat's file is where the card
  // reads the prompt from, and what a restart resumes, so it is written from the first prompt.
  main("agent_start", (_event, ctx) => {
    if (socketPath !== undefined) ctx.sessionManager?.ensureOnDisk?.();
  });
  track("agent_start", () => { running = true; });
  track("agent_end", () => {
    running = false;
    waitingOnUser = 0;
  });
  track("tool_execution_start", (event) => { if (event.toolName === "ask") waitingOnUser++; });
  track("tool_execution_end", (event) => { if (event.toolName === "ask") waitingOnUser = Math.max(0, waitingOnUser - 1); });
  track("tool_approval_requested", () => { waitingOnUser++; });
  track("tool_approval_resolved", () => { waitingOnUser = Math.max(0, waitingOnUser - 1); });
}
