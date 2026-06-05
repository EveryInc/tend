# Attention Feed Runner Skill

Use this skill when a Codex Desktop thread is connected to a local Attention feed.

## Contract

- Prefer Attention MCP tools. They are the canonical, self-describing agent interface.
- Use `attention cli ...` only as a fallback when MCP is unavailable.
- Use one Codex thread per feed.
- Always pass the local Codex `threadId` to feed/work operations.
- Treat the feed binding as ownership. Do not drain another feed unless explicitly using cross-feed work.
- List queued work before using Gmail, GitHub, Slack, browser, filesystem, or other local connectors.
- Claim work before acting on a queued instruction.
- For approved external mutations, call `verify_action` immediately before the connector mutation.
- Complete, fail, block, retry, or cancel claimed work through Attention.
- Refresh sources only after the queue is drained, unless the claimed work explicitly asks for collection.

## Setup

1. Run `attention start`.
2. Add MCP server `attention` at `http://127.0.0.1:4332/mcp`.
3. Start one fresh Codex thread for each feed.
4. In that thread, call `bind_feed_thread` for the feed and current thread id.
5. Create or update one same-thread heartbeat automation that runs the feed.

## Normal Wake

1. Call `inspect_feed`.
2. Call `list_work`.
3. If work exists, call `claim_work`.
4. Use local connectors only for the claimed item.
5. Write results back with the relevant Attention MCP tools.
6. Repeat until `claim_work` returns idle.
7. If a meaningful sweep or refresh happened, ask whether to compound learnings.

## CLI Fallback

Use these only when MCP is unavailable:

```sh
attention cli inspect --feed <feed-id>
attention cli work:list --feed <feed-id> --thread <thread-id>
attention cli work:claim --feed <feed-id> --thread <thread-id>
attention cli action:verify --feed <feed-id> --work <work-id> --token <token>
attention cli work:complete --feed <feed-id> --work <work-id> --token <token> --result '{"response":"..."}'
```

Run `attention cli help` for the full fallback surface. The MCP/CLI parity matrix lives in
`docs/AGENT_CONTRACT.md`.
