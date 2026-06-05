# Architecture

Attention is a local-first Codex-native app. The local executable owns the UI, HTTP API, realtime event stream, JSON CLI, and local state. Codex Desktop remains the agent runtime and uses the local CLI to inspect feeds, claim work, use local connectors, and write results back.

## Runtime

```mermaid
flowchart LR
  Thread["Codex feed thread"] --> CLI["attention cli"]
  CLI --> Domain["Domain invariants"]
  UI["React UI"] --> API["Hono HTTP API"]
  API --> Domain
  Domain --> SQLite["SQLite authority"]
  SQLite --> Mirrors["Readable file mirrors"]
  Domain --> SSE["/api/events"]
  SSE --> UI
  Thread --> Connectors["Codex Desktop connectors"]
```

The current domain model keeps the richest authoring artifacts readable in local file mirrors while moving active runtime records into SQLite. Active feed membership, editable prompt/policy documents, feed cards, routine action groups, source recipes/checkpoints, source run records, sweep state/artifacts, revision records, feed audit events, and work items are now behind repository interfaces with SQLite as the runtime authority and readable files as backup-compatible mirrors.

The installed `attention` executable is the canonical runtime entrypoint. `attention start`
re-launches the same executable in the background with the current `PATH`, `ATTENTION_HOME`, and
port settings. `attention start --foreground` keeps the server attached to the current terminal.
There is no separate runner or second CLI.

## Boundaries

- `server/domain.ts` owns product behavior and invariants.
- `server/store.ts` owns current local feed persistence.
- `server/repositories/` owns typed persistence interfaces and adapters.
- `server/runtime.ts` composes SQLite-backed repositories with filesystem mirrors for local execution.
- `server.ts` composes local route modules and starts Bun.
- `server/routes/api.ts` owns browser-facing Hono API routes.
- `server/routes/realtime.ts` owns the SSE event stream.
- `server/routes/assets.ts` owns built UI asset serving.
- `attention.ts` is the tiny human-facing CLI executable shim.
- `server/cli/` owns human-facing CLI commands for start, status, doctor, setup, backup, and legacy operator delegation.
- `cli.ts` remains the low-level operator command surface.
- `src/router.tsx` owns UI routes such as `/feed/:feedId`, prompt workspaces, and learning review.
- TanStack Query owns workspace fetching and invalidation.
- `src/state/realtime.tsx` hides SSE details behind a provider.
- `src/App.tsx` is the route-level orchestrator for query state, keyboard shortcuts, and mutations.
- `src/feed/` owns feed selectors, card rendering, and routine action rendering.
- `src/workspace/` owns prompt/source editing and learning review surfaces.
- `src/shell/` owns top navigation, the inspector modal, and the voice/work dock.

## Agent Model

Each feed has one home Codex thread. The home thread claims work through `attention cli` before using Gmail, GitHub, Slack, browser, files, or other local connectors. The local app stores recipes and workflow state; connector credentials stay in Codex Desktop.

## Realtime

Realtime is intentionally simple:

```text
mutation commits
→ /api/events emits change
→ RealtimeProvider invalidates TanStack Query
→ UI refetches workspace state
```

No patch stream is required for v0.
