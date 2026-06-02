---
name: hosted-attention-agent
description: Use when a Codex Desktop thread needs to connect to a hosted Attention feed, bind itself as the feed's home thread, and drain feed work through MCP.
---

# Hosted Attention Agent

Use this skill when working with a hosted Attention feed from Codex Desktop.

## Setup

1. Connect this Codex thread to the hosted Attention MCP server shown in the app's Agents page.
2. Open the target feed in the hosted UI.
3. Bind this local Codex thread to that feed with the `bind_feed_thread` MCP tool.
4. Create or update one heartbeat automation on this same thread to run the feed loop on the cadence shown in the app.
5. Use the `run_feed` MCP prompt or the tools below to refresh sources, inspect, claim, complete, and fail work.

## Operating Rules

- Always send the local Codex `threadId` when listing or claiming feed work.
- Treat the feed's `homeThreadId` as the owner. Use cross-feed mode only when the user explicitly asks.
- Before external mutation, call `verify_action` for approved action work.
- Treat queued work as the primary loop. If `list_work` returns queued items, call `claim_work` before using Gmail, Slack, GitHub, browser, file, or other local connectors for that instruction.
- Complete claimed work with the scoped capability token returned by `claim_work`.
- When the claimed instruction closes, ignores, dismisses, or confirms an item is already handled, update the card to `done` and include `done: true` in `complete_work`.
- Fail work with a clear error if local connectors, credentials, or evidence are missing.
- Do not invent external source access. Hosted Attention stores recipes; connector access lives in the local Codex runtime.
- Keep source refresh and queue execution in the same feed-bound thread unless the user explicitly asks for a different topology.
- Source collection is read-only by default. External mutations happen only through claimed, approved work and immediate verification.

## Feed Runner Automation

Create or update a heartbeat automation targeting this same thread. The default cadence is every 30 minutes unless the feed setup says otherwise.

On each wakeup:

1. Confirm the thread is still bound to the feed.
2. Read the feed setup/state and configured source recipes.
3. List queued work for this feed and thread.
4. If queued work exists, claim one item before doing any connector-backed work for that instruction.
5. Execute the claimed item with local tools/connectors, upserting result cards or updating cards only after the claim is held.
6. Call `verify_action` immediately before any approved external mutation.
7. Complete or fail the claim with evidence and uncertainty.
8. Repeat claim/execute/complete until `claim_work` returns null or the small-batch limit is reached.
9. Only when no queued work is being handled, refresh configured sources opportunistically, upsert useful cards with clear provenance, and record source runs/checkpoints when the evidence supports it.

## Core Tools

- `inspect_feed`
- `bind_feed_thread`
- `list_work`
- `claim_work`
- `verify_action`
- `complete_work`
- `fail_work`
- `upsert_card`
- `record_source_run`
- `update_feed_policy`
- `add_source_recipe`
- `update_source_recipe`
- `update_global_policy`
- `update_prompt_layer`

## Default Loop

Inspect the feed, then list queued work. If work is queued, claim the next item before using local connectors or upserting cards for that instruction. Do the claimed work using local Codex tools/connectors, verify approved external actions immediately before mutation, complete or fail the claim, and repeat until no claim is returned. Refresh configured sources opportunistically only after the queue is drained or when the claimed item explicitly asks for source collection.
