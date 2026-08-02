import { useCallback, useEffect, useMemo, useState } from "react";
import type { CmuxClient } from "cmux/browser";
import { listManagedSessions, managedSessionProfile, pauseManagedSession } from "./agentctl";
import type { ManagedSession } from "./agentctl";
import { LiveTerminal } from "./LiveTerminal";
import { ManagedSessions } from "./ManagedSessions";
import {
  DEFAULT_MACHINE,
  SERVICE_SLOTS,
  loadMachines,
  projectSession,
  serviceUrl,
  saveMachines,
  type MachineProfile,
  type SessionProfile,
  type TerminalView,
} from "./model";
import { useSessionConnection } from "./useSessionConnection";

interface MachineManagerProps {
  machines: MachineProfile[];
  activeMachineId: string;
  onClose(): void;
  onSelect(id: string): void;
  onUpdate(machines: MachineProfile[], activeId: string): void;
}

function MachineManager({
  machines,
  activeMachineId,
  onClose,
  onSelect,
  onUpdate,
}: MachineManagerProps) {
  const [editingId, setEditingId] = useState<string | null>(activeMachineId);
  const editing = machines.find((machine) => machine.id === editingId) ?? null;
  const [name, setName] = useState(editing?.name ?? "");
  const [sessions, setSessions] = useState<SessionProfile[]>(editing?.sessions ?? []);

  const editMachine = (machine: MachineProfile) => {
    setEditingId(machine.id);
    setName(machine.name);
    setSessions(machine.sessions);
  };

  const addMachine = () => {
    setEditingId(null);
    setName("");
    setSessions([]);
  };

  const addSession = () => {
    setSessions((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        name: `Workspace ${current.length + 1}`,
        websocketUrl: "ws://127.0.0.1:7691",
        token: "",
      },
    ]);
  };

  const updateSession = (id: string, patch: Partial<SessionProfile>) => {
    setSessions((current) => current.map((session) => session.id === id ? { ...session, ...patch } : session));
  };

  const removeSession = (id: string) => {
    setSessions((current) => current.filter((session) => session.id !== id));
  };

  const commit = () => {
    const trimmedName = name.trim();
    const validSessions = sessions.every((session) => session.name.trim().length > 0 && session.websocketUrl.trim().length > 0);
    if (trimmedName.length === 0 || !validSessions) return;
    const normalizedSessions = sessions.map((session) => ({
      ...session,
      name: session.name.trim(),
      websocketUrl: session.websocketUrl.trim(),
    }));
    if (editingId === null) {
      const machine = { id: crypto.randomUUID(), name: trimmedName, sessions: normalizedSessions };
      onUpdate([...machines, machine], machine.id);
      setEditingId(machine.id);
      return;
    }
    onUpdate(
      machines.map((machine) => machine.id === editingId
        ? { ...machine, name: trimmedName, sessions: normalizedSessions }
        : machine),
      activeMachineId,
    );
  };

  const remove = () => {
    if (editingId === null) return;
    const remaining = machines.filter((machine) => machine.id !== editingId);
    const nextMachines = remaining.length === 0 ? [DEFAULT_MACHINE] : remaining;
    const nextActive = editingId === activeMachineId ? nextMachines[0].id : activeMachineId;
    onUpdate(nextMachines, nextActive);
    editMachine(nextMachines.find((machine) => machine.id === nextActive) ?? nextMachines[0]);
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        aria-label="Connected machines"
        aria-modal="true"
        className="machine-manager"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header>
          <div>
            <p className="eyebrow">CONNECTIONS</p>
            <h2>Connected machines</h2>
          </div>
          <button className="secondary" onClick={onClose} type="button">Close</button>
        </header>
        <div className="machine-manager__body">
          <nav className="machine-list" aria-label="Saved machines">
            {machines.map((machine) => (
              <button
                className={machine.id === editingId ? "machine-list__item active" : "machine-list__item"}
                key={machine.id}
                onClick={() => editMachine(machine)}
                type="button"
              >
                <strong>{machine.name}</strong>
                <span>{machine.sessions.length} container session{machine.sessions.length === 1 ? "" : "s"}</span>
                {machine.id === activeMachineId && <small>selected</small>}
              </button>
            ))}
            <button className="machine-list__add" onClick={addMachine} type="button">+ Add machine</button>
          </nav>
          <form onSubmit={(event) => { event.preventDefault(); commit(); }}>
            <label>
              Machine name
              <input autoFocus value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <div className="session-endpoints">
              <div className="session-endpoints__header">
                <strong>Container sessions</strong>
                <button className="secondary" onClick={addSession} type="button">+ Add session</button>
              </div>
              {sessions.map((session) => (
                <fieldset key={session.id}>
                  <label>
                    Session name
                    <input value={session.name} onChange={(event) => updateSession(session.id, { name: event.target.value })} />
                  </label>
                  <label>
                    cmux WebSocket URL
                    <input value={session.websocketUrl} onChange={(event) => updateSession(session.id, { websocketUrl: event.target.value })} />
                  </label>
                  <label>
                    Token
                    <input value={session.token} onChange={(event) => updateSession(session.id, { token: event.target.value })} type="password" />
                  </label>
                  <button className="danger" onClick={() => removeSession(session.id)} type="button">Remove session</button>
                </fieldset>
              ))}
            </div>
            <p className="field-note">Each endpoint is one isolated container with its own cmux daemon. Prototype tokens are stored in browser local storage.</p>
            <div className="machine-form__actions">
              {editingId !== null && <button className="danger" onClick={remove} type="button">Remove machine</button>}
              {editingId !== null && editingId !== activeMachineId && (
                <button className="secondary" onClick={() => onSelect(editingId)} type="button">Select</button>
              )}
              <button type="submit">Save machine</button>
            </div>
          </form>
        </div>
      </section>
    </div>
  );
}

