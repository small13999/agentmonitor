# SPEC draft: steps 4–8

Step 3 of PLAN.md. The user reviews this file; accepted claims move into SPEC.md
(one step at a time, as each step starts) and this file is deleted. Wording follows
SPEC.md: a claim is observable and gets a real-stack test.

Marks: **new** claim, **changed** (same ID, new text), **retired** (ID never comes
back). Unmarked existing claims stay as they are. Questions are marked **Q** with
the answer this draft assumes; a different answer changes the claims under it.

## Step 4: redesign

### People

- **PERSON-1** new: A store has people, each with a name and an avatar; the user
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
  changes, sessions started and ended (with their machine), comments, files
  added, and pull requests, each with who and when.
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
- **COMMENT-3** new: A comment by a person while the task's session runs reaches
  its agent: `am comments` lists it, and the agent's next turn starts with it.
  - **Q** Should a human's comment also *start* a turn in the running chat (like
    typing a prompt)? Draft: no; it is delivered at the next turn, so comments
    never interrupt work. The chat stays the way to talk to the agent now.

### Folders

- **FOLDER-1** new: Every task and every automation has a folder in the store (not
  in git). People add files by dropping them on the page, agents with `am folder`.
- **FOLDER-2** new: A folder's files show inline by kind (images, video, PDF,
  Markdown, text), each with who added it and when; one file or the whole folder
  downloads, the folder as a zip.
- **FOLDER-3** new: A session's agent finds its owner's folder as a directory in
  its workspace; what it writes there shows on the page within seconds, and the
  reverse.
  - **Q** Container and host sessions on the hub can mount it; a session on a
    remote runner (step 8) gets it synced over the runner link. Fine to claim the
    behavior now and build the sync in step 8?

### Board

- **BOARD-1** changed: The board shows the project's tasks in Open, In progress,
  and In review; each card shows the task's title, topic names, assignee, and its
  running session's state and machine.
- **BOARD-3** new: Done and cancelled tasks leave the board; search and the All
  tasks list find every task by title, description, and comments.
- **CARD-2** retired (last messages on the card). The task page and chat show them.
- **CARD-1, CARD-3, CARD-4, CARD-5** changed to name the task, not a session card:
  - CARD-1: A task's card and page show its running session as waiting on you,
    working, idle, or stopped; working pulses.
  - CARD-3: A task's Changes view shows its uncommitted changes, unpushed commits,
    and open pull requests.
  - CARD-4: A task's Changes view names the other running tasks of the project
    that changed any of the same files, and its card marks that it has them.
  - CARD-5: retired, duplicate of BOARD-2.

### Layout and identity

- **UI-2** changed: A task has three tabs: Page, Chat (its running session's
  chat, or starting one), and Settings, a full tab at the right of the tabs with
  subtabs Changes, Previews, Cloudflare, and End session. Switching tabs keeps the
  chat loaded.
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
- **AUTH-3** new: Only the store's owner adds people, allows host sessions, and
  allows Cloudflare writes.
  - **Q** The teammate otherwise sees and does everything (all projects, start and
    end sessions, finish tasks)? Draft: yes; per-project access comes later if
    ever needed.
- **PREVIEW-2** changed: The UI, each session's chat, and each preview are each
  their own origin: `am.draftcoach.gg`, `am-t-<session>.draftcoach.gg`,
  `am-p-<task>.draftcoach.gg`.
- **STORE-6** new: Moving a store to another machine keeps every project, topic,
  task, comment, folder, chat, and snapshot.
- **Q** Host sessions on the hub run on Hetzner as its service user, so they are
  off for every project there; host sessions (and the integrator) stay on the
  user's PC as a runner (step 8). Until then the integrator keeps running against
  the PC's own store. OK?

## Step 6: previews

- **PREVIEW-4** new: A task's page has a Preview tab showing its running
  session's app; the agent names the port with `am preview <port>`, and the project
  can name a default port.
- **PREVIEW-1, PREVIEW-3** stay.
- **PREVIEW-5** new: A project can send its previews' logins to production: the
  preview's login requests go to production as if they came from production's own
  site, the preview gets the login, and the login cookie never reaches the
  session's container. Draftcoach is set up this way.

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
- **SESSION-5** changed: A session belongs to one task or one automation, and
  runs in one workspace on exactly one machine.
- **AUTO-3, AUTO-4, AUTO-5, AUTO-6** retired: event triggers and dedupe are not in
  the design (Deferred mentions events); AUTO-6 is replaced by end modes.
- **Q** REVIEW-1..3 (inbox) are untested and partly overlap the board's "waiting
  on you". Draft: keep them; the inbox lists waiting runs, waiting sessions, and
  pull requests across projects. Or retire them in favour of the header count?

## Step 8: runners and idle stop

- **MACHINE-3** new: A session runs on a runner: the hub's machine, or a machine
  connected to the hub (the user's PC while it is on); starting a session picks
  one, the user can choose.
- **MACHINE-4** new: A runner that disconnects shows as offline, and its sessions
  as stopped on that machine.
- **MACHINE-5** new: A session idle for 30 minutes (no turn working, nobody
  waiting on it, its chat open nowhere) stops; its uncommitted work goes to the
  store as the task's snapshot first (SESSION-9), so any runner can go on.
  - **Q** "WIP push" in PLAN.md: draft reads it as the snapshot going to the
    store, not a commit pushed to GitHub, so SESSION-9 ("never pushed to a
    remote") stays. Or push a WIP commit to the task branch?
  - **Q** After an idle stop, does the task's next session (maybe on another
    runner) go on with the last chat, or start a new chat with the task's context?
    Draft: go on with the last chat; chats are in the store (SESSION-3).
- MACHINE-1, MACHINE-2 stay.

## Open items not drafted

- The integrator pulling in other tasks' branches (PLAN.md, host sessions).
- Switching host sessions on for an existing project: a project settings claim in
  step 4, UI-6, if wanted.
