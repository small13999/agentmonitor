# Agent Monitor

A browser-first control surface for agent terminals, isolated workspaces, and the services they host.

## Product contract

Terminals are the primary interface. Agent Monitor should make every active agent session visible and reachable from one page without making the user manage terminal windows, SSH tabs, container ports, or harness-specific UIs.

The design priorities are:

1. Correct and responsive terminal behavior.
2. Strong isolation between ordinary agent workspaces and host/operator access.
3. Existing, high-quality primitives over custom protocols or terminal implementations.
4. One local browser entry point for local and remote machines.
5. Low idle resource use and architecture that remains understandable.
6. Harness independence; OMP is the first integration, not the protocol boundary.

## Intended experience

- Switch between local and remote machines implementing the same machine contract.
- See one main terminal for every agent workspace in the monitor view.
- Open a workspace to see every cmux terminal the agent created inside it.
- Focus any terminal for normal interactive use without reconnecting or losing scrollback.
- Open exactly two bounded web-service slots per ordinary workspace.
- Add explicit host, root, and elevated/operator sessions without weakening ordinary workspace isolation.
- Eventually open an optional browser IDE and search harness-specific session history through pluggable integrations.

Normal workspace agents should only see their own container's cmux session. Elevated sessions may intentionally receive broader capabilities, but that must be an explicit security boundary rather than an accidental shared socket or container privilege.

## Current implementation

The local implementation now provides:

- Dynamic discovery of durable DraftCoach `agentctl` sessions.
- A session manager that creates titled sessions, resumes paused sessions, and
  keeps paused sessions out of the terminal dashboard.
- A guarded pause action. `agentctl` refuses an ordinary pause while cmux
  reports a working agent; force-pause is a separate explicit action.
- One private headless cmux daemon and one interactive Bash terminal that starts
  OMP automatically per running agentctl container.
- Durable worktrees, branches, OMP history, cmux layouts, service-port
  assignments, and monitor credentials across pause/resume and host reboots.
- A monitor view, all-terminal workspace view, and focused interactive terminal
  view.
- Exactly two hosted-service links per workspace:
  - **Port 1** forwards the session's allocated host port to container `4321`.
  - **Port 2** forwards the session's allocated host port to container `1420`.
- HTTP and WebSocket-compatible service routing through session-specific
  `.localhost` origins.
- GitHub CLI in the workspace image, authenticated from the host's existing
  `gh` configuration.

Remote machine discovery, SSH lifecycle management, gateway authentication/TLS,
elevated sessions, IDE launch, and harness history adapters remain future
direction.

## Architecture

```text
Browser
  └─ local Agent Monitor gateway
       ├─ agentctl lifecycle API → local agentctl CLI
       ├─ cmux WebSocket → each running workspace container
       ├─ port-1.<session>.localhost → allocated host port → container :4321
       └─ port-2.<session>.localhost → allocated host port → container :1420

agentctl workspace container
  ├─ private cmux daemon, state, WebSocket, and control socket
  ├─ OMP main terminal plus agent-created terminals
  ├─ durable worktree and session-local OMP state
  └─ exactly two bounded hosted-service ports
```

The target remote design keeps the browser on one local origin. A local gateway
owns SSH connections/tunnels to remote machine agents and presents the same
machine/workspace model to the UI.

## Decisions and invariants

### cmux is the terminal/session primitive

Agent Monitor consumes cmux's resource tree and attach streams rather than inventing a terminal multiplexer or harness protocol. Each ordinary container has a private daemon, so agents can create panes and workspaces without gaining visibility into other containers or the host.

### Session connections remain mounted

Changing monitor/workspace views hides terminal cards instead of disconnecting their cmux clients. This preserves terminal state and scrollback and avoids reconnect storms. Hidden terminals do not participate in browser-driven PTY sizing.

### Presentation and focus modes

Clicking a terminal opens presentation mode for quick interaction; unmodified
Escape closes that view. `Alt+Shift+Enter` toggles focus mode, where overlapping
terminal and OMP shortcuts—including Escape—pass through without changing the
Agent Monitor view. The terminal header shows the active mode and provides
explicit mode and close controls. Each visible workspace terminal also keeps
the session's Port 1 and Port 2 links available.

