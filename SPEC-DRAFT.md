# SPEC draft: steps 4–8

Step 3 of PLAN.md. The user reviews this file; accepted claims move into SPEC.md
(one step at a time, as each step starts) and this file is deleted. Wording follows
SPEC.md: a claim is observable and gets a real-stack test.

Marks: **new** claim, **changed** (same ID, new text), **retired** (ID never comes
back). Unmarked existing claims stay as they are. Open points are marked **Q** with
the answer this draft assumes.

## Concepts (agreed; SPEC.md's Concepts table changes to match)

- **Store**: one Agent Monitor server and its database: projects, topics, tasks,
  comments, folders, chats. A project lives in exactly one store. `agentmonitor`
  lives in the store on the user's PC; `draftcoach` in the store on the Hetzner hub.
  Caching parts of a store elsewhere is an implementation detail.
- **Hub**: a store that people other than its owner reach over the network
  (`am.draftcoach.gg`). The teammate only uses the hub's site.
- **Client**: the user's local Agent Monitor also shows the hub's projects (STORE-3),
  exactly as the hub's site shows them, plus "Run session locally".
- **Machine**: where a session's workspace runs. A store's own machine runs its
  sessions. A **local run** is a session of a hub project that a client asked to run
  on its own machine; the hub never sends work to a client. A **persistent runner**
  is a machine that opted in to take work from a hub (later; the user's PC will not).
- **Host session**: a session without a container on whichever machine runs it, as
  that machine's user: on the hub for disk or database work, on the user's PC to
  build and test there. On a hub only its owner starts them.
- **Integrator** (checkout session): the project's main thread. One per project
  (later perhaps one per independent subsystem), a host session in the main checkout,
  where other tasks' branches are pulled in, reviewed, and their conflicts resolved.
- **Session states**: running; **stopped** (idle stop, machine off, crash; to people
  it is still the same session and goes on with the same chat, possibly on another
  machine); **ended** (only when a person ends it).
- **Commits and pushes**: a turn ends when its work is ready: committed, pushed,
  previews running. The agent does all of it within the turn (its instructions say
  so), so it decides what is committed (secrets stay out) and a failure is the
  agent's to fix or explain in the same turn; Agent Monitor adds no step after the
  turn. The task's branch is the backup and the turn history. Deploying is
  separate: when a person says so, the agent opens a pull request with logical
  commits, and it merges. Nobody has to know about commits or decide about
  uncommitted files.

## Step 4: redesign

### People

- **PERSON-1** new: A store has people, each with a name and an avatar; its owner
  adds them. Every human action (comment, state change, upload, start/end of a
  session) is recorded with the person who did it. Until login exists (step 5)
  every request is the store's owner.
- **PERSON-2** new: An agent's actions are recorded as the agent of its session,
  shown with the session's avatar and linking to the session.

### Task page

- **TASK-12** new: Opening a task (from the board, the task list, a link) shows its
  page: title, description, state, assignee, topics, folder, comments, history,
  and its sessions; title, description, state, assignee, and topics are edited in
  place.
- **TASK-13** new: A task's assignee is one person or nobody.
- **TASK-14** new: A task's history lists in time order its state and assignee
  changes, sessions started, stopped, and ended (with their machine), comments,
  files added, and pull requests, each with who and when.
- **TASK-6** changed: A session's first chat starts with its task's title,
  description, status, and comments in context.
- **TASK-8** retired (notes). Replaced by comments.
- **TASK-15** new: Every task's notes became a comment by the store's owner,
  dated when the notes were last written.

### Comments

- **COMMENT-1** new: People comment on a task from its page, agents with `am
  comment`; a comment is Markdown, shows rendered, and shows its author and time.
- **COMMENT-2** new: A comment's author can edit or delete it; an edited comment
  says so.
- **COMMENT-3** new: Comments are discussion between people and never reach a
  running session's chat; its agent reads them when its session starts (TASK-6) and
  when it asks (`am comments`).

### Folders

- **FOLDER-1** new: Every task and every automation has a folder in the store (not
  in git). People add files by dropping them on the page, agents with `am folder`.
- **FOLDER-2** new: A folder's files show inline by kind (images, video, PDF,
  Markdown, text), each with who added it and when; one file or the whole folder
  downloads, the folder as a zip.
