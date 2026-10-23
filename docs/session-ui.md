# Session UI: how the web shows and drives an omp session

The session page needs the live chat: replies as they stream, thinking, tool
runs, a prompt box, and answers to the agent's questions. This file records the
options tried, what each one showed, and why the current choice was made.

## History

| When | Option | Outcome |
|---|---|---|
| 2026-10-17 | omp's TUI in Tern, opened in the browser | Rejected for the chat area: a whole terminal for one chat; we chose our own lean wrapper over omp plus a way to open the real Tern session. |
| 2026-10-17 – 18 | Own chat over the omp extension (`server/chat.ts`, `app/ChatPanel.tsx`) | Worked, but every omp feature (markdown, tool cards, ask dialogs, subagents) had to be rebuilt by hand. Replaced. |
| 2026-10-18 | omp's `collab-web`, vendored in `collab/`, joined through the gateway's relay | Works end to end (AGENT-3/4/5 pass). ~14k vendored lines plus a 135-line relay that re-implements omp's relay protocol; no code highlighting; must be re-vendored with every omp upgrade. |
| 2026-10-18 | Tern's ACP chat on omp (`tern acp`), shown by Tern's web client | Spike below; seen in the workspace page and adopted the same day. collab-web removed. |

The 2026-10-17 rejection was about omp's terminal UI in a terminal grid. Tern's
ACP chat is a different thing: a chat interface Tern draws itself, with omp
running headless behind it. Its existence came up only on 2026-10-18.

## How omp and Tern relate

- Tern's default agent is omp (`DEFAULT_AGENT = "omp"` in Tern 0.9.2); Tern installs and
  version-checks omp and handles omp-specific ACP notices.
- omp knows Tern: inside a Tern pane (`TERN_PANE`, `TERN_PANE_SOCKET`) its browser tool
  opens Tern picture-in-picture views and `/fork` forks into a Tern pane.
- omp speaks ACP (`omp acp`, `src/modes/acp`, ~4.2k lines). Tern's ACP chat
  (`tern acp <agent> [--resume ID | --fork ID | --continue | --sessions] [--model M] [--mode M] [--prompt T]`)
  is a full client: elicitation forms, permission requests, plans, session
  load/resume/fork, steering, terminals.
- With Tern's `agents.auto_acp` on, typing an agent CLI in a Tern shell opens it as an ACP chat.

## Spike: Tern ACP chat (2026-10-18, Tern 0.9.2, omp 18.11.3)

Setup: one workspace container from the current image, a demo repository, the
host's omp credentials, a real model (Claude Opus 5.5).

| Check | Result |
|---|---|
| Start | `tern acp omp` fails ("no agent named omp"); omp is registered as a custom agent in the container's `~/.config/tern/settings.json`: `{"agents":{"custom":[{"id":"am-omp","name":"omp","command":"omp","args":["acp","--auto-approve"]}]}}`, then `tern acp am-omp`. |
| Rendering | Syntax-highlighted code blocks with Copy, bash cards with command, output and duration, headings, lists, inline code, collapsed "Thought", context bar and cost. |
| Ask tool | Arrives as a form (options, free text, Decline/Cancel/Submit); the answer reaches omp ("User selected: Yes") and the turn continues. |
| Approvals | Under ACP omp asks before every tool call (its tool context lacks settings and fails closed to `always-ask`). `omp acp --auto-approve` restores the TUI's `yolo` default. Decision: auto-approve. |
| Turn light | `container/omp-extension.ts` loads under ACP: `state` reports `blocked` while a question is open; `working`/`done` are pushed as before. |
| Resume | `tern acp am-omp --resume <session id>` restores the whole conversation. The id is the UUID in the session file name; the pane's cwd must match the session's. |
| Tests | `tern send <session>/@focused text …` + `keys Enter` prompts the chat; the session file records prompt and reply. `tern capture --surfaces` does not show ACP chat content. |
| Browser | Tern's web client shows the chat and takes typed prompts (a click on the composer moves focus to its hidden textarea). It draws with WebGPU; see "Testing in a browser" for what headless browsers do with it. |
| Web client wiring | Page `/`, script `/pkg/stencil_tern_web.js` (root-absolute paths: needs its own host, not a path prefix), socket `/wire?token=…` (a proxy can inject the token server-side). No X-Frame-Options or CSP, so it can be framed. |
| Assets | The built-in client fetches its WASM from `https://build.stencil.so/web/tern/<version>/stencil_tern_web_bg.wasm`. `tern web serve --assets DIR` serves `index.html` and `pkg/` locally instead. Decision: serve locally. |
| Quirk | One bash card showed the command's output twice (not investigated). |

