# Agent Monitor Specification

This file is the contract between the humans and the implementation. Each
numbered claim is an observable behavior. Implementation lives in code; niche
knowledge lives in short code comments; neither belongs here.

## How this file works

- A claim is a line `- **AREA-N** text`. Continuation lines are indented two
  spaces.
- IDs are stable. Never renumber, never reuse. A deleted claim's ID is retired
  in `spec.lock.json` and cannot come back.
- Every claim is covered by at least one test that calls
  `spec("AREA-N", "title", fn)` from `tests/spec.ts`.
- `npm run spec:check` reports:
  - errors: malformed or duplicate IDs, tests referencing unknown or retired
    IDs, and any drift between this file, the tests, and `spec.lock.json`;
  - warnings: claims with no test (`--strict` turns these into errors).
- Drift means a claim's text or a covering test changed, appeared, or
  disappeared since the last `npm run spec:lock`. Review the claim/test pair,
  then run `spec:lock` to acknowledge it.

## Testing policy

- Claims are use cases. A claim's test exercises it through the real stack:
  gateway, store, container, omp. Real use cases must be proven to work.
- Tests that need a container share one test container per run and run in
  parallel inside it. Make the real stack fast rather than avoiding it.
- A fake replaces a real component only where it is measurably cheaper and the
  claim stays proven.
- No tests for wiring, forwarding, or incidental behavior.

## Goals

Unnumbered intent; not testable, so not claims.

- Make the places where the human is the bottleneck fast: dispatching work,
  recalling context, reviewing output. Do not chase full autonomy.
- Context outlives containers. Ending a session never loses knowledge.
- Work is saved outside the machine as it is done: ending a session leaves no
  branch or worktree behind, so nobody has to sort through leftovers.
- Opening the app answers: where did I leave off, what needs me, what work is
  unsaved, and what could my next task collide with.
- A non-technical teammate can follow and steer work from tickets alone.
- Anything the agent sees, the human sees, and the reverse: UI and agents use
  the same data through the same API.
- Status comes from mechanical sources (git, omp, tools), not from agents
  remembering to report it.
- The orchestrator is an ordinary session invoked on demand, never a gate that
  all work must pass through.
- Our web app owns navigation and every cross-session view. Tern owns the full
  agent harness inside one session.

## Concepts

| Concept | Meaning |
|---|---|
| Store | One Agent Monitor server and its SQLite database: projects, topics, tasks, comments, folders, chats; a project lives in exactly one store |
| Hub | A store that people other than its owner reach over the network (`am.draftcoach.gg`) |
| Client | The user's local Agent Monitor, which also shows the projects of the hubs it is configured with |
| Machine | Where a session's workspace runs; a store's own machine runs its sessions |
| Topic | Long-lived area of work (an epic) with a short status, a colour, and linked history |
| Task | Requested work with a state, an assignee, a branch, a status, comments, a folder, and the sessions that worked on it |
| Person | Someone who uses a store: its owner, or a teammate the owner added |
| Comment | Discussion between people (and agents) on a task; never part of a running chat |
| Folder | A task's (later an automation's) files, kept in the store, not in git |
| Session | One agent run on a task: a workspace and the agent chats in it |
| Chat | One omp conversation; a session can start any number of them |
| Workspace | Where a running session lives: its worktree and its container, or its host processes, on one machine |
| Host session | A session whose agent runs as the machine's user, without a container; on a hub only its owner starts them |
| Integrator | A project's host session in its main checkout, where other tasks' branches are merged |
| Automation | Trigger (schedule or event) that starts a session |
| Event | Fact emitted by an agent or the system, with a dedupe key |
| Lease | Exclusive hold on a named resource |

## Spec process

- **SPEC-1** A claim without a covering test is reported as a warning; with
  `--strict` it fails the check.
- **SPEC-2** A test referencing an ID that is not a current claim fails the
  check.
- **SPEC-3** Changing a claim's text, or adding, changing, or removing a
  covering test, fails the check until `spec:lock` is run.
- **SPEC-4** `spec:lock` retires the IDs of deleted claims; reusing a retired ID
  fails the check.
- **SPEC-5** Duplicate claim IDs fail the check.

## Stores and projects

- **STORE-1** Every record belongs to exactly one store, the store of its
  project.
- **STORE-2** A record can link only to records in the same store.
- **STORE-3** A client configured with hubs lists their projects beside its own,
  shows each hub project as the hub's site does, and marks unreachable hubs as
  unavailable.
- **STORE-4** Starting a session in a project whose store is unreachable fails
  with an error naming the store.
- **STORE-5** Every action and every piece of data shown in the UI is available
  to agents as a tool backed by the same store API endpoint.
- **STORE-6** Moving a project to another store keeps its topics, tasks,
  comments, folders, chats, and who did what; afterwards the project lives only in
  the new store.

