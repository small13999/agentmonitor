# Plan

The roadmap and the decisions behind it. SPEC.md holds the claims; this file holds
the order of work and what is decided but not yet written as claims. Update it when
a step finishes or a decision changes.

## Goal

Agent Monitor is the one website (login, nothing to install) where the user and a
remote teammate run coding agents on their projects: a board of tasks, per-task
pages with files and comments, previews of each task's work, and automations.
Draftcoach is the first real project; Agent Monitor itself is the second, developed
through Agent Monitor (dogfooding).

## Order of work

| # | Step | State |
|---|------|-------|
| 1 | Tasks: Topic → Task → Session, board, task workspace, snapshots, `am check` | Done (`7ae8314`..`2f84742`) |
| 2 | Bootstrap: host sessions, "+ Project", agentmonitor project; the user's PC is the hub | Done: HOST-1..5, UI-3; project `agentmonitor` on the dev server allows host sessions |
| 3 | SPEC draft for steps 4–8 (claims below), reviewed by the user | Next |
| 4 | Redesign from a clean slate: task page, comments, attachments (folder), people and assignee, board, session Settings tab, topic reader, visual identity; done through Agent Monitor itself | |
| 5 | Hub on Hetzner: Cloudflare Tunnel + Access, login, teammate access, flat hosts | |
| 6 | Preview tab per task (and the draftcoach preview login) | |
| 7 | Automations | |
| 8 | Runners (Hetzner, the user's PC when on), idle auto-stop with WIP push | |

## Decided, not yet claims

### Pages and folders
- A task and an automation are peers. Each has a **page** (description or
  instructions, topics, comments, outputs, history, its sessions) and a **folder**
  (its storage: attachments, outputs, an automation's memory).
- "Agent workspace" keeps meaning a session's worktree and container (or host
  worktree). A session's agent workspace gets its owner's folder.
- Every session belongs to one task or one automation. No orphan sessions.
- Folders live in the store, not in git; files show inline (images, video, PDF,
  Markdown, text), download singly or as a zip, and show who added them and when.

### Tasks and the board (redesign, step 4)
- Board shows active work only: Open, In progress, In review. Done and cancelled
  disappear from it and are found by search or an "All tasks" list.
- A card shows: name, topic names, assignee, session status and the machine it runs
  on. No messages, no git.
- Clicking a card opens the task page, the primary place of a task: description
  (editable), state, assignee, topics, attachments (drag and drop), comments from
  people and agents, history; "Start session" / "Open session" leads to the chat.
- Notes are removed; description and comments replace them. Existing notes migrate
  into a comment. The agent's context becomes title, description, status, comments.
- Settings is a full tab (same icon and place), with subtabs for session things:
  changes, previews, Cloudflare, end session. Task fields live on the task page.
- Topics show as names only everywhere; clicking a name opens a readable panel with
  the full rendered text and linked work.
- Visual identity from a clean slate: type with character, a distinct accent, a
  colour per topic, avatars for people and agents, live status (pulse while
  working, a clear "needs you"). Show a clickable prototype before building it in.
- People: the user and the teammate as named users; the assignee is a person.

### Automations (step 7)
- An automation has a name, triggers, instructions, a model, an end mode, a folder
  (one, shared by all runs; also its memory), and an on/off switch.
- A trigger is a schedule plus an optional code guard plus an optional agent check
  (cheap model): code only, agent only, code then agent, or a plain schedule. Several
  triggers per automation. Guard code and check prompt live in the folder and are
  written with an agent's help from the automation page.
- Each run is a session of the automation, not a task. It works on its own branch
  from the default branch (`am/<automation>-<run>`).
- End modes: **Finish** (default: produce outputs into the folder, do not deploy,
  end the session) or **Wait for review** (session stays open; the run shows as
  waiting on the user).
- Follow-up: continue the run's session, or start a manual session on the
  automation, optionally "from run X" (its branch and outputs).
- "Make a task from this run": the new task takes over the run's branch and links
  its outputs.
- The automation page centres on what it produced (previews, pages, artifacts) and
  what waits for review; the run list is secondary.
- No Discord; the teammate uses the site. Posting to Instagram comes later as an
  after-approval step.

### Host sessions (built in step 2: HOST-1..5, UI-3)
Still open:
- Switching host sessions on or off for an existing project in the UI (API only:
  `PATCH /projects/:id`); belongs in the project settings of the redesign.
- Host sessions of automations, once automations exist.
- Integrator: a checkout session (HOST-6) works in the main checkout and can go on
  with a terminal omp chat (HOST-7). Still open: how it pulls in other sessions'
  branches, and resuming chats in worktree or container sessions.
- Unix socket paths are limited to 108 bytes; a long state dir breaks every
  session (`<state>/sessions/<uuid>/run/am.sock`, and for host sessions
  `run/tern-daemon.sock`).

### Draftcoach preview login (step 6)
- Prod cookie `__Host-draftcoach_session` is host-only; the API accepts only
  `https://draftcoach.gg` as Origin; the auth worker adds `x-draftcoach-auth-proxy`.
- The hub forwards `/api/auth/*` on preview hosts to production, rewrites Origin
  only when it is the preview's own host, and strips the login cookie from requests
  to the container.

### Infrastructure (steps 5, 8)
- Hub on Hetzner plus runners (Hetzner, and the user's PC when on). Cloudflare
  Tunnel + Access (JWT); hosts `am.draftcoach.gg`, `am-p-<task>.draftcoach.gg`,
  `am-t-<session>.draftcoach.gg`. No Kubernetes, no Tailscale, no new domain.
  Commits under the user's identity.

## Backlog
- Per-turn snapshots (TURN-1); TRANSCRIPT claims.
- A failed turn (for example an expired model key) shows on the card as an error,
  not as "Turn done" with the previous reply.
- Brotli for the 60 MB Tern wasm; `RECONNECT_SETTLE_MS` retest; AGENT-4 timeout
  margin; stencil-hq/tern-sdk#99.
- Features of the old UI not yet back: agentctl list, mobile page, cmux terminals,
  memory view, port previews.
- Untested: the remote-cookie login form.