- **FOLDER-3** new: A session's agent finds its owner's folder as a directory in
  its workspace; what it writes there shows on the page within seconds, and the
  reverse. Local runs (step 8) get it synced.

### Board

- **BOARD-1** changed: The board shows the project's tasks in Open, In progress,
  and In review; each card shows the task's title, topic names, assignee, and its
  session's state and machine.
- **BOARD-3** new: Done and cancelled tasks leave the board; search and the All
  tasks list find every task by title, description, and comments.
- **CARD-2** retired (last messages on the card). The task page and chat show them.
- **CARD-5** retired, duplicate of BOARD-2.
- **CARD-1, CARD-3, CARD-4** changed to name the task, not a session card:
  - CARD-1: A task's card and page show its session as waiting on you, working,
    idle, stopped, or ended; working pulses.
  - CARD-3: A task's Changes view shows what its branch changed against the
    default branch, its uncommitted files, and its open pull requests.
  - CARD-4: A task's Changes view names the other running tasks of the project
    that changed any of the same files, and its card marks that it has them.

### Layout and identity

- **UI-2** changed: A task has three tabs: Page, Chat (its session's chat, or
  starting one), and Settings, a full tab at the right of the tabs with subtabs
  Changes, Previews, Cloudflare, and End session. Switching tabs keeps the chat
  loaded.
- **UI-4** new: A topic's name shows the same everywhere, in the topic's own
  colour; clicking it opens a panel with its rendered status and linked tasks.
- **UI-5** new: The header counts the tasks waiting on you, on every page, and
  links to them.
- Not claims: type, accent, colours, avatars, motion. A clickable prototype comes
  first; the user picks before it is built in.

## Step 5: hub on Hetzner

- **AUTH-1** new: Every request to the hub, its session hosts, and its previews
  needs a valid Cloudflare Access token for the hub; the hub checks the token
  itself, so a request that bypasses the tunnel is refused.
- **AUTH-2** new: A person logs in through Cloudflare Access with their email and
  acts as the person with that email; an email that is not a person of the store
  is refused.
- **AUTH-3** new: Every person of a hub sees and works on all its projects; only
  its owner adds people, starts host sessions, and allows Cloudflare writes.
- **HOST-1** changed: A session runs its agent in a container, or on the host when
  its project allows host sessions; a project allows them only when its store's
  owner says so.
- **HOST-2** changed: "on the gateway's machine" becomes "on the machine that runs
  it, as that machine's user".
- **STORE-3** changed: A client configured with hubs lists their projects beside
  its own, shows each hub project as the hub's site does, and marks unreachable
  hubs as unavailable.
- **PREVIEW-2** changed: The UI, each session's chat, and each preview are each
  their own origin: `am.draftcoach.gg`, `am-t-<session>.draftcoach.gg`,
  `am-p-<task>.draftcoach.gg`.
- **STORE-6** new: Moving a store to another machine keeps every project, topic,
  task, comment, folder, and chat.

## Step 6: previews

- **PREVIEW-4** new: A task's page has a Preview tab showing its running
  session's app; the agent names the port with `am preview <port>`, and the project
  can name a default port.
- **PREVIEW-1, PREVIEW-3** stay.
- **PREVIEW-5** new: A project can send its previews' logins to production: the
  preview's login requests go to production as if they came from production's own
  site, the preview gets the login, and the login cookie never reaches the
  session's container. Draftcoach is set up this way.
- **DEPLOY-1** new: A task's page has "Deploy changes": its agent opens a pull
  request of the task's work to the default branch, in logical commits, and
  merges it when its checks pass. Telling the agent to deploy does the same.
  - **Q** Draft: the button sends the agent a fixed prompt, so both ways are one
    path. MERGE-2 (merge when checks pass and policy allows) covers the merge.