## Access

- **AUTH-1** Every request to the hub, its session hosts, and its previews needs a
  valid Cloudflare Access token for the hub; the hub checks the token itself, so a
  request that bypasses the tunnel is refused.
- **AUTH-2** A person logs in through Cloudflare Access with their email and acts
  as the person with that email; an email that is not a person of the store is
  refused.
- **AUTH-3** Every person of a hub sees and works on all its projects; only its
  owner adds people, starts host sessions, and allows Cloudflare writes.

## Sessions

- **SESSION-1** A session's model is chosen when it starts.
- **SESSION-2** An ended session's chats are read-only.
- **SESSION-3** A session's chats reach its project's store within 60 seconds of
  each completed turn, from any machine.
- **SESSION-4** Every chat starts with both the Agent Monitor workflow context and
  the repository's own `AGENTS.md`.
- **SESSION-5** A session belongs to one task or one automation and runs in one
  workspace: a worktree of its branch and a container, or host processes, on
  exactly one machine at a time.
- **SESSION-7** A new chat started in a session stays in that session: same
  workspace, worktree, and task, and the session's card shows the new chat.
- **SESSION-8** Ending a session removes its workspace and keeps its chats; the
  task's branch stays.
- **SESSION-9** Ending a session never loses work: its uncommitted changes are
  kept as the task's latest snapshot on the store's machine, never pushed to a
  remote, and the task's next session starts with them restored.
- **SESSION-10** Opening a session whose container has stopped starts the
  container again on the session's last chat.
- **SESSION-12** A session's agent commits as the user and has the user's ssh
  keys and GitHub CLI login, so it can push its branch.
- **SESSION-13** Until a session's chat has loaded, its page says what it waits
  on, including that a stopped container is starting.
- **SESSION-17** A session's agent runs with the user's own omp settings (such as
  compaction and model roles); Agent Monitor's settings for the session win where
  both set something, and the user's settings file is never changed.

## Host sessions

- **HOST-1** A session runs its agent in a container, or on the host when its
  project allows host sessions; a project allows them only when its store's owner
  says so.
- **HOST-2** A host session's agent runs on the machine that runs it, as that
  machine's user, in the session's own worktree, with the user's tools, git
  identity, ssh keys and GitHub CLI login, and can start processes of its own;
  ending the session stops all of them.
- **HOST-3** A host session is marked red on its board card, its task list row,
  and its task's settings.
- **HOST-4** A host session's chat, task context, `am`, card, and restart on
  its last chat work as a container session's do.
- **HOST-5** A host session never changes the user's omp, Tern, ssh, git, or
  GitHub CLI configuration.
- **HOST-6** A host session can work in its project's main checkout instead of a
  worktree, at most one per project, and is marked as such. Ending it stops its
  processes and leaves the checkout, its branch, and its uncommitted work as they
  are.
- **HOST-7** A session in the main checkout has the user's omp chats of the
  checkout, as omp in a terminal there does: it can go on with any of them, and
  its own chats are among them.

## Transcripts

- **TRANSCRIPT-1** Every agent in a project can search and read every chat of
  every session of that project, including running ones.
- **TRANSCRIPT-2** An agent cannot read transcripts of other projects.
- **TRANSCRIPT-3** A search scoped to a topic returns only chats of sessions
  whose task is linked to that topic.

## Turn diffs

- **TURN-1** Each completed agent turn records a worktree snapshot without
  changing the branch, index, or working tree.
- **TURN-2** The diff view offers an overall diff (session base to latest
  snapshot) and a per-turn diff for every turn.
- **TURN-3** Each per-turn diff shows that turn's user message and the agent's
  final response.

## Topics

- **TOPIC-1** A topic belongs to one project and has no parent topic.
- **TOPIC-2** A topic's status is a markdown document of at most 50 lines; a
  longer write is rejected.
- **TOPIC-3** A status write names the revision it was based on; a write based
  on a stale revision is rejected and returns the current revision.
- **TOPIC-7** A topic's history lists its linked tasks, sessions, and pull
  requests in time order.
- **TOPIC-8** When a linked pull request merges, its merge commit is recorded
  on the link.

## Session cards

- **CARD-1** A task's card and page show its running session as waiting on you,
  working, idle, or stopped; working pulses.
- **CARD-3** A task's page has a Work section: its branch's state (nothing yet,
  uncommitted changes in its running session, commits not pushed, or pushed), its
  commits with their descriptions, its pull requests (open, merged, or closed) with
  their checks, and how many files changed, which expands to the list.
- **CARD-4** A task's Work section names the other running tasks of the project
  that changed any of the same files, and its card marks that it has them.
- **CARD-6** A task's card shows one badge for the most important state of its
  work: not pushed, pull request open, or deployed.
