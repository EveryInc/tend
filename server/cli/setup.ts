import { print } from "./shared";

export function setupCodexCommand(): void {
  print(`Start one fresh Codex thread per feed and use this prompt:

Connect this Codex Desktop thread to local Attention.

Feed: inbox
Skill/reference: docs/SKILL.md

Use the Attention CLI contract from docs/SKILL.md. Bind this thread as the feed home thread with attention cli feed:bind, and create or update one heartbeat automation on this same thread. On each wakeup, inspect the feed, list queued work first, claim before using local connectors for queued instructions, execute and complete/fail/block/retry/cancel each claim through attention cli, verify approved external actions immediately before mutation, and refresh configured sources only when no queued work is being handled.
`);
}