## Step 7: automations

- **AUTO-1** changed: An automation has a name, instructions, a model, triggers,
  an end mode, a folder (shared by all its runs, also its memory), and an on/off
  switch; an automation that is off starts no runs.
- **AUTO-2** stays: a schedule fires at most once per scheduled time, also across
  restarts.
- **AUTO-8** new: A trigger is a schedule, optionally with a guard (code in the
  folder, run first) and a check (a prompt in the folder, answered by a cheap
  model); a run starts only when both pass. An automation has any number of
  triggers.
- **AUTO-9** new: Each run is a session of the automation on its own branch
  `am/<automation>-<run>` from the default branch, never a task.
- **AUTO-10** new: End mode Finish (default): the run writes its outputs into the
  folder, deploys nothing, and its session ends. End mode Wait for review: its
  session stays open and the run counts as waiting on you.
- **AUTO-11** new: A run can be followed up by going on in its session, or by
  starting a session on the automation, optionally from a run (its branch and
  outputs).
- **AUTO-12** new: Making a task from a run gives the task the run's branch and
  links the run's outputs.
- **AUTO-7** changed: An automation's page shows first what its runs produced and
  what waits for review, then its runs with time, session, and outcome.
- **SESSION-5** changed: A session belongs to one task or one automation and runs
  in one workspace on one machine at a time.
- **AUTO-3, AUTO-4, AUTO-5, AUTO-6** retired: event triggers and dedupe are not in
  the design (Deferred mentions events); AUTO-6 is replaced by end modes.
- REVIEW-1..3 (inbox) stay.

## Step 8: commits, stops, local runs

- **SESSION-9** retired (snapshot refs, "never pushed"). Replaced by SESSION-15.
- **SESSION-15** new: A turn that changed files ends with them committed and
  pushed to the task's branch by the session's agent; when the agent tries to end
  a turn with `am check` failing, Agent Monitor sends it back to finish within the
  same turn, so a person never meets uncommitted work. Agent Monitor itself does
  no git work after a turn. (omp's `session_stop` hook; the tests whose turns
  leave uncommitted work on purpose are rewritten with SESSION-9's retirement.)
- **TURN-1** retired (snapshot without changing the branch).
- **TURN-2, TURN-3** changed: a turn's diff is the commits it made; the diff view
  offers the whole branch and each turn, with the turn's prompt and final reply.
- **TASK-11** changed: `am check` lists uncommitted files and untracked files that
  look like secrets, and fails while there are any; the agent runs it before it
  ends a turn.
- **SESSION-16** new: A running session that is idle for 30 minutes (no turn
  working, not waiting on anyone, its chat open nowhere) stops; opening it goes on
  with its last chat from its branch, on any machine that may run it. Its work is
  already pushed (SESSION-15), so stopping has nothing to save.
- **SESSION-10** changed: Opening a stopped session starts it again on its last
  chat; SESSION-16 covers starting it on another machine.
- **MACHINE-3** new: A client can run a session of a hub project locally ("Run
  session locally"); the session shows on the hub as running on that machine, and
  its chats reach the hub (SESSION-3).
- **MACHINE-4** new: The hub never starts a session on a machine that has not
  opted in as a persistent runner; a client that disconnects leaves its local runs
  stopped, and they go on elsewhere from their branches (SESSION-16).
- Deferred: "moving a running session between machines" stays deferred; moving a
  stopped one is SESSION-16.
- MACHINE-1, MACHINE-2 stay.
- **MERGE-1** changed: No session pushes to its project's default branch, except
  the integrator when a person asks for it. The integrator backs up its commits to
  `am/integrator`; its instructions already say so.

## Not drafted yet

- How the integrator pulls in other tasks' branches.
- Switching host sessions on for an existing project (project settings, step 4).
