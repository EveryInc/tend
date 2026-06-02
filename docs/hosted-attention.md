# Hosted Attention Architecture

The hosted variant keeps Codex Desktop as the only agent runtime. Cloudflare stores feed state, account references, prompt/policy configuration, and realtime display state; local Codex threads still do source collection, connector access, approvals, and external mutations.

## Runtime Shape

- `src/hosted/worker.ts` composes the Worker and mounts route modules.
- `src/hosted/routes/api.ts` exposes the browser-compatible Hono API under `/api`.
- `src/hosted/routes/realtime.ts` exposes feed WebSocket routing under `/api/events/ws`.
- `src/hosted/routes/auth.ts` exposes Better Auth and OAuth provider metadata.
- `src/hosted/routes/mcp.ts` exposes the MCP endpoint used by Codex Desktop.

## Storage Model

- `AccountDO` stores account-level user data: global policy, prompt layers, and the ordered feed list.
- `FeedDO` stores feed-level user data: policy, source recipes, cards, work queue, runs, checkpoints, thread binding, and feed events.
- D1 is only the control plane. Better Auth owns its auth tables (`user`, `account`, `session`, verification/JWKS/OAuth tables), and Attention adds only feed ownership/DO references.
- Source recipes are stored in feed state. External connector credentials and source execution remain local to the Codex Desktop thread.

## Agent Model

Each feed has one explicit `thread.homeThreadId`, which is the local Codex Desktop thread id. MCP tools require the caller to provide that thread id when listing or claiming work, unless the caller explicitly opts into cross-feed mode.

The hosted environment cannot wake a Codex thread by itself. The local thread automation is responsible for polling/claiming feed work through MCP on its own cadence.

Each feed should normally have one local feed-runner thread and one heartbeat automation. On every wakeup, that same thread inspects the feed, lists queued work, and claims before using local connector access for a queued instruction. It executes the claimed item, writes result cards with provenance only after holding the claim, and completes or fails the claim with evidence. Opportunistic source refresh happens after the queue is drained or when the claimed work explicitly asks for collection. Keeping source refresh and queue execution in one bound thread avoids scheduler races while the feed's Durable Object remains the source of truth for queue leases and state.

When connecting a new feed, start from a fresh or dedicated Codex thread, authenticate the hosted `attention` MCP server with `attention:read` and `attention:write`, bind that thread with `bind_feed_thread`, and install/update one heartbeat automation targeting the same thread. If OAuth succeeds but the `mcp__attention` tools are not visible, create a fresh thread after the OAuth refresh and continue setup there; tool exposure is resolved at thread startup in Codex Desktop.

## Local Commands

```sh
pnpm hosted:migrate
pnpm hosted:dev
pnpm hosted:types
pnpm hosted:build
```

`pnpm hosted:migrate` applies the local D1 migrations. For deployment, use `pnpm hosted:migrate:remote` before publishing the Worker.

The normal prototype build still uses:

```sh
pnpm test
pnpm build
```
