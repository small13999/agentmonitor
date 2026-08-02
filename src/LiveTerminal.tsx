import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import {
  CmuxTimeoutError,
  type CmuxClient,
  type CmuxStream,
  type DecodedAttachEvent,
  type DecodedOutputEvent,
  type DecodedVtStateEvent,
  type Id,
} from "cmux/browser";

interface LiveTerminalProps {
  client: CmuxClient | null;
  clientId: Id | null;
  focused: boolean;
  visible: boolean;
  surface: Id;
  onStatus(status: string): void;
  onError(error: string | null): void;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function LiveTerminal({
  client,
  clientId,
  focused,
  visible,
  surface,
  onStatus,
  onError,
}: LiveTerminalProps) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const resizeRef = useRef<() => void>(() => undefined);
  const focusedRef = useRef(focused);
  const visibleRef = useRef(visible);
  focusedRef.current = focused;
  visibleRef.current = visible;

  useEffect(() => {
    if (host === null || client === null || clientId === null) return;

    let cancelled = false;
    let resizeFrame: number | undefined;
    let stream: CmuxStream<DecodedAttachEvent> | null = null;
    let lastCols = 0;
    let lastRows = 0;
    const xterm = new Terminal({
      convertEol: false,
      cursorBlink: false,
      disableStdin: true,
      fontFamily: '"Berkeley Mono", "Cascadia Code", Consolas, monospace',
      fontSize: 7,
      lineHeight: 1,
      scrollback: 5_000,
      theme: {
        background: "#090b10",
        foreground: "#d7dce5",
        cursor: "#8bb8ff",
        selectionBackground: "#29446c",
      },
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    terminalRef.current = xterm;
    xterm.open(host);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      xterm.loadAddon(webgl);
    } catch (cause) {
      console.warn("WebGL terminal renderer unavailable; using the DOM renderer", cause);
    }
    const resize = () => {
      if (
        cancelled
        || !visibleRef.current
        || !host.isConnected
        || host.getClientRects().length === 0
      ) return;
      const dimensions = fit.proposeDimensions();
      if (dimensions === undefined || dimensions.cols < 20 || dimensions.rows < 5) return;
      xterm.resize(dimensions.cols, dimensions.rows);
      if (stream === null || (dimensions.cols === lastCols && dimensions.rows === lastRows)) return;
      lastCols = dimensions.cols;
      lastRows = dimensions.rows;
      void (async () => {
        try {
          await client.resizeSurface(surface, dimensions.cols, dimensions.rows);
          if (!cancelled) await client.useOnlyClientSizing(surface, clientId);
        } catch (cause) {
          lastCols = 0;
          lastRows = 0;
          if (!cancelled) onError(errorMessage(cause));
        }
      })();
    };
    resizeRef.current = resize;
    const observer = new ResizeObserver(() => {
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(resize);
    });
    observer.observe(host);

    const input = xterm.onData((text) => {
      if (!focusedRef.current) return;
      void client.send(surface, { text }).catch((cause) => onError(errorMessage(cause)));
    });
    const writeReplay = (data: Uint8Array) => new Promise<void>((resolve) => xterm.write(data, resolve));
    const resetFromReplay = async (event: DecodedVtStateEvent) => {
      xterm.reset();
      xterm.resize(event.cols, event.rows);
      await writeReplay(event.data);
      if (!cancelled) {
        xterm.options.disableStdin = !focusedRef.current;
        resize();
      }
    };

    void (async () => {
      try {
        onStatus("connecting");
        onError(null);
        stream = await client.attachSurface(surface);
        if (cancelled) {
          stream.close();
          return;
        }
        resize();
        onStatus("live");
        for (;;) {
          let event;
          try {
            event = await stream.next();
          } catch (cause) {
            if (cause instanceof CmuxTimeoutError) continue;
            throw cause;
          }
          if (cancelled || event.event === "detached") return;
          if (event.event === "vt-state") {
            await resetFromReplay(event as DecodedVtStateEvent);
          } else if (event.event === "output") {
            xterm.write((event as DecodedOutputEvent).data);
          } else if (event.event === "overflow") {
            throw new Error("Terminal stream overflowed; reconnect the machine");
          }
        }
      } catch (cause) {
        if (!cancelled) {
          onStatus("error");
          onError(errorMessage(cause));
        }
      }
    })();

    return () => {
      cancelled = true;
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
      observer.disconnect();
      input.dispose();
      stream?.close();
      resizeRef.current = () => undefined;
      if (terminalRef.current === xterm) terminalRef.current = null;
      xterm.dispose();
    };
  }, [client, clientId, host, onError, onStatus, surface]);

  useLayoutEffect(() => {
    const xterm = terminalRef.current;
    if (xterm === null) return;
    const fontSize = focused ? 13 : 7;
    const lineHeight = focused ? 1.15 : 1;
    xterm.options.cursorBlink = focused;
    xterm.options.disableStdin = !focused;
    xterm.options.fontSize = fontSize;
    xterm.options.lineHeight = lineHeight;
    if (focused) xterm.focus();
    resizeRef.current();
  }, [focused]);

  return <div className="terminal-host" ref={setHost} />;
}
