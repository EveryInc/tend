# Architecture

Attention is a local-first Codex-native app. The local executable owns the UI, HTTP API, MCP server, realtime event stream, and local state. Codex Desktop remains the agent runtime and uses local MCP tools to inspect feeds, claim work, use local connectors, and write results back.

## Runtime

```text
attention executable
  ├─ Hono HTTP API
  ├─ Streamable HTTP MCP endpoint at /mcp
  ├─ SSE realtime endpoint at /api/events
  ├─ React UI
  ├─ local SQLite metadata
  └─ local feed state
```

The current domain model still stores rich feed artifacts in readable local files. SQLite is introduced as the durable local metadata and migration anchor; active feed membership is now behind a repository interface with SQLite as the runtime authority and `workspace.json` as a backup-compatible mirror.

## Boundaries

- `server/domain.ts` owns product behavior and invariants.
- `server/store.ts` owns current local feed persistence.
- `server/repositories/` owns typed persistence interfaces and adapters.
- `server/runtime.ts` composes SQLite-backed repositories with filesystem mirrors for local execution.
- `server/mcp.ts` adapts domain behavior to MCP tools, prompts, and resources.
- `server.ts` composes local route modules and starts Bun.
- `server/routes/api.ts` owns browser-facing Hono API routes.
- `server/routes/realtime.ts` owns the SSE event stream.
- `server/routes/assets.ts` owns built UI asset serving.
- `attention.ts` is the human-facing CLI entrypoint.
- `cli.ts` remains the low-level operator command surface.
- `src/router.tsx` owns UI routes such as `/feed/:feedId`, prompt workspaces, and learning review.
- TanStack Query owns workspace fetching and invalidation.
- `src/state/realtime.tsx` hides SSE details behind a provider.
- `src/App.tsx` is the route-level orchestrator for query state, keyboard shortcuts, and mutations.
- `src/feed/` owns feed selectors, card rendering, and routine action rendering.
- `src/workspace/` owns prompt/source editing and learning review surfaces.
- `src/shell/` owns top navigation, the inspector modal, and the voice/work dock.

## Agent Model

Each feed has one home Codex thread. The home thread claims work before using Gmail, GitHub, Slack, browser, files, or other local connectors. The local app stores recipes and workflow state; connector credentials stay in Codex Desktop.

## Realtime

Realtime is intentionally simple:

```text
mutation commits
→ /api/events emits change
→ RealtimeProvider invalidates TanStack Query
→ UI refetches workspace state
```

No patch stream is required for v0.
