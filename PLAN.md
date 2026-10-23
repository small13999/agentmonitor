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
| 2 | Bootstrap: host sessions, "+ Project", agentmonitor project in the store on the user's PC | Done: HOST-1..7, UI-3; the integrator runs as a main-checkout session of project `agentmonitor` |
| 3 | SPEC draft for steps 4–8, reviewed by the user; its Concepts section is agreed | Done: step 4 claims in SPEC.md (`c55171c`); steps 5–8 stay in `SPEC-DRAFT.md` until their step |
| 4 | Redesign from a clean slate: task page, comments, attachments (folder), people and assignee, board, session Settings tab, topic reader, visual identity; done through Agent Monitor itself | Done: slices merged (`cfb952a`), Studio (`5ff8e0e`, `4ffc0d2`); leftovers (project settings, `am` history/people/changes) in a step 5 slice |
| 5 | Hub on Hetzner for draftcoach: Cloudflare Tunnel + Access, login, teammate access, flat hosts; the user's local Agent Monitor lists the hub's projects | Done: AUTH-1..3, STORE-3/6, PREVIEW-2, CLOUDFLARE-3 (`5386015`); hub live at am.draftcoach.gg, draftcoach moved there, the PC lists it through `hubs.json`; a hub session answered end to end |
| 6 | Preview tab per task (and the draftcoach preview login), Deploy changes | |
| 7 | Automations | In progress: claims in SPEC.md (`e043ace`); foundation task, then scheduling, run behaviour, and the automation page in parallel; first automation: draftcoach Patch review |
| 8 | Agent commits every turn and Agent Monitor pushes the task branch (replaces snapshots), idle stop, "Run session locally" | |

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
  working, a clear "needs you"). Picked from three prototypes: Studio (Bricolage
  Grotesque, violet, compact and high signal), toned down: no offset 3D shadows, no
  tilted elements or stickers. Console was too intimidating for non-technical users,
  Paper too drawn out (half the tasks per screen). Built in `app/app.css`: fonts
  self-hosted from npm (fontsource: Bricolage Grotesque, DM Mono for ids and files),
  light and dark follow the system, violet for selection and actions, yellow only for
  "waiting on you", pills for topics, states, tabs, and buttons.
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
- Phase 1 (foundation) built: the store model (automations, triggers, firings, runs as
  sessions of an automation with `taskId` null), the automation's folder on the task
  folder's code, the routes and `am automation`, "run now", and moves. Decided there: a
  run's branch is `am/<slug>-<first 8 hex of its session id>`; one run of an automation
  at a time, and none while it is off (409); a firing records each trigger's scheduled
  time once; a run's uncommitted work at its end is kept as a snapshot under its
  session's id; only people delete automations.
- Phase 2, run behaviour built (AUTO-10..14). Decided there:
  - A run's first prompt (server/store/runs.ts): what started it (the trigger
    context), memory.md (first 32 KiB, because the prompt is one argv argument),
    where outputs go (`runs/<run>/`), and the instructions, last. Its context says
    how the run ends for its end mode.
  - The agent ends its run with `am run end finished|nothing_to_deploy|review|failed
    [--why]`. The gateway refuses an outcome the run's work does not show:
    - finished: the branch is merged into the default branch, or GitHub has a merged
      PR from it.
    - nothing_to_deploy: no commits beyond the default branch.
    - review: the branch is pushed.
    - No outcome is accepted while files are uncommitted.
  - Wait for review allows finished only after review. Every outcome except review
    ends the session once the agent's turn ends. nothing_to_deploy deletes the branch
    locally and on origin.
  - A run waiting for review counts as waiting on everyone: its card is blocked while
    its agent is idle, and it appears in the header's count, linking to its chat.
  - Time limit: a sweep every minute, whenever the clock jumps, and at gateway start,
    so it survives restarts. Runs waiting for review are exempt. A timed-out run keeps
    its work as a snapshot.
  - Sessions on an automation that are not runs (`is_run` 0) are started only by
    people. "From run X" requires the run to have ended (409 while it runs), and
    reuses its branch and its snapshot.
  - Task from a run: the task takes the run's branch and snapshot. The run's outputs
    are copied (not linked) into the task's folder under the same `runs/<run>/`. A
    running run is ended first; only a person can do that.