function ServiceLinks({ sessionId, compact = false }: { sessionId: string; compact?: boolean }) {
  return (
    <div className={compact ? "service-links service-links--compact" : "service-links"}>
      {SERVICE_SLOTS.map((slot) => (
        <a
          href={serviceUrl(sessionId, slot.id)}
          key={slot.id}
          onClick={(event) => event.stopPropagation()}
          rel="noreferrer"
          target="_blank"
        >
          {slot.name}
        </a>
      ))}
    </div>
  );
}

type TerminalInputMode = "presentation" | "focus";

interface FocusedTerminal {
  key: string;
  mode: TerminalInputMode;
}

interface TerminalCardProps {
  client: CmuxClient | null;
  clientId: TerminalView["surface"] | null;
  focusedMode: TerminalInputMode | null;
  terminal: TerminalView;
  title: string;
  sizingVisible: boolean;
  action?: { label: string; run(): void };
  secondaryAction?: { label: string; run(): void };
  serviceSessionId?: string;
  hidden?: boolean;
  onClose(): void;
  onFocus(mode: TerminalInputMode): void;
  onToggleMode(): void;
}

function TerminalCard({
  client,
  clientId,
  focusedMode,
  terminal,
  title,
  sizingVisible,
  action,
  secondaryAction,
  serviceSessionId,
  hidden = false,
  onClose,
  onFocus,
  onToggleMode,
}: TerminalCardProps) {
  const [status, setStatus] = useState("connecting");
  const [error, setError] = useState<string | null>(null);
  const focused = focusedMode !== null;

  return (
    <article
      className={`terminal-card${hidden ? " terminal-card--hidden" : ""}${focused ? " terminal-card--focused" : ""}${focusedMode === "focus" ? " terminal-card--focus-mode" : ""}`}
      onClick={() => {
        if (!focused) onFocus("presentation");
      }}
      onKeyDown={(event) => {
        const toggleFocus = event.altKey
          && event.shiftKey
          && !event.ctrlKey
          && !event.metaKey
          && event.key === "Enter";
        if (toggleFocus) {
          event.preventDefault();
          event.stopPropagation();
          if (focused) onToggleMode();
          else onFocus("focus");
          return;
        }
        if (!focused && (event.key === "Enter" || event.key === " ")) onFocus("presentation");
      }}
      tabIndex={0}
    >
      <header className="terminal-card__header">
        <div>
          <strong>{title}</strong>
          <span>{terminal.tab}</span>
        </div>
        <div className="terminal-card__actions">
          {serviceSessionId !== undefined && <ServiceLinks compact sessionId={serviceSessionId} />}
          {!focused && secondaryAction && (
            <button
              className="secondary"
              onClick={(event) => { event.stopPropagation(); secondaryAction.run(); }}
              type="button"
            >
              {secondaryAction.label}
            </button>
          )}
          {focused ? (
            <>
              <span
                className={`terminal-mode terminal-mode--${focusedMode}`}
                title={focusedMode === "focus" ? "Terminal keys pass through" : "Escape closes this view"}
              >
                {focusedMode === "focus" ? "Focus mode" : "Presentation"}
              </span>
              <button
                className="secondary"
                onClick={(event) => { event.stopPropagation(); onToggleMode(); }}
                title="Alt+Shift+Enter"
                type="button"
              >
                {focusedMode === "focus" ? "Presentation mode" : "Focus mode"}
              </button>
              <button onClick={(event) => { event.stopPropagation(); onClose(); }} type="button">Close</button>
            </>
          ) : action ? (
            <button onClick={(event) => { event.stopPropagation(); action.run(); }} type="button">{action.label}</button>
          ) : (
            <span className="terminal-card__hint">Click to open</span>
          )}
          <span className={`terminal-status terminal-status--${status}`}>{status}</span>
        </div>
      </header>
      <LiveTerminal
        client={client}
        clientId={clientId}
        focused={focused}
        visible={sizingVisible}
        surface={terminal.surface}
        onStatus={setStatus}
        onError={setError}
      />
      {error && <div className="terminal-error">{error}</div>}
      <footer>{terminal.internalWorkspace} · {terminal.screen} · {terminal.paneName} · {String(terminal.surface)}</footer>
    </article>
  );
}