Visual checks used Tern's headless client inside the container: `tern serve --control SOCK --out DIR`
with Mesa's software Vulkan (`mesa-vulkan-drivers`), driven by `tern ctl` (`run`, `type`, `key`,
`click X Y`, `tree`, `shot NAME`). `tern help dev` lists the commands.

## Adopted (2026-10-18)

- Container: the `workspace` Tern session runs `tern acp am-omp [--model M] [--resume ID]`;
  `run/launch.json` carries `model` and `resume` (an omp chat id) instead of omp arguments.
  Tern's settings also set the dark theme. The image build stores the web client from its own
  tern (`container/tern-web-assets.ts`), and `tern web serve --assets` serves it.
- `am-omp` runs `container/acp-filter.ts`, which runs `omp acp --auto-approve` and passes its
  messages through. Tern (0.9.2 and 0.9.4) builds a file tree for a glob result from
  `rawOutput.details.files` and from the result's text (omp's `# folder/` heading listing). When
  one file name appears in two folders, the tree fails (`stencil_acpchat: rendering the chat
  failed … files: duplicate child key "index.ts"` in `tern-acp.log`) and the chat draws nothing
  after that tool call, live or on resume. Seen first on `index.astro` and `index.ts` in
  DraftCoach. Dropping only `files` still failed; the filter drops `files` and sends the text as
  full paths, one per line, keeping omp's notes (result limit). Tern then draws a correct tree.
- A grep result failed the same way on a resumed session (jogi: a grep over a long EUR-Lex HTML
  page, `duplicate child key "*7889| <p class=…"`, a match line). Dropping `files`,
  `fileMatches`, `displayContent` and even `rawOutput.content` did not help, and a fixture with
  similar long HTML lines did not reproduce it, so the rule Tern keys by is unknown. The filter
  sends grep calls (kind `search` with a `pattern` input) as kind `other`; Tern then draws the
  result as text, and jogi's session loads with no failures.
- Reported as stencil-hq/tern-sdk#99; remove the filter once Tern draws such results (AGENT-6
  covers the glob case).
- The web client reads its settings from the page's `localStorage["settings.json"]`, not the
  container's settings file, and each chat host's origin (`am-t-<id>`) starts light. The stored page
  seeds `{"theme":"Dark"}` when the key is unset, so a theme picked in Tern still wins.
- Load time (headless, software WebGPU), ~2.3 s to a synced chat before: each proxied request
  ran `podman port`/`podman inspect` (~250 ms each; the gateway now caches the upstream and drops
  it on a proxy error), and the 60 MB wasm was fetched every load (`tern web serve` marks it
  `no-cache` without a validator). The stored page names the script and wasm with a content hash
  (`?v=`), and the gateway marks those immutable. Wasm compile is ~80 ms; ~0.8 s is Tern's
  window start.
- A web client that connects within ~2 s of the previous one leaving (a reload) took ~11 s to
  sync instead of ~2; at ≥2.8 s it was fast. The gateway holds a session's next `/wire` until
  3 s after its last one closed.
- Gateway: `server/tern-proxy.ts` serves a session's chat host, `am-t-<id>.<zone>`
  (`shared/hosts.ts`), from the container's published port. It adds the token and the accepted
  origin on `/wire` and `/fonts`, and refuses both to other origins.
- Fonts: the client asks `tern web serve` for fonts covering characters its built-in faces lack
  (`/fonts?chars=HEX,…` → `{"fonts":[{id,index}]}`, then `/fonts/<id>`). The server needs
  `?token=` there too and draws on the container's system fonts, which the image installs.
