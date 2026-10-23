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

Moved into SPEC.md (`c55171c`). Still to do there when its slices land: retire
TASK-8 (notes), CARD-2 (last messages on the card), and CARD-5 (duplicate of
BOARD-2). Not claims: type, accent, colours, avatars, motion; a clickable prototype
comes first, and the user picks before it is built in.

## Step 5: hub on Hetzner

Moved into SPEC.md: AUTH-1..3, HOST-1/2, STORE-3, PREVIEW-2, STORE-6.

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

Moved into SPEC.md: AUTO-1/2/7 changed, AUTO-8..15 new, SESSION-5 changed,
AUTO-3..6 retired. REVIEW-1..3 (inbox) stay.

First automation (draftcoach, set up with `am automation` once built): "Patch
review". A schedule every 15 minutes; no guard; a check that reads Riot
Phroxzon's posts and answers yes when there is a patch preview or an update newer
than the one in `memory.md`. The run updates the patch preview pages (all
locales, as Patch 26.21 was done by hand: `web/src/data/patch-notes`,
`web/tools/patch-cards/specs`) and renders the social cards into
`runs/<run>/`. End mode Wait for review.

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
