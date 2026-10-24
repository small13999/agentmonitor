import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { ClientMessage, ServerMessage } from "../../shared/chat.ts";
import { storeSocketUrl } from "../api.ts";

const Frame = z.looseObject({ type: z.string() });

/** The edge: what the gateway passes on from the chat host, checked as far as the page relies on it. */
const ServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    snapshot: z.object({
      cwd: z.string(),
      folder: z.string().nullable(),
      state: z.record(z.string(), z.unknown()),
      messages: z.array(z.unknown()),
      olderMessages: z.number(),
      run: z.array(z.object({ at: z.number(), frame: Frame })),
      dialogs: z.array(Frame),
      queue: z.object({ steering: z.array(z.string()), followUp: z.array(z.string()) }),
      commands: z.array(z.unknown()),
      ompRunning: z.boolean(),
    }),
  }),
  z.object({ type: z.literal("frame"), at: z.number(), frame: Frame }),
  z.object({ type: z.literal("response"), id: z.string(), command: z.string(), success: z.boolean(), data: z.unknown().optional(), error: z.string().optional() }),
  z.object({ type: z.literal("state"), state: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("dialog_closed"), id: z.string() }),
  z.object({ type: z.literal("omp_exited"), code: z.number().nullable() }),
  z.object({ type: z.literal("status"), text: z.string() }),
]);

export type ChatResponse = Extract<ServerMessage, { type: "response" }>;

/** Asks that the chat host answers with a `response` carrying the page's id. */
type ChatRequest =
  | { type: "rpc"; command: Extract<ClientMessage, { type: "rpc" }>["command"] }
  | { type: "list_chats" }
  | { type: "history"; before: number; limit: number };

export interface ChatConnection {
  /** The socket is open: what is sent now reaches the chat host. */
  connected: boolean;
  /** Why the gateway refused the chat for good (4404, 4409); null while it may connect. */
  refused: string | null;
  /** Why the last connection failed when it may work again (the session did not start, a hub is away); null once a snapshot came. */
  problem: string | null;
  /** Sends a message that wants no answer; false when the socket is not open. */
  send: (message: ClientMessage) => boolean;
  /** Sends a request and waits for its answer; rejects when the socket is closed or closes first. */
  request: (request: ChatRequest) => Promise<ChatResponse>;
}

/** Codes the gateway closes with when the chat cannot open at all; reconnecting would not help. */
const REFUSALS = new Set([4404, 4409]);
const MAX_BACKOFF_MS = 10_000;

/**
 * CHAT-1: a session's chat socket through the gateway. It reconnects with backoff when it
 * drops (the chat host restarts, the gateway reloads, the network goes); each new connection
 * starts with a fresh snapshot. `onMessage` gets every message except answers to `request`.
 */
export function useChatSocket(sessionId: string, onMessage: (message: ServerMessage) => void): ChatConnection {
  const [connected, setConnected] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const pending = useRef(new Map<string, { resolve: (response: ChatResponse) => void; reject: (cause: Error) => void }>());
  const nextId = useRef(0);
  const handler = useRef(onMessage);
  handler.current = onMessage;

  useEffect(() => {
    let stopped = false;
    let attempt = 0;
    let timer: number | undefined;
    setRefused(null);
    setProblem(null);
    const failPending = () => {
      for (const { reject } of pending.current.values()) reject(new Error("The connection to the chat closed."));
      pending.current.clear();
    };
    const connect = () => {
      const ws = new WebSocket(storeSocketUrl(`/sessions/${sessionId}/chat`));
      socket.current = ws;
      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
      };
      ws.onmessage = (event) => {
        if (stopped || typeof event.data !== "string") return;
        const parsed = ServerMessageSchema.safeParse(JSON.parse(event.data));
        if (!parsed.success) {
          console.warn("chat: an unexpected message", parsed.error.message);
          return;
        }
        const message: ServerMessage = parsed.data;
        if (message.type === "response") {
          const waiting = pending.current.get(message.id);
          pending.current.delete(message.id);
          waiting?.resolve(message);
          return;
        }
        if (message.type === "snapshot") setProblem(null);
        handler.current(message);
      };
      ws.onclose = (event) => {
        // A socket this effect closed itself (another session, unmounting) reports nothing.
        if (stopped) return;
        socket.current = null;
        setConnected(false);
        failPending();
        if (REFUSALS.has(event.code)) {
          setRefused(event.reason === "" ? "This chat cannot be opened." : event.reason);
          return;
        }
        // The gateway's own refusals (4000 + its status) say why; the next try may work.
        if (event.code >= 4000 && event.reason !== "") setProblem(event.reason);
        timer = window.setTimeout(connect, Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS));
        attempt += 1;
      };
    };
    connect();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      socket.current?.close();
      socket.current = null;
      setConnected(false);
      failPending();
    };
  }, [sessionId]);

  const send = (message: ClientMessage): boolean => {
    const ws = socket.current;
    if (ws === null || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(message));
    return true;
  };
  const request = (asked: ChatRequest): Promise<ChatResponse> => {
    const id = `page-${nextId.current++}`;
    const { promise, resolve, reject } = Promise.withResolvers<ChatResponse>();
    pending.current.set(id, { resolve, reject });
    if (!send({ ...asked, id })) {
      pending.current.delete(id);
      reject(new Error("The chat is not connected."));
    }
    return promise;
  };
  return { connected, refused, problem, send, request };
}