- Measured in Windows Chrome (real GPU, 125 % scale): a session opens in ~1 s (1.7 s cold, 2.5 s
  when its container restarts), a key reaches the composer in ~15–20 ms, also with a 368-message
  chat or a command streaming output. The iframe does not blur text; hidden frames draw nothing.
- Session page: `app/SessionFrames.tsx` frames that host. The last four sessions' clients stay
  loaded (hidden), so switching back is instant; frames keep their DOM order, since moving an
  iframe reloads it.
- Removed: `collab/`, `server/collab-relay.ts`, the collab link route, the omp/collab version
  guard, and the `@oh-my-pi/pi-wire`, `katex` and `lucide-react` dependencies.
- The daemon socket lives in the run directory (`TERN_DAEMON_SOCKET=/run/agentmonitor/tern-daemon.sock`),
  so the host user's `tern` can reach a container's daemon too. The daemon saves its sessions beside
  the socket (`tern-daemon.sock.state`), so that state outlives the container; restoring it made the next
  start's `tern new session workspace` fail ("a session is already called `workspace`"). The entrypoint
  deletes it on each start.
- Resume under ACP fails when the session's saved model is gone (omp 18.11: "Could not restore model
  <provider/id>"; the TUI only warned and switched). Three sessions on retired `openai-codex` models
  were switched to `anthropic/claude-opus-5-5` by appending a `model_change` entry before resuming.
- Every `omp acp` process loads the extension and takes over `run/omp.sock`. A second omp in the
  container (e.g. a debugging `omp acp`) leaves the card's turn light `stopped` once it exits.
- Tern's chat command `/new` ("Start a new session") starts a new omp chat in the same pane and
  process; omp writes a new transcript in the same omp home, so the session's card follows it
  (SESSION-7).
- A stopped container is started again on the newest chat (`--resume`, no `--model`, so the chat
  keeps the model it last ran; a retired model still fails as above).

## Testing in a browser

Findings from making AGENT-1/3/4/5 run against the real web client (Playwright's Chromium, no GPU):

| Setup | Result |
|---|---|
| Headless, SwiftShader WebGPU (`--use-webgpu-adapter=swiftshader`, with or without Vulkan SwiftShader) | The device is lost right after mounting ("A valid external Instance reference no longer exists"), the client panics, nothing takes input. |
| Headed (WSLg), Vulkan SwiftShader | Works, but opens windows on the desktop. |
| Headless shell, Vulkan on Mesa's llvmpipe (`--enable-unsafe-webgpu --ignore-gpu-blocklist --enable-features=Vulkan,VulkanFromANGLE --use-vulkan=native --use-angle=vulkan`) | Works: no device loss, typed prompts reach omp. Used by the tests. |
| New headless (`channel: "chromium"`) on the same flags | The composer never appears. |

The client mirrors what it draws into an accessibility tree (roles and labels: `textbox` "Message",
`group` "Model: Scripted · click to switch", `dialog` with `option`s and a "Submit" group,
`button`s "Thought", "Bash, running", "Bash, done"). Tern builds that tree when the page loads.
Headless, it follows later changes late, and not at all while the composer has focus, so each
look in a test is a fresh page. Close the previous page first: a page synced in ~2 s when no other
client was on the session, ~15 s when one was. The gateway's 3 s reconnect hold applies to each
fresh look too.

Only the composer's box matches where it is drawn, so tests click there to type. Transcript boxes do
not (one "Thought" button sat at y = −2147), dialog boxes move between loads, and DOM clicks on
mirrored elements do nothing. The question form could not be answered from the test browser:
clicks on its options and on Submit missed (one cancelled the question), and keys reached neither
from the browser nor through `tern send` (only Escape, which cancels). AGENT-5 therefore claims
the question shows in the web UI; answering it is Tern's own feature.

Collapsed content is not in the tree: the thinking text and a command's output. AGENT-4 checks the
"Thought" and "Bash, running" controls, not their text. Screenshots of the canvas come out blank.
Under ACP omp ends each tool result with a "Wall time" line, so the fake model quotes a result's
first line.

`tern serve` (the headless client behind `tern ctl`) runs its own in-process session and does not
attach to a daemon's sessions, so it cannot look at a workspace's chat.
