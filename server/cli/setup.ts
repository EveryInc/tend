import { mcpUrl, print } from "./shared";

export function setupCodexCommand(): void {
  print(`Add this MCP server to Codex Desktop:

Name: attention
URL: ${mcpUrl()}

Then start one fresh Codex thread per feed and use this prompt:

Connect this Codex Desktop thread to local Attention.

MCP server: ${mcpUrl()}
Feed: inbox

Inspect the feed, bind this thread as the feed home thread with bind_feed_thread, and create or update one heartbeat automation on this same thread. On each wakeup, inspect the feed, list queued work first, claim before using local connectors for queued instructions, execute and complete/fail/block/retry/cancel each claim through Attention MCP, verify approved external actions immediately before mutation, and refresh configured sources only when no queued work is being handled.
`);
}