### The browser owns terminal sizing

The active browser calls cmux's exclusive client-sizing operation after reporting dimensions. Initial `vt-state` data initializes xterm and normal `output` events update it. Subsequent cmux `resized` snapshots are intentionally not replayed into xterm: they acknowledge a size this exclusive client already applied, and resetting from that replay causes a visible blank frame.

If sizing becomes multi-owner later, this event handling must be reconsidered rather than silently restoring replay resets.

### Terminal rendering must not regress to DOM resize flicker

The dense Workspace 1 TUI exposed two separate issues:

- At smaller layouts, monitor and workspace cards had the same width; there was no terminal resize bug.
- At `1920×1080`, the monitor had two wide cards while Workspace 1 had three narrower cards per row. The xterm DOM renderer visibly cleared/repainted while shrinking.
- A temporary cloned-DOM overlay hid blanks but introduced a delayed font-size jump. It was removed.

The current implementation therefore:

- Uses the official `@xterm/addon-webgl` renderer after `terminal.open()`.
- Disposes the addon on WebGL context loss, allowing xterm's normal fallback.
- Uses `FitAddon.proposeDimensions()` and public `Terminal.resize()` directly.
- Applies focus font options and fits synchronously in React `useLayoutEffect`, before the next paint.
- Uses `ResizeObserver` plus `requestAnimationFrame` for ordinary container geometry changes.
- Never uses cloned terminal DOM, CSS-scaled terminal snapshots, arbitrary settling timers, or renderer-private APIs.

Relevant upstream references:

- [xterm WebGL addon](https://github.com/xtermjs/xterm.js/blob/master/addons/addon-webgl/README.md)
- [xterm FitAddon](https://github.com/xtermjs/xterm.js/blob/master/addons/addon-fit/src/FitAddon.ts)

### Hosted services use isolated hostnames

Arbitrary agent-hosted applications must work without HTML rewriting and may use root-relative assets, redirects, cookies, and WebSockets. Each slot therefore gets its own hostname, for example:

```text
http://port-1.patch-notes.localhost:5173/
```

This also prevents an agent-hosted application from sharing the Agent Monitor browser origin or reading its storage. The gateway resolves only session IDs and ports returned by `agentctl list`; it is not an open proxy.

agentctl publishes the two service ports on allocated host-loopback ports. The
separate cmux WebSocket port is control-plane transport and does not consume a
hosted-service slot.

### Security boundaries stay explicit

Ordinary agent containers must not receive:

- the Podman socket;
- production credentials or another workspace's state;
- another workspace's cmux socket;
- implicit root/host access beyond the current agentctl container contract.

The current DraftCoach contract deliberately supplies the host's development
SSH configuration and GitHub CLI credentials so agents can fetch, push, inspect
issues, and open PRs. That is an explicit capability and should use
least-privilege credentials.

cmux listens on a host-loopback forwarded port with a random per-session token.
Remote or shared use additionally requires TLS at the gateway boundary,
authorization by machine/session capability, and an explicit elevated-session
policy.

## Terminal regression checklist

Any terminal renderer, sizing, grid, or cmux attach change must be exercised with a dense full-screen TUI, not only a shell prompt:

1. `1440×1000`: monitor → Workspace 1 → monitor, where the card width does not change.
2. `1920×1080`: monitor → Workspace 1 → monitor, where the main card changes between the two-card and three-card grid widths.
3. Focus Workspace 1 and close it again at both resolutions.
4. Confirm the terminal reaches final canvas geometry on the first painted focused/unfocused frame.
5. Confirm there is no cloned resize cover, delayed font jump, reconnect, lost scrollback, or hidden terminal changing PTY size.
6. Confirm focused keyboard input still reaches the intended surface.

## Development

```bash
npm install
npm run dev
npm run build
```

Build the current prototype workspace image with:

```bash
podman build -t localhost/agentmonitor-prototype:dev \
  -f prototype/Containerfile prototype
```
