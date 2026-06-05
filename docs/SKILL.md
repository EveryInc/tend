# Attention Feed Runner Skill

Use this skill when a Codex Desktop thread is connected to a local Attention feed.

## Contract

- Use the local `attention` binary and its JSON CLI.
- Use one Codex thread per feed.
- Always pass the local Codex `threadId` to feed/work operations.
- Treat the feed binding as ownership. Do not drain another feed unless explicitly using cross-feed work.
- List queued work before using Gmail, GitHub, Slack, browser, filesystem, or other local connectors.
- Claim work before acting on a queued instruction.
- For approved external mutations, call `attention cli action:verify` immediately before the connector mutation.
- Complete, fail, block, retry, or cancel claimed work through `attention cli`.
- Refresh sources only after the queue is drained, unless the claimed work explicitly asks for collection.

## Setup

1. Run `attention start`.
2. Start one fresh Codex thread for each feed.
3. Bind the thread:

   ```sh
   attention cli feed:bind --feed <feed-id> --thread <thread-id>
   ```

4. Create or update one same-thread heartbeat automation that runs the feed.

## Normal Wake

1. Inspect the feed:

   ```sh
   attention cli inspect --feed <feed-id>
   ```

2. List work:

   ```sh
   attention cli work:list --feed <feed-id> --thread <thread-id>
   ```

3. If work exists, claim one item:

   ```sh
   attention cli work:claim --feed <feed-id> --thread <thread-id>
   ```

4. Use local connectors only for the claimed item.
5. Write results back through the relevant `attention cli` command.
6. Repeat until `work:claim` returns idle.
7. If a meaningful sweep or refresh happened, ask whether to compound learnings.

## Completing Work

```sh
attention cli action:verify --feed <feed-id> --work <work-id> --token <token>
attention cli work:complete --feed <feed-id> --work <work-id> --token <token> --result '{"response":"..."}'
```

Use `work:fail`, `work:block`, `work:retry`, or `work:cancel` when completion is not appropriate.
Run `attention cli help` for the full command surface.
