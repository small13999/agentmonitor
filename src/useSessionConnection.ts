import { useCallback, useEffect, useRef, useState } from "react";
import { CmuxClient, WebSocketTransport, type Id, type Tree } from "cmux/browser";
import type { SessionProfile } from "./model";

export interface SessionConnection {
  client: CmuxClient | null;
  clientId: Id | null;
  tree: Tree | null;
  protocol: number | null;
  status: "connecting" | "live" | "error";
  error: string | null;
  reconnect(): void;
  createTerminal(existingTerminalCount: number): Promise<void>;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function useSessionConnection(session: SessionProfile): SessionConnection {
  const [client, setClient] = useState<CmuxClient | null>(null);
  const [clientId, setClientId] = useState<Id | null>(null);
  const [tree, setTree] = useState<Tree | null>(null);
  const [protocol, setProtocol] = useState<number | null>(null);
  const [status, setStatus] = useState<SessionConnection["status"]>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const clientRef = useRef<CmuxClient | null>(null);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: number | undefined;
    const nextClient = new CmuxClient({
      transport: new WebSocketTransport(session.websocketUrl, { authToken: session.token }),
      timeoutMs: 10_000,
    });
    clientRef.current = nextClient;
    setClient(null);
    setClientId(null);
    setTree(null);
    setProtocol(null);
    setStatus("connecting");
    setError(null);

    const refresh = async () => {
      try {
        const nextTree = await nextClient.listWorkspaces();
        if (!cancelled) {
          setTree(nextTree);
          setStatus("live");
          setError(null);
        }
      } catch (cause) {
        if (!cancelled) {
          setStatus("error");
          setError(errorMessage(cause));
        }
      }
    };

    void (async () => {
      try {
        const info = await nextClient.identify();
        const ownClient = (await nextClient.listClients()).find((candidate) => candidate.self);
        if (ownClient === undefined) throw new Error("cmux did not identify this monitor client");
        if (cancelled) {
          await nextClient.close();
          return;
        }
        setProtocol(info.protocol);
        setClientId(ownClient.client);
        setClient(nextClient);
        await refresh();
        if (!cancelled) pollTimer = window.setInterval(() => void refresh(), 1_000);
      } catch (cause) {
        if (!cancelled) {
          setStatus("error");
          setError(errorMessage(cause));
        }
      }
    })();

    return () => {
      cancelled = true;
      clearInterval(pollTimer);
      if (clientRef.current === nextClient) clientRef.current = null;
      void nextClient.close();
    };
  }, [generation, session.token, session.websocketUrl]);

  const createTerminal = useCallback(async (existingTerminalCount: number) => {
    const activeClient = clientRef.current;
    if (activeClient === null) return;
    await activeClient.run({
      argv: ["bash"],
      cwd: session.workingDirectory ?? "/workspace",
      name: `terminal-${existingTerminalCount + 1}`,
      new_workspace: true,
    });
    setTree(await activeClient.listWorkspaces());
  }, [session.workingDirectory]);

  return {
    client,
    clientId,
    tree,
    protocol,
    status,
    error,
    reconnect: () => setGeneration((value) => value + 1),
    createTerminal,
  };
}
