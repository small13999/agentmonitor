# Agent Monitor

The web app where people run coding agents on their projects: a board of tasks, task
pages, sessions (omp in a container or on the host, shown through Tern), and `am`, the
CLI agents use to reach the store. Agent Monitor is developed through Agent Monitor.

- `SPEC.md` is the contract: numbered claims, each proven by tests. `PLAN.md` is the
  order of work and decisions not yet written as claims. Read both before you change
  behavior.
- `server/` the gateway (store, sessions, runtimes, Tern proxy), `app/` the web app
  (React), `shared/api.ts` the wire types both use, `container/` what runs inside a
  session (entrypoints, `am`, the omp extension, session instructions), `tests/` the
  claims' tests and the harness.

## The spec

- A claim is `- **AREA-N** text`. IDs are never renumbered or reused; deleting a claim
  retires its ID in `spec.lock.json`.
- Claims change only with the user's approval. Do not invent claims; if work needs one,
  ask on the task (comment or status) and say what you would claim.
- Every claim gets a test: `spec("AREA-N", "title", fn)` from `tests/spec.ts`, through the
  real stack (`tests/harness.ts` starts a real gateway; the browser is Playwright). No
  tests of wiring, forwarding, or wording; no sleeps: wait for the event or the state.
- After changing claims or tests: `npm run spec:lock`, then `npm run spec:check`
  (0 errors; warnings are claims without tests).

## Code

- TypeScript, run directly by Node (type stripping): no `any`, no `ReturnType<typeof …>`,
  no `as` casts (narrow with type guards or zod), top-level `import type`,
  `Promise.withResolvers` instead of `new Promise`, no one-line wrapper functions.
- Validate input at the edges with zod (`server/store/http.ts`). The store API is one set
  of routes for people and agents (STORE-5); `am` is a thin client of it.
- Clean cutover: when behavior changes, change every caller and remove the old path; no
  compatibility shims.
- Type-check with `npx tsc -b`.

## Tests

- `node --test --test-timeout=90000 tests/<file>.test.ts` runs one file;
  `--test-name-pattern` narrows it. Run the files your change touches.
- `tests/session-container.test.ts` builds the session image and runs podman containers;
  `tests/host-session.test.ts` runs host sessions. Both take minutes.
- `npm test` runs everything (about 2 minutes); the integrator runs it before merging.

## Live instance

The main checkout (`~/projects/agentmonitor`) is what the user's live Agent Monitor runs:
the gateway restarts on every saved file under `server/`. Only the integrator (the
session in the main checkout) works there; every other session works in its own
worktree and pushes its task branch, and the integrator merges it.