### Host sessions (built in step 2: HOST-1..7, UI-3)
Still open:
- Host runs of automations: "run now" by the owner with `runtime: "host"` works in
  projects that allow host sessions (HOST-1); whether a trigger may start host runs is
  open (the store refuses host runs nobody started).
- Integrator: a checkout session (HOST-6) works in the main checkout among the
  user's omp chats (HOST-7). Still open: how it pulls in other sessions' branches,
  and resuming chats in worktree or container sessions.
- Unix socket paths are limited to 108 bytes; a long state dir breaks every
  session (`<state>/sessions/<uuid>/run/tern-daemon.sock` and the others). The
  hub works around it with `AGENTMONITOR_STATE_DIR=/home/agentmonitor/am`, a
  symlink to `~/.local/state/agentmonitor`; the gateway should refuse or shorten
  such paths itself.

### Draftcoach preview login (step 6)
- Prod cookie `__Host-draftcoach_session` is host-only; the API accepts only
  `https://draftcoach.gg` as Origin; the auth worker adds `x-draftcoach-auth-proxy`.
- The hub forwards `/api/auth/*` on preview hosts to production, rewrites Origin
  only when it is the preview's own host, and strips the login cookie from requests
  to the container.

### Infrastructure (steps 5, 8)
- Stores, hub, clients, machines, local runs, and the commit model: see the
  Concepts section of `SPEC-DRAFT.md` (moves into SPEC.md).
- Hub on Hetzner, live since step 5: user `agentmonitor` on the draftcoach box,
  `~/projects/agentmonitor` (deploy: `git pull`, `npm ci`, `npm run build`,
  `npm run gateway:build`, `node scripts/build-image.ts` when `container/` changed,
  `systemctl --user restart agentmonitor`), env in `~/.config/agentmonitor/hub.env`,
  port 8470. Cloudflare: tunnel `draftcoach-admin` routes `am` and `*.draftcoach.gg`
  to it, both requiring the Access app "Agent Monitor hub" (`am`, `am-*`). Hosts
  `am.draftcoach.gg`, `am-t-<session>…`, `am-p-<task>…`. Commits under the user's
  identity; the hub's own GitHub key, the user's gh token, its own omp login.
- The user's PC is not a persistent runner (it is off too often); it runs hub
  sessions only when the user asks for a local run.

### Chat: our own UI on `omp acp`, replacing Tern (decided, not scheduled)
- omp is what matters (the harness); Tern is only used as the chat, and its
  terminal, file blocks, and built-in features are not wanted.
- Tern costs us: an extra layer of nesting, waiting on upstream fixes, harder
  integration with our own pages, a font we cannot change (the web client draws on
  a canvas with fonts built into its wasm).
- Plan: the app draws the chat itself from `omp acp` (transcript, streaming,
  tools, questions, subagents, `/sessions`), the way the user's chat wrapper for
  kiro cli at work does. AGENT-1..7 move from Tern to it.
- Until then: never open a Markdown file in Tern's web client. It panics the wasm
  and freezes the whole chat, again on every reload, until the file block is
  closed (`tern close <block>` with the session's `TERN_DAEMON_SOCKET` and
  `TERN_CONFIG_DIR`). Upstream: stencil-hq/tern-sdk#78, open in 0.9.4 and 0.9.5.

## Backlog
- Per-turn snapshots (TURN-1); TRANSCRIPT claims.
- A failed turn (for example an expired model key) shows on the card as an error,
  not as "Turn done" with the previous reply.
- Brotli for the 60 MB Tern wasm; `RECONNECT_SETTLE_MS` retest;
  stencil-hq/tern-sdk#99.
- `cloudflared access login` from WSL opens no browser and its link expires after
  about 9 minutes; the client could open the link itself (the user's Windows
  browser) when a hub needs a login.
- Features of the old UI not yet back: agentctl list, mobile page, cmux terminals,
  memory view, port previews.