- **DEPLOY-1** A task's page has Deploy: its agent (its session started if
  stopped) opens a pull request of the task's work to the default branch with a
  description, and merges it once its checks pass; telling the agent to deploy
  does the same.

## Tasks

- **TASK-1** A task belongs to one project and has a title, a description, and
  a state: `open`, `in_progress`, `in_review`, `done`, or `cancelled`.
- **TASK-2** A task links to any number of topics; the UI and any agent tool can
  add or remove links at any time, and the links outlive its sessions.
- **TASK-3** A task is created without starting work; starting a session on it
  is a separate action.
- **TASK-4** A task has one branch, created when its first session starts;
  every session of the task works on that branch, which outlives them.
- **TASK-5** A task has at most one running session.
- **TASK-6** A session's first chat starts with its task's title, description,
  status, and comments in context.
- **TASK-7** A task has a status of at most 50 lines that its agents keep
  current; a status write based on a stale revision is rejected.
- **TASK-9** Marking a task done or cancelled ends its running session and
  deletes its branch from the machine; when the branch has commits no remote
  has, it requires a confirmation that lists them.
- **TASK-10** Every session from before tasks existed became a task with the
  session's name, branch, topic links, and notes.
- **TASK-11** `am check` lists a session's uncommitted files, unpushed commits,
  and untracked files that look like secrets, and fails while there are any.
- **TASK-12** Opening a task (from the board, the task list, a link) shows its
  page: title, description, state, assignee, topics, folder, comments, history,
  and its sessions; title, description, state, assignee, and topics are edited in
  place.
- **TASK-13** A task's assignee is one person or nobody.
- **TASK-14** A task's history lists in time order its state and assignee
  changes, topic links, sessions started and ended (with their machine),
  comments, files added, and pull requests, each with who and when.
- **TASK-15** Every task's notes became a comment by the store's owner, dated
  when the notes were last written.

## People

- **PERSON-1** A store has people, each with a name and an avatar; its owner
  adds them. Every human action (comment, state change, upload, start or end of a
  session) is recorded with the person who did it. Until login exists every
  request is the store's owner.
- **PERSON-2** An agent's actions are recorded as the agent of its session,
  shown with the session's avatar and linking to the session.

## Comments

- **COMMENT-1** People comment on a task from its page, agents with `am
  comment`; a comment is Markdown, shows rendered, and shows its author and time.
- **COMMENT-2** A comment's author can edit or delete it; an edited comment says
  so.
- **COMMENT-3** Comments are discussion between people and never reach a running
  session's chat; its agent reads them when its session starts (TASK-6) and when
  it asks (`am comments`).

## Folders

- **FOLDER-1** Every task has a folder in the store, not in git. People add files
  by dropping them on the task's page, agents with `am folder`.
- **FOLDER-2** A folder's files show inline by kind (images, video, PDF,
  Markdown, text), each with who added it and when; one file or the whole folder
  downloads, the folder as a zip.
- **FOLDER-3** A session's agent finds its task's folder as a directory in its
  workspace; what it writes there shows on the page within seconds, and the
  reverse.

## Board

- **BOARD-1** The board shows the project's tasks in Open, In progress, and In
  review; each card shows the task's title, topic names, assignee, and its
  running session's state and machine.
- **BOARD-2** Tasks waiting on you sort first in their column, and the header
  counts them.
- **BOARD-3** Done and cancelled tasks leave the board; search and the All tasks
  list find every task by title, description, and comments.

## Review inbox

- **REVIEW-1** The inbox lists every item awaiting a human: pull requests ready
  for review, sessions waiting on you, and automation runs requiring review.
- **REVIEW-2** Each inbox item links to its session, diff, and preview when they
  exist.
- **REVIEW-3** Approving or rejecting an item records the decision, the actor,
  and the time.

## Previews

- **PREVIEW-1** Each running session's service ports are reachable at
  authenticated URLs from outside the machine running it.
- **PREVIEW-2** The UI, each session's chat, and each preview are each their own
  origin: `am.draftcoach.gg`, `am-t-<session>.draftcoach.gg`,
  `am-p-<task>.draftcoach.gg`.
- **PREVIEW-3** A preview whose container is stopped shows as stopped with an
  action to start the session's container again.

## Integration

- **MERGE-1** No session can push to its project's default branch.
- **MERGE-2** A session can merge its own pull request when checks pass and the
  project's or topic's policy allows merging without review.
- **MERGE-3** The pending-work list shows every session branch with commits not
  on the default branch.

## Automations

- **AUTO-1** An automation has a name, instructions, a model, triggers, an end
  mode, a time limit, a folder (shared by all its runs: `memory.md` and each run's
  outputs in `runs/<run>/`), and an on/off switch; an automation that is off
  starts no runs.
- **AUTO-2** A schedule (cron, with a timezone; default Europe/Budapest) fires at
  most once per scheduled time, also across restarts; times missed while the store
  was down fire once as soon as it is back.
