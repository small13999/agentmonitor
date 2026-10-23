# Agent Monitor

A browser control surface for coding agents. Work is organized as tasks: each
task has a branch, a status, comments, and the sessions that worked on it; a session
is a worktree and a container (or, where the project allows it, host processes)
running omp, whose chat shows in Tern's web client.
The monitor tracks every task's state, its topics, changes and pull requests.
`SPEC.md` holds the contract and goals.

## Development

```bash
npm install
npm run dev
npm run build
node scripts/build-image.ts   # workspace image; needed by container tests
npm test
npm run spec:check
```

`SPEC.md` is the behavioral contract: numbered claims, each covered by a
`spec("ID", ...)` test. `spec:check` fails on drift between the claims, the
tests, and `spec.lock.json`; run `npm run spec:lock` after reviewing a change.

Tests drive a real gateway process (`tests/harness.ts`). Store claims run with
`AGENTMONITOR_WORKSPACE_RUNTIME=none` (records only); container claims share one
gateway and its session containers per test file and rebuild the image first
(cached by podman).
UI claims build the app into `dist/` and drive it in headless Chromium through
Playwright (`npx playwright install chromium-headless-shell` once). Tern's web
client draws with WebGPU, which Chromium runs on the machine's Vulkan driver
(Mesa's llvmpipe without a GPU, package `mesa-vulkan-drivers`).

## Web app

`app/` is the web app, served at `/` (`npm run dev`: http://127.0.0.1:5173/). A
header names Agent Monitor and its menus, Board and Tasks. Board (`#/`) shows the
project's tasks in columns by state (Open, In progress, In review, Done; Done
shows the 20 most recently finished), waiting-on-you first, then in creation
order; "+ New task" creates one without starting work. Tasks (`#/t`) lists the
open, in-progress, and in-review tasks (172 px wide, in creation order) beside
the workspace. `#/t/<id>` opens a task's workspace, a small browser with tabs.
Page (`#/t/<id>`, `app/TaskPage.tsx`) is the task's primary place: title,
description (Markdown), state, assignee, and topics, all edited in place; its
status, folder, comments, history, and sessions, and the running session's
state. The folder (`TaskFolder` in `app/Folder.tsx`) takes files dropped there
or chosen, shows each inline by kind, and downloads one or all as a zip.
People (the store's owner adds them, each with the email they log in with, and
renames them from the assignee's "People…") show as initials on their colour; an agent shows as its session's
agent on the session's avatar, linking to the session. Chat (`#/t/<id>/chat`)
is its running session's chat in Tern, or a Start session button. Settings
(`#/t/<id>/settings`, the gear at the right of the tabs) is for the session:
subtabs Changes (the branch's commits and files against the default branch,
uncommitted files, open pull requests, other running tasks that changed the
same files), Cloudflare writes, and End session. Other tabs hide the chat's
frame without unloading it, and a chat loads only once its Chat tab shows; the
Tasks page stays mounted (hidden) while the board shows, for the same reason.
`shared/api.ts` holds the wire types both sides use. Tasks, cards, topics,
comments, and history poll.

## Store, tasks, and sessions

A task is requested work: a title, a description, a state (`open`,
`in_progress`, `in_review`, `done`, `cancelled`), one branch, a status (≤ 50
lines, revisioned, kept by its agents), comments, an assignee, and topic links. A
session is one agent run on a task, with every omp chat started in it (Tern's
`/new` starts another in the same session); a task has at most one running
session. While a session runs it has a workspace: a worktree and a container, or
host processes for a host session (below). The
gateway owns one SQLite store (`<state dir>/store.sqlite`) with projects, topics,
tasks, task↔topic links, sessions, people, comments, and each task's history. A
store from before tasks is migrated on start: each session becomes a task with
its name, branch, topic links, and notes; notes became a comment by the store's
owner. `/api/store/*` serves it to the UI: `/projects/:id/tasks` (list, create),
`/tasks/:id` (detail, `PATCH` title, description, unfinished state, assignee),
`/tasks/:id/{status,topics/:topic,sessions,finish,comments,history,changes}`,
`/comments/:id` (`PATCH`, `DELETE`; its author only). The history lists the
pull requests GitHub has for the task's branch, by no one. Each running session
gets a Unix socket (`<state dir>/sessions/<id>/run/am.sock`) serving the same
routes with the agent's scope (its project only); the socket is the agent's
identity, so no token is issued. Inside the container, `am` (`container/am.ts`)
is the agent's client for it; `am check` lists what would not survive the
session (uncommitted files, unpushed commits, untracked files that look like
secrets) and fails until it is clean.

Every task has a folder, `<state dir>/folders/<task id>`: files outside git. The
store records who added each file and when (`folder_files`) and a `file` event in
the task's history; the directory is the truth, since agents write into it
directly, so every list (and the history) first brings the records in line with
it, crediting new files to the task's running session's agent. Routes:
`GET /tasks/:id/folder` (list), `GET|PUT|DELETE /tasks/:id/folder/<path>` (the
file inline with its content type, `?download` as an attachment, single byte
ranges; `PUT` streams the body in, past the JSON body limit), and
`GET /tasks/:id/folder.zip`. A container session has the folder at
`/task-folder`; a host session's agent uses the directory itself; the task
context names it. `am folder` lists, adds, gets, and deletes files.

Starting a task's first session in a project with a `repoPath` creates the
task's `am/<title>-<hex>` branch from `origin/HEAD` (or `HEAD` without an
origin); later sessions add their worktree on the same branch, taken from origin
when only origin has it. The container `am-<id>` runs
`localhost/agentmonitor-workspace:dev`
(`container/Containerfile`, built by `node scripts/build-image.ts [--base
IMAGE]` from the local `tern` and `omp` binaries). The entrypoint starts Tern's
daemon with one Tern session, `workspace`, whose block is Tern's chat on omp in the
worktree (`tern acp am-omp`; `am-omp` is a Tern agent entry for
`container/acp-filter.ts`, which runs `omp acp --auto-approve`; written to the
container's Tern settings). Tern 0.9.4 stops drawing a chat at some search
results (a glob listing one file name in two folders, some greps;
stencil-hq/tern-sdk#99), so the filter sends globs as full paths and greps as
plain tools. `run/launch.json`
carries the model and an omp chat id to resume. Then `tern web serve` runs
on the container's port 8377, published on a random loopback port, with the
web client the image build stored from this tern (`container/tern-web-assets.ts`
downloads the release's wasm and checks it against the page's sha384 pin, so
browsers load nothing from outside the gateway). Tern's daemon socket is
`run/tern-daemon.sock`; inside the container `tern` finds it through
`TERN_DAEMON_SOCKET`. The daemon saves its sessions next to it
(`tern-daemon.sock.state`); the entrypoint deletes that file on each start, so the
chat always comes from `launch.json`. The omp extension (`container/omp-extension.ts`) answers
the gateway's turn and system-prompt queries at `run/omp.sock`. The gateway
writes the task (title, description, status, comments) to `run/task.md` on every
container start, and the entrypoint appends it to the workflow context. The
container gets the worktree, the repository's `.git`, the run directory, the
session's omp home, and the omp agent directory's credentials and providers
(`agent.db`, `models.db`, `models.yml`); never podman.

When Tern's host is asked for a session whose container is not running (it
stopped, or the machine restarted), the gateway starts a new container on the
current image, resuming the session's newest chat, and waits until Tern answers.

### Host sessions

A project created with "Allow host sessions" (the project menu's "+ Project", or
`PATCH /api/store/projects/:id {hostSessions}`, humans only) can start a session
with `{runtime: "host"}`: the agent runs on the gateway's machine as the user, in
its own worktree, with the user's tools and credentials, and no container. It is
marked with a red "Host" badge. Agent Monitor is developed this way: containers
have no podman. `server/runtime/host.ts` writes the same run directory as the
container runtime and spawns `container/host-entry.ts`, which shares the session
start with the container entrypoint (`container/launch.ts`) but keeps everything
it writes in the session's directories: omp's agent dir is
`omp-home/agent` (`PI_CODING_AGENT_DIR`), Tern's settings `run/tern-config`
(`TERN_CONFIG_DIR`), and `am` is `run/bin/am`. The user's `~/.omp`,
`~/.config/tern`, `~/.ssh`, `~/.gitconfig` and gh login are never written. Tern's
web client listens on a free loopback port (`run/host.json`), its assets are
stored once per tern version in `<state dir>/tern-web/`, and the log is
`run/host.log`. The session's processes run without the gateway's
`AGENTMONITOR_*` and `npm_*` variables and carry `AGENTMONITOR_SESSION=<id>`;
ending or restarting the session SIGTERMs every process with it, then SIGKILLs
what remains after 5 s, including servers the agent started.

"Start in main checkout" (`{runtime: "host", checkout: true}`) starts a host
session in the project's main checkout instead of a worktree: the code the live
instance runs, so edits take effect at once. One per project, marked "Host ·
main". It creates no worktree or branch, and ending it only stops its processes:
no snapshot, the checkout and its uncommitted work stay. Its omp chats are your
own (the session's `omp-home/agent/sessions` links to the omp agent directory's
`sessions`): `/sessions` in its chat lists your terminal chats of the checkout to
go on with, and `omp` → `/resume` in a terminal lists its chats. Don't continue
one chat in both places at once.

`POST /api/store/sessions/:id/end` ends a session: it stops the container, keeps
the worktree's uncommitted changes (untracked files included, ignored ones not)
as a commit at `refs/agentmonitor/snapshots/<task id>` built through a scratch
index, then deletes the worktree and the run directory. The task's branch stays,
and so does the omp home (`sessions/<id>/omp-home`: every chat's transcript, the
newest one being the session's current chat). The snapshot ref is outside
branches and tags, so pushes leave it on the machine. The task's next session
applies the snapshot to its fresh worktree as uncommitted changes and drops the
ref; parts that conflict with a branch that moved since stay as merge markers,
and the snapshot moves to `…-unapplied-<time>` so nothing is lost. The response
lists the kept files. `POST /api/store/tasks/:id/finish` (`done` or
`cancelled`) ends the running session and deletes the task's branch here; with
commits no remote branch (nor the base branch) has, it answers 409 listing them
(`unpushed`) unless the body has `"confirm": true`.

`GET /api/store/projects/:id/cards` returns one card per running session,
blocked-on-you first: the turn light (`blocked` red, `working` orange, `done`
green, `stopped` when the extension does not answer), the last user message and
reply from the newest chat, uncommitted files and unpushed commits from the
worktree, open pull requests from `gh` (cached 30 s), and the other sessions
that changed the same files.

A task's Chat tab shows its session's chat in Tern's web client, framed from the
session's own host, `tern-<id>.localhost:<monitor port>`, since the client
loads everything from root paths. The gateway proxies that host to the
container's published port (`server/tern-proxy.ts`) and adds what `tern web
serve` asks for: the token from `run/tern-token` on `/wire` and `/fonts` and
the origin it accepts, so neither reaches the browser. It opens `/wire` and
`/fonts` only for pages on that Tern host. `/fonts` serves the image's fallback
fonts (Noto CJK, Noto core scripts, DejaVu) for characters the client's
built-in faces lack. `*.localhost` names resolve on the browser's own machine,
so this needs the monitor in local mode; WebGPU needs Chrome or Edge.

The app keeps the last four sessions' clients loaded and hidden, so going back
to one is instant. The image names the client's script and wasm by content
hash and the gateway marks them immutable; Chrome keeps the script but
refetches the 60 MB wasm (~0.2 s from the gateway) on every load, likely over
its cache's entry limit. The page seeds Tern's dark theme unless the user picked one. The
gateway holds a session's new `/wire` until 3 s after its last one closed: Tern
0.9.2 syncs a client that reconnects sooner (a reload) in ~11 s instead of ~2.

Opening a session whose container stopped says "Starting the session's
container…" until its chat loads.

Session containers get read-only copies of the user's `~/.ssh`, `~/.gitconfig`
and `~/.config/gh`, so agents commit as the user and push over ssh; the image
has `ssh` and `gh`.

A project's agents reach its Cloudflare account through the gateway
(`server/cloudflare.ts`), which keeps the tokens in
`~/.config/agentmonitor/cloudflare/<project name>.env`
(`CLOUDFLARE_READ_TOKEN`, optional `CLOUDFLARE_WRITE_TOKEN`). A container of such
a project gets `CLOUDFLARE_API_BASE_URL`, a loopback relay to its session
socket, so Wrangler works unchanged. Reads always pass; writes pass only while
the user allows them in the task's settings, 10 minutes at a time or until
revoked. Grants live in the gateway's memory: a restart revokes them. A token
file added later reaches a session when its container starts again.

`AGENTMONITOR_STATE_DIR` (default `~/.local/state/agentmonitor`),
`AGENTMONITOR_WORKSPACE_RUNTIME` (`podman` | `none`),
`AGENTMONITOR_WORKSPACE_MEMORY_MIB` (default 5120),
`AGENTMONITOR_OMP_AGENT_DIR` (default `~/.omp/agent`), `AGENTMONITOR_GH`
(default `gh`), `AGENTMONITOR_CREDENTIALS_HOME` (default `~`),
`AGENTMONITOR_CONFIG_DIR` (default `~/.config/agentmonitor`), and
`AGENTMONITOR_CLOUDFLARE_API` (default `https://api.cloudflare.com`) configure
this. Tests point them at a scripted fake model (`tests/fake-model.ts`), a fake
`gh`, fixture credentials, and a fake Cloudflare API.

## Gateway

`server/` holds the gateway shared by the Vite dev plugin (`npm run dev`, port
5173) and the standalone production server (`npm run build`, `npm run
gateway:build`, then `npm run gateway:start`; port `AGENTMONITOR_PORT`, default
4173, serving `dist/`). Besides each session's Tern host, both serve:

- `GET /api/health` (unauthenticated liveness: `{ machine, auth }`, `auth` the
  auth mode).
- `/api/store/*`, the store API above.

Every other request, the app's pages, the store API and Tern hosts alike, goes
through `Auth.identify` (`server/auth.ts`), which says which person it is or
refuses it. `AGENTMONITOR_AUTH_MODE=local` (the default) is the user's PC: every
request is the store's owner. `AGENTMONITOR_AUTH_MODE=access` is a hub behind a
Cloudflare Tunnel and Access: the gateway verifies the Access token itself
(the `Cf-Access-Jwt-Assertion` header, else the `CF_Authorization` cookie;
RS256 against the team's keys, issuer, audience, expiry) and acts as the person
with the token's email; other emails get a page saying they are no person of
the hub. It requires `AGENTMONITOR_ACCESS_TEAM_DOMAIN` (the issuer, e.g.
`https://draftcoach.cloudflareaccess.com`; keys at `/cdn-cgi/access/certs`),
`AGENTMONITOR_ACCESS_AUD` (the Access application's audience tag) and
`AGENTMONITOR_OWNER_EMAIL` (the owner's email, written to the store's owner on
start). On a hub every person works on every project; only the owner adds
people, allows and starts host sessions, and allows Cloudflare writes. Vite's
dev server runs without its HMR socket in access mode.