type SessionRuntimeMode = "monitor" | "workspace" | "hidden";

interface SessionRuntimeProps {
  session: SessionProfile;
  mode: SessionRuntimeMode;
  focusedTerminal: FocusedTerminal | null;
  onBack(): void;
  onFocusTerminal(key: string, mode: TerminalInputMode): void;
  onOpen(): void;
  onCloseTerminal(): void;
  onToggleTerminalMode(): void;
  onPause?(): void;
}

function SessionRuntime({
  session,
  mode,
  focusedTerminal,
  onBack,
  onFocusTerminal,
  onOpen,
  onCloseTerminal,
  onToggleTerminalMode,
  onPause,
}: SessionRuntimeProps) {
  const connection = useSessionConnection(session);
  const view = projectSession(connection.tree);
  const createTerminal = async () => {
    try {
      await connection.createTerminal(view.terminals.length);
    } catch (cause) {
      console.error(cause);
    }
  };

  return (
    <>
      {mode === "workspace" && (
        <div className="workspace-view-header">
          <header className="app-header">
            <div>
              <p className="eyebrow">CONTAINER WORKSPACE</p>
              <div className="title-row">
                <button className="back-button" onClick={onBack} type="button">←</button>
                <h1>{session.name}</h1>
              </div>
              <p>Every terminal controlled by this container's private cmux daemon.</p>
            </div>
            <div className="header-actions">
              <ServiceLinks sessionId={session.id} />
              <button className="secondary" onClick={connection.reconnect} type="button">Reconnect</button>
              <button disabled={connection.client === null} onClick={() => void createTerminal()} type="button">New terminal</button>
            </div>
          </header>
          <section className="status-strip" aria-live="polite">
            <span className={`connection-dot connection-dot--${connection.status}`} />
            <strong>{connection.status}</strong>
            <span>{session.websocketUrl}</span>
            <span>{connection.protocol === null ? "protocol —" : `protocol ${connection.protocol}`}</span>
            <span>{view.terminals.length} terminal{view.terminals.length === 1 ? "" : "s"}</span>
          </section>
          {connection.error && <div className="app-error">{connection.error}</div>}
        </div>
      )}

      {view.mainTerminal === null && (
        <article className={mode === "monitor" ? "empty-workspace-card" : "empty-workspace-card terminal-card--hidden"}>
          <div className="session-placeholder__status">
            <span className={`connection-dot connection-dot--${connection.status}`} />
            <strong>{session.name}</strong>
          </div>
          <p>{connection.error ?? "Waiting for this container's main harness terminal."}</p>
          <div className="session-placeholder__actions">
            <button className="secondary" onClick={connection.reconnect} type="button">Reconnect</button>
            {mode === "monitor" && onPause && (
              <button className="secondary" onClick={onPause} type="button">Pause</button>
            )}
            <button onClick={onOpen} type="button">Open workspace</button>
          </div>
        </article>
      )}

      {view.terminals.map((terminal) => {
        const terminalKey = `${session.id}:${terminal.key}`;
        const isMain = terminal.surface === view.mainTerminal?.surface;
        const visible = mode === "workspace" || (mode === "monitor" && isMain);
        return (
          <TerminalCard
            client={connection.client}
            clientId={connection.clientId}
            focusedMode={focusedTerminal?.key === terminalKey ? focusedTerminal.mode : null}
            action={mode === "monitor" && isMain
              ? { label: `Open workspace · ${view.terminals.length} terminal${view.terminals.length === 1 ? "" : "s"}`, run: onOpen }
              : undefined}
            secondaryAction={mode === "monitor" && isMain && onPause
              ? { label: "Pause", run: onPause }
              : undefined}
            sizingVisible={visible && (focusedTerminal === null || focusedTerminal.key === terminalKey)}
            hidden={!visible}
            serviceSessionId={visible ? session.id : undefined}
            onClose={onCloseTerminal}
            onFocus={(inputMode) => onFocusTerminal(terminalKey, inputMode)}
            onToggleMode={onToggleTerminalMode}
            terminal={terminal}
            title={mode === "monitor"
              ? session.name
              : terminal.internalWorkspace === "main"
                ? `${session.name} · main`
                : terminal.internalWorkspace}
          />
        );
      })}
    </>
  );
}

