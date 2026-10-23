# Shared content for all three directions

Every direction shows exactly this content. Same data, different identity. "Today" is
Thu Oct 23 2026. The viewer is Armin (the store's owner).

## People
- **Armin** — owner, initials `A`, colour `#3b5bdb` (directions may retune the hue but keep him blue-ish)
- **Lena Hofmann** — teammate, initials `LH`, colour `#e8590c` (orange-ish)
People avatars: initials on their colour, always the same shape (person shape).

## Agents
An agent is "the agent of session <short id>", shown with the session's avatar: a shape
clearly different from people (e.g. hexagon / square / rounded square with a small bot or
spark glyph) plus the 4-char session id, coloured per session. Agent actions link to the session
(the Chat tab, `chat.html`).
Sessions used: `7f3a` (Patch 25.21 task), `b21e`, `c4d0`, `91aa`, `e7f2`, `5d03`, `a8c1`, `0b6e`.

## Session states (CARD-1)
- **waiting on you** — the loudest thing on the page; the "needs you" state
- **working** — pulses (animated, CSS only; respect `prefers-reduced-motion`)
- **idle** — quiet
- **stopped** — container stopped, muted
- no session — card shows nothing or "no session"
Machine label next to state: `armin-pc · container`, `armin-pc · host`, `hub · hetzner`.

## Projects
- **draftcoach** — League of Legends draft coach: Riot data pipeline (Rust API on Hetzner), Astro website with champion/patch pages, Tauri desktop app.
- **agentmonitor** — this app.
Header has a project switcher (draftcoach selected on draftcoach pages, agentmonitor on its board).

## Topics (UI-4: name in the topic's own colour, everywhere; click → topic panel)
draftcoach:
- **Patch notes** `#e03131`
- **Riot pipeline** `#1971c2`
- **Desktop app** `#9c36b5`
- **Pro archives** `#f08c00`
- **Auth & login** `#2f9e44`
agentmonitor:
- **Redesign** `#d6336c`
- **Host sessions** `#1098ad`
- **Hub** `#e67700`
- **Automations** `#5f3dc4`
Directions may retune these hexes so they read well on their dark AND light backgrounds, but
each topic keeps its distinct hue.

## Board: draftcoach (index.html)
Columns Open / In progress / In review. "Waiting on you" cards sort first in their column (BOARD-2).
Card = title, topic names, assignee avatar, session state + machine. No messages, no git.
Cards that touch files another running task also changes get a small "overlap" mark (CARD-4).

Open
1. **Patch notes: automate Data Dragon diff** — Patch notes · unassigned · no session
2. **Champion page: runes by elo bracket** — Riot pipeline · Lena · no session
3. **Desktop app: beta update channel** — Desktop app · unassigned · no session
4. **Pro archives: add LCK Cup 2026** — Pro archives · Armin · stopped · armin-pc · container (session `0b6e`)

In progress
5. **Patch 25.21 notes page** — Patch notes, Riot pipeline · Armin · **waiting on you** · armin-pc · container (`7f3a`) · overlap mark  ← the rich task, `task.html`
6. **Login with Riot account (RSO)** — Auth & login · Lena · **waiting on you** · hub · hetzner (`b21e`)
7. **Rank enrichment: retry on 429** — Riot pipeline · Lena · working · hub · hetzner (`c4d0`)
8. **Draft overlay: ban-phase suggestions** — Desktop app, Riot pipeline · Armin · working · armin-pc · host (`91aa`) · overlap mark

In review
9. **Download page: SmartScreen note** — Desktop app · Armin · idle · armin-pc · container (`e7f2`)
10. **Snapshot publish: R2 cache headers** — Riot pipeline · Lena · no session

## Board: agentmonitor (board-agentmonitor.html)
Open
- **Automations: schedule trigger** — Automations · unassigned · no session
- **Hub on Hetzner: Cloudflare Tunnel** — Hub · Armin · no session
In progress
- **Board, search and topics** — Redesign · Armin · **waiting on you** · armin-pc · container (`5d03`)
- **Task page and comments** — Redesign · Armin · working · armin-pc · container (`a8c1`)
- **Task folders** — Redesign · Lena · working · armin-pc · container (`3c9b`)
- **Visual identity prototype** — Redesign · Armin · working · armin-pc · container (`6f10`)
In review
- **Host sessions: idle stop** — Host sessions · Armin · idle · armin-pc · host (`d2a7`)

## Header (every page, UI-1, UI-5)
Wordmark "Agent Monitor" · project switcher · menus **Board** and **Tasks** · search field ·
**waiting-on-you count: 3** (Patch 25.21 notes page, Login with Riot account (RSO), Board, search
and topics). Clicking the count opens a small dropdown listing those 3 tasks with project name,
each linking to its task (Patch 25.21 → task.html; others → task.html too is acceptable) ·
Armin's avatar · dark/light toggle.

## Tasks page (tasks.html) — "All tasks" list (BOARD-3)
Search box (filters rows client-side by title, a little JS) and state filter chips. Lists
draftcoach tasks including finished ones:
- all 10 board tasks above, plus
- **Redesign download page** — done · Desktop app · Armin · Oct 14
- **Replace brand icon** — done · Armin · Oct 21
- **Landing page header navigation** — done · Lena · Oct 12
- **Patch 25.20 notes page** — done · Patch notes · Lena · Oct 9
- **Slint app: dark mode** — cancelled · Desktop app · Armin · Sep 30

## Task page (task.html) — Patch 25.21 notes page (TASK-12)
Tabs: **Page** (active) · **Chat** (chat.html) · **Settings** at the far right of the tab bar with a
gear icon (settings.html). Above or beside: project "draftcoach", branch `am/patch-25-21-notes-3f9c`.

- Title: Patch 25.21 notes page (looks editable in place: hover affordance)
- State: In progress (dropdown look)
- Assignee: Armin (avatar + name, dropdown look)
- Topics: Patch notes, Riot pipeline (+ add)
- Session: `7f3a` **waiting on you** · armin-pc · container · started Oct 21, 14:20 — button "Open session" → chat.html.
  Last user message (Armin, Oct 22 21:05): "Tooltip-only changes go in a collapsed Other section at the bottom."
  Agent's last reply (Oct 23 09:12): "Moved 6 tooltip-only items into Other. Approve the copy for Ambessa and Viego before I open the PR."

Description (rendered Markdown):
> Publish the patch notes page for 25.21 at `/patch/25.21`, generated from the Data Dragon diff and our own winrate deltas.
>
> - Champion changes with before/after numbers and our winrate shift since the patch (Emerald+)
> - Item changes, grouped as **buffs**, **nerfs**, **adjustments**
> - A "what it means for your draft" line per change; the agent drafts, Lena edits
>
> Reuse the layout of `/patch/25.20`. The hero image and Riot's official notes are in the folder.

Folder (FOLDER-2: inline by kind, who added it and when; download each; "Download all (.zip)";
a drop zone "Drop files here"):
- `patch-25.21-hero.png` — image, shown inline (`../assets/patch-25.21-hero.png`) · Lena Hofmann · Oct 21, 09:10 · 560 KB
- `riot-patch-25.21-notes.pdf` — PDF, shown inline (`<embed>`/`<object>` or `<iframe>` of `../assets/riot-patch-25.21-notes.pdf`, with an "open" link) · Armin · Oct 21, 09:11 · 31 KB
- `winrates-25.21.csv` — text, first lines shown inline:
  ```
  champion,games,wr_before,wr_after,delta
  Ambessa,14812,49.8,51.6,+1.8
  Viego,22410,50.9,49.1,-1.8
  Briar,812,51.2,47.9,too early
  Aurora,9301,48.7,50.2,+1.5
  ```
  · agent of session 7f3a · Oct 22, 18:40 · 3 KB

Comments (COMMENT-1/2: Markdown rendered, author + time; edited shows "edited"; Edit/Delete on own):
1. **Lena Hofmann** · Oct 21, 09:30 — "Winrate shifts need at least **2,000 games** per champion before we show them; below that mark them *too early*. Briar went from 51.2 to 47.9 on 812 games and that's noise."
2. **agent · 7f3a** · Oct 22, 18:42 — "Drafted notes for all 31 champion changes. 9 champions are under 2,000 games and show *too early*. Winrates are in `winrates-25.21.csv`. Open question: do item changes with no stat change (tooltip only) belong on the page?"
3. **Armin** · Oct 22, 21:05 — "Tooltip-only changes go in a collapsed **Other** section at the bottom." (own: Edit · Delete)
4. **agent · 7f3a** · Oct 23, 09:12 · edited — "Moved 6 tooltip-only items into *Other*. Before I open the PR: approve the copy for **Ambessa** and **Viego** (lines 40–58 of `patch-25.21.json`)."
Then a comment composer ("Write a comment… Markdown") with a Comment button.

History (TASK-14, time order, each with who and when):
- Oct 20, 10:02 · Armin created the task
- Oct 20, 10:03 · Armin linked **Patch notes**
- Oct 20, 10:03 · Armin assigned Lena Hofmann
- Oct 21, 09:10 · Lena Hofmann added patch-25.21-hero.png
- Oct 21, 09:11 · Armin added riot-patch-25.21-notes.pdf
- Oct 21, 09:30 · Lena Hofmann commented
- Oct 21, 14:20 · Armin started session 7f3a on armin-pc (container)
- Oct 21, 14:20 · Armin moved it Open → In progress
- Oct 21, 16:05 · agent · 7f3a linked **Riot pipeline**
- Oct 22, 18:40 · agent · 7f3a added winrates-25.21.csv
- Oct 22, 18:42 · agent · 7f3a commented
- Oct 22, 21:05 · Armin commented
- Oct 22, 21:06 · Lena Hofmann assigned Armin
- Oct 23, 09:12 · agent · 7f3a commented — waiting on you
Sessions list: `7f3a` waiting on you · armin-pc · container · Oct 21 – now; `2c81` ended · armin-pc · host · Oct 20, 10:05 – 10:40 (it ended without commits).

## Chat tab (chat.html)
Same task header + tabs (Chat active). Below: a session strip (`7f3a`, waiting on you,
armin-pc · container, "End session" lives in Settings). Then a large placeholder frame that fills the rest of
the viewport, clearly labelled as where the agent chat goes (Tern today, our own UI on `omp acp` later),
e.g. dashed/framed area with a faint mock of 2–3 chat bubbles and the label "Agent chat · session 7f3a".

## Settings tab (settings.html) (UI-2)
Same header + tabs (Settings active, gear at the right). Subtabs: **Changes** · **Previews** (disabled, "step 6") ·
**Cloudflare** · **End session**. Switching subtabs with a little JS (or `#hash` + `:target`).
- Changes (CARD-3/4): branch `am/patch-25-21-notes-3f9c` vs `main`: 3 commits;
  files: `web/src/pages/patch/25.21.astro` +212, `web/src/data/patch-25.21.json` +1804,
  `web/src/components/PatchChange.astro` +18 −4 (overlap: also changed by "Draft overlay: ban-phase suggestions", link);
  uncommitted: `web/src/pages/patch/index.astro` (modified). Pull requests: none open ("Opens when the agent runs `gh pr create`").
- Cloudflare (CLOUDFLARE-2): reads always allowed for account "draftcoach"; writes **not allowed**;
  button "Allow writes for 10 minutes"; show what an allowed state looks like too (e.g. a second muted line "When allowed: 9:41 left · Revoke").
- End session: what ending does (stops container, keeps branch `am/patch-25-21-notes-3f9c` and task); shows
  "1 uncommitted file" warning; a destructive "End session" button.

## Topic panel (UI-4)
Clicking ANY topic name on ANY page opens a side panel (overlay, Esc/× closes) with the topic name in its
colour, its rendered status, and linked tasks (with state + session state). Write content for at least
**Patch notes** and **Redesign**; the others get a 2–4 line status.

Patch notes status:
> Every patch gets a page at `/patch/<version>` within 24 hours of Riot's release.
> - 25.20 published Oct 9 (#24 merged)
> - 25.21 in progress: draft done, copy review by Armin
> - Next: generate the Data Dragon diff automatically (an automation, step 7)
>
> **Open:** who writes "what it means for your draft" when Lena is away?

Linked: Patch 25.21 notes page (in progress · waiting on you), Patch notes: automate Data Dragon diff (open),
Patch 25.20 notes page (done).

Redesign status:
> Step 4 of PLAN.md, built as four parallel tasks.
> - Task page and comments: comments and history done, editing in place next
> - Board, search and topics: waiting on Armin for the search scope
> - Task folders: upload and inline preview work, zip download next
> - Visual identity prototype: three directions to pick from
Linked: those four tasks.

Riot pipeline: "Match fetch runs every 30 min on the hub; rank enrichment hits 429s at peak (task in progress). Snapshots publish to R2 hourly." Desktop app: "Tauri rewrite (app-next) replaces the Slint app; beta channel next." Pro archives: "LCK, LEC, LPL archives through Worlds 2026." Auth & login: "Riot Sign On (RSO) behind the auth proxy; waiting on Riot's production key." Host sessions, Hub, Automations: one line each, your words.