- **AUTO-7** An automation's page shows first what its runs produced and what
  waits for review, then its runs and firings with time, session, and outcome; a
  run's outputs download with one click.
- **AUTO-8** A trigger is a schedule, optionally with a guard (code in the folder,
  run in the session image; exit 0 passes, its output goes on) and a check (a
  prompt in the folder that a cheap model answers with read-only tools: the web
  and the folder; it says yes or no and why). A run starts only when both pass,
  and every firing records what the guard and check said. An automation has any
  number of triggers.
- **AUTO-9** Each run is a session of the automation on its own branch
  `am/<automation>-<run>` from the default branch, never a task. A firing while a
  run of the automation is still going is skipped and recorded as such.
- **AUTO-10** End mode Finish (default): the run writes its outputs into the
  folder, deploys its work (a pull request it merges once checks pass, MERGE-2),
  and its session ends; a run with nothing to deploy deletes its branch. End mode
  Wait for review: the run writes its outputs and pushes its branch, deploys
  nothing, its session stays open, and it counts as waiting on you.
- **AUTO-11** A run can be followed up by going on in its session (for example to
  deploy what was reviewed), or by starting a session on the automation,
  optionally from a run (its branch and outputs).
- **AUTO-12** Making a task from a run gives the task the run's branch and links
  the run's outputs.
- **AUTO-13** A run's prompt holds the automation's instructions, what its
  trigger's guard and check found, and the folder's `memory.md`.
- **AUTO-14** A run that reaches its automation's time limit (default 120
  minutes) is stopped and recorded as timed out.
- **AUTO-15** People create and change automations on the site; agents do the same
  with `am automation`, so an agent can set one up with a person.
- **AUTO-16** A run's page shows its work as a task's does (CARD-3), with Deploy
  (DEPLOY-1) while it waits for review.

## Leases

- **LEASE-1** Acquiring a lease on a held resource fails and names the holding
  session.
- **LEASE-2** A lease is released when its session ends or its container stops.
- **LEASE-3** Every resource is shown as free or held, with the holding
  session.

## Machines

- **MACHINE-1** Each machine shows CPU, memory, and the sessions running on it.
- **MACHINE-2** Starting a session that would exceed a machine's memory budget
  is refused before its container is created.

## Cloudflare

- **CLOUDFLARE-1** A session's agent reads its project's Cloudflare account with
  Wrangler through the gateway, which keeps the project's Cloudflare tokens out of
  the container.
- **CLOUDFLARE-2** A session's agent can change its project's Cloudflare account
  only while the user allows it in the task's settings, for 10 minutes at a time
  or until the user revokes it; an agent cannot allow itself.
- **CLOUDFLARE-3** A project's Cloudflare tokens are set by its store's owner in
  the project's settings and kept in its store; they are never shown again or
  given to a session, and they move with the project (STORE-6).

## Web app

- **UI-1** The app's header names Agent Monitor and its menus, Board and Tasks.
  The Tasks page lists the project's open and in-progress tasks beside a
  workspace that shows the chosen task.
- **UI-2** A task has three tabs: Page, Chat (its running session's chat, or
  starting one), and Settings, a full tab at the right of the tabs with subtabs
  Cloudflare and End session (Previews joins them in step 6). Switching
  tabs keeps the chat loaded.
- **UI-3** The Tasks page's project menu creates a project from its name, its
  repository, and whether it allows host sessions.
- **UI-4** A topic's name shows the same everywhere, in the topic's own colour;
  clicking it opens a panel with its rendered status and linked tasks.
- **UI-5** The header counts the tasks waiting on you, on every page, and links
  to them.

## Agent interface

- **AGENT-1** Every running session opens on its session page as Tern's chat on
  omp. Only the gateway holds the session's Tern token, and only pages on that
  session's Tern host can open its socket.
- **AGENT-2** A session can be driven from the web UI without a terminal: its
  transcript with streaming replies, a prompt box, context usage, and its
  subagents.
- **AGENT-3** Prompts sent from the web UI and typed in Tern land in the same
  conversation, and each surface shows the other's.
- **AGENT-4** The web UI shows a reply and the model's thinking as they stream,
  and each command as running until it ends, before the turn ends; after a
  reload it shows the same conversation.
- **AGENT-5** A question the agent asks the user shows in the web UI with its
  options, while the session waits on the user.
- **AGENT-6** A tool result that lists files with the same name in different
  folders shows in the web UI, and so does the rest of the conversation after it.
- **AGENT-7** Text the agent writes in any script, and symbols and emoji, show in
  the chat in a font that has them.

## Deferred

Not claims yet: dependency graph between sessions, file-path locks, work
claims, moving a running session between machines, multi-machine scheduling,
offline local sessions, lease enforcement through credentials, Kubernetes.