export default function App() {
  const [machines, setMachines] = useState<MachineProfile[]>(loadMachines);
  const [activeMachineId, setActiveMachineId] = useState(machines[0].id);
  const [managedSessions, setManagedSessions] = useState<ManagedSession[]>([]);
  const [machineManagerOpen, setMachineManagerOpen] = useState(false);
  const [sessionManagerOpen, setSessionManagerOpen] = useState(false);
  const [managedError, setManagedError] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [focusedTerminal, setFocusedTerminal] = useState<FocusedTerminal | null>(null);

  const refreshManagedSessions = useCallback(async () => {
    const sessions = await listManagedSessions();
    setManagedSessions(sessions);
    setManagedError(null);
  }, []);

  useEffect(() => {
    void refreshManagedSessions().catch((cause) => {
      setManagedError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [refreshManagedSessions]);

  useEffect(() => {
    if (focusedTerminal === null) return;
    const handleFocusedTerminalKey = (event: KeyboardEvent) => {
      const toggleFocus = event.altKey
        && event.shiftKey
        && !event.ctrlKey
        && !event.metaKey
        && event.key === "Enter";
      if (toggleFocus) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) {
          setFocusedTerminal((current) => current === null
            ? null
            : { ...current, mode: current.mode === "focus" ? "presentation" : "focus" });
        }
        return;
      }
      const closePresentation = focusedTerminal.mode === "presentation"
        && !event.altKey
        && !event.ctrlKey
        && !event.metaKey
        && !event.shiftKey
        && event.key === "Escape";
      if (closePresentation) {
        event.preventDefault();
        event.stopPropagation();
        setFocusedTerminal(null);
      }
    };
    window.addEventListener("keydown", handleFocusedTerminalKey, true);
    return () => window.removeEventListener("keydown", handleFocusedTerminalKey, true);
  }, [focusedTerminal]);

  const toggleFocusedTerminalMode = useCallback(() => {
    setFocusedTerminal((current) => current === null
      ? null
      : { ...current, mode: current.mode === "focus" ? "presentation" : "focus" });
  }, []);

  const displayMachines = useMemo(() => machines.map((machine) => machine.id === "local-agentctl"
    ? {
        ...machine,
        sessions: managedSessions
          .filter((session) => session.runtime_state === "running")
          .map(managedSessionProfile),
      }
    : machine), [machines, managedSessions]);
  const activeMachine = displayMachines.find((machine) => machine.id === activeMachineId) ?? displayMachines[0];
  const activeSession = activeSessionId === null
    ? null
    : activeMachine.sessions.find((session) => session.id === activeSessionId) ?? null;
  const isLocalAgentctl = activeMachine.id === "local-agentctl";
  const pausedCount = managedSessions.filter((session) => session.runtime_state !== "running").length;

  useEffect(() => {
    if (activeSessionId !== null && activeSession === null) {
      setActiveSessionId(null);
      setFocusedTerminal(null);
    }
  }, [activeSession, activeSessionId]);

  const updateMachines = (nextMachines: MachineProfile[], nextActiveId: string) => {
    setMachines(nextMachines);
    saveMachines(nextMachines);
    setActiveMachineId(nextActiveId);
    setActiveSessionId(null);
    setFocusedTerminal(null);
  };

  const selectMachine = (id: string) => {
    setActiveMachineId(id);
    setActiveSessionId(null);
    setFocusedTerminal(null);
    setMachineManagerOpen(false);
  };

  const openManagedSession = (id: string) => {
    setActiveMachineId("local-agentctl");
    setFocusedTerminal(null);
    setActiveSessionId(id);
  };

  const pauseFromDashboard = async (id: string) => {
    try {
      await pauseManagedSession(id);
      await refreshManagedSessions();
    } catch (cause) {
      setManagedError(cause instanceof Error ? cause.message : String(cause));
      setSessionManagerOpen(true);
    }
  };

  return (
    <main>
      <nav className="machine-tabs" aria-label="Machines">
        {displayMachines.map((machine) => (
          <button
            aria-pressed={machine.id === activeMachineId}
            className={machine.id === activeMachineId ? "machine-tab active" : "machine-tab"}
            key={machine.id}
            onClick={() => selectMachine(machine.id)}
            type="button"
          >
            <span className="connection-dot" />
            {machine.name}
          </button>
        ))}
        <button className="machine-tab machine-tab--manage" onClick={() => setMachineManagerOpen(true)} type="button">
          Connected machines
        </button>
      </nav>

      {activeSession === null && (
        <>
          <header className="app-header">
            <div>
              <p className="eyebrow">SESSION MONITOR</p>
              <h1>{activeMachine.name}</h1>
              <p>One main agent harness terminal per isolated container workspace.</p>
            </div>
            <div className="header-actions">
              {isLocalAgentctl && (
                <button onClick={() => setSessionManagerOpen(true)} type="button">Agent sessions</button>
              )}
              <button className="secondary" onClick={() => setMachineManagerOpen(true)} type="button">Manage machines</button>
            </div>
          </header>
          <section className="status-strip">
            <strong>{activeMachine.sessions.length} running container session{activeMachine.sessions.length === 1 ? "" : "s"}</strong>
            {isLocalAgentctl && <span>{pausedCount} paused · durable and available from Agent sessions</span>}
            <span>Running sessions stay connected while you move between views.</span>
          </section>
          {managedError && isLocalAgentctl && <div className="app-error">{managedError}</div>}
        </>
      )}

      {focusedTerminal !== null && (
        <button
          aria-label="Close terminal presentation"
          className="terminal-focus-backdrop"
          onClick={() => setFocusedTerminal(null)}
          type="button"
        />
      )}

      {activeMachine.sessions.length === 0 ? (
        <section className="empty-state">
          <h2>No running container sessions</h2>
          <p>{isLocalAgentctl
            ? "Start a new agent or resume a paused session."
            : "Add a session endpoint under Connected machines."}</p>
          {isLocalAgentctl && (
            <button onClick={() => setSessionManagerOpen(true)} type="button">Start or resume an agent</button>
          )}
        </section>
      ) : (
        <section className="terminal-grid persistent-session-grid">
          {activeMachine.sessions.map((session) => (
            <SessionRuntime
              key={session.id}
              mode={activeSessionId === null ? "monitor" : activeSessionId === session.id ? "workspace" : "hidden"}
              focusedTerminal={focusedTerminal}
              onBack={() => {
                setFocusedTerminal(null);
                setActiveSessionId(null);
              }}
              onCloseTerminal={() => setFocusedTerminal(null)}
              onFocusTerminal={(key, inputMode) => setFocusedTerminal({ key, mode: inputMode })}
              onToggleTerminalMode={toggleFocusedTerminalMode}
              onOpen={() => {
                setFocusedTerminal(null);
                setActiveSessionId(session.id);
              }}
              onPause={isLocalAgentctl ? () => void pauseFromDashboard(session.id) : undefined}
              session={session}
            />
          ))}
        </section>
      )}

      {machineManagerOpen && (
        <MachineManager
          machines={machines}
          activeMachineId={activeMachineId}
          onClose={() => setMachineManagerOpen(false)}
          onSelect={selectMachine}
          onUpdate={updateMachines}
        />
      )}
      {sessionManagerOpen && (
        <ManagedSessions
          sessions={managedSessions}
          onChanged={refreshManagedSessions}
          onClose={() => setSessionManagerOpen(false)}
          onOpen={openManagedSession}
        />
      )}
    </main>
  );
}
