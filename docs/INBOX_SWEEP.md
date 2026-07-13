# Inbox Sweep

Inbox Sweep is Tend's Gmail-backed, Codex-native email review workflow. It is intentionally built
as a Tend feed instead of a separate model-backed application: Tend owns the local UI, workflow
state, approvals, audit history, and CLI while one dedicated Codex Desktop thread owns Gmail access
and judgment.

## Product Contract

- Every thread that is currently labeled Inbox becomes exactly one review card.
- Each card includes a plain-language brief, the authoritative full email thread, and a concrete
  proposed next action.
- Direct questions get an editable reply draft when the available evidence supports one.
- Decisions get specific preparation choices. FYI, promotional, completed, and low-value messages
  still get an individual card with an explicit cleanup action such as **Archive**.
- The active card is the default target for the persistent dock, so typing or dictating naturally
  queues work against that card.
- Sending, forwarding, archiving, or otherwise mutating Gmail requires the exact visible approval,
  a fresh digest check, and (for replies) an authenticated mailbox match.
- Every state transition is durable in the local Tend runtime and mirrored into readable files.

## Why Gmail Is The Provider

The app supports the provider choice requested for this build by using Gmail through Codex Desktop's
connector. Connector credentials remain in Codex Desktop and are never copied into Tend. A Cora
source can be substituted later by editing the Inbox source recipe through **Prompts & sources**;
the card, voice, approval, audit, and filesystem contracts do not depend on Gmail-specific UI code.

## Run It

From a packaged release:

```sh
./tend start
./tend health
./tend setup codex --feed inbox
```

From this source checkout:

```sh
pnpm install
pnpm start
pnpm tend -- setup codex --feed inbox
```

Open the printed local URL in Codex Desktop's in-app browser. Create one fresh Codex task for Inbox,
paste the complete setup prompt into it, and authorize the Gmail connector for the mailbox you want
to sweep. That task is the durable Inbox operator. Wake it at any time with:

```text
go deal with the feed
```

## Filesystem State

The runtime root defaults to `~/.attention/` and can be isolated with `ATTENTION_HOME`.

```text
ATTENTION_HOME/
  attention.db
  data/
    feeds/inbox/
      cards/*.json
      events.jsonl
      feed.md
      policy.md
      prompts/*.md
      raw/<run-id>/gmail-inbox/*.json
      runs/*.json
      sources/gmail-inbox.md
      sweeps/*.json
      work/*.json
```

SQLite is the transactional runtime authority. The `data/` tree is the readable mirror and evidence
trail that Codex and the user can inspect. Raw source snapshots are immutable. Cards, work receipts,
revisions, sweep decisions, and events are written through the same domain layer used by the UI.
Card JSON stores a bounded reference to each full email thread; the browser loads the immutable raw
snapshot only when the thread is expanded. Off-screen cards use browser content virtualization.

## End-To-End Validation

Use a disposable runtime so validation cannot touch a normal Tend workspace:

```sh
export ATTENTION_HOME="$(mktemp -d)/attention"
export ATTENTION_API_PORT=44332
pnpm build
trap 'pnpm tend -- stop >/dev/null 2>&1 || true' EXIT
pnpm tend -- start
```

Then perform these checks:

1. Run `pnpm tend -- health` and confirm the API reports healthy with the disposable data path.
2. Run `pnpm tend -- cli demo:seed --feed inbox` and open the Inbox feed in Codex Desktop's in-app
   browser. Bind the disposable operator lane before exercising the work queue:

   ```sh
   pnpm tend -- cli feed:bind --feed inbox --thread validation-inbox
   ```
3. Confirm seven deterministic email cards appear, including reply, judgment, delegation,
   scheduling, attachment, and low-attention archive cases.
4. Scroll through the feed. Confirm the active outline follows reading position; use `J` and `K` to
   move cards and `O` to expand or collapse a full email thread when present.
5. Edit a visible draft. Click its preparation action or submit a natural-language instruction in
   the dock, such as `Make this two sentences and ask for the deadline.`
6. Confirm the card moves from **To review** to **Queued for Codex** and that its queued note is
   editable. Use **Move back to review** once to validate cancellation and recovery.
7. Queue the instruction again. Run the complete operator sequence below, replacing the two values
   in angle brackets with the `id` and `capabilityToken` returned by `work:claim`. Confirm **End of
   this pass** reports one updated card. Start the next pass and confirm the card returns under
   **Back for review** with the Codex completion in its history.

   ```sh
   pnpm tend -- cli work:list --feed inbox --thread validation-inbox
   pnpm tend -- cli work:claim --feed inbox --thread validation-inbox
   pnpm tend -- cli work:complete --feed inbox --work <work-id> --token <capability-token> --result '{"response":"Validated the requested card update.","done":false}'
   ```
8. Inspect `data/feeds/inbox/events.jsonl`, the matching `cards/*.json`, and `work/*.json`. Confirm the
   user instruction, claim, completion, timestamps, and result are all durable and no capability
   token appears in the event or browser state.
9. For a real Gmail validation, authorize Gmail in the dedicated Inbox task, enumerate `in:inbox`
   through the terminal page, and write `snapshots.json`, `cards.json`, and `checkpoint.json`.
   Immediately after each list response, write its thread IDs to `page-thread-ids.json` and persist an
   immutable app-owned receipt. The first command mints a collection ID; pass it into every later page:

   ```sh
   pnpm tend -- cli sweep:record-inbox-page --feed inbox --source gmail-inbox --next-page-token <returned-token> --thread-ids-file page-thread-ids.json
   pnpm tend -- cli sweep:record-inbox-page --feed inbox --source gmail-inbox --collection <collection-id> --request-page-token <requested-token> --next-page-token <returned-token> --thread-ids-file page-thread-ids.json
   ```

   Omit `--request-page-token` for the first page and omit `--next-page-token` for the terminal page.
   If a persisted collection is wrong and cannot be finalized, abandon it explicitly before starting
   over; this writes an audit event and clears only that unfinalized receipt:

   ```sh
   pnpm tend -- cli sweep:abandon-inbox-collection --feed inbox --source gmail-inbox --collection <collection-id> --reason "Provider membership changed before snapshot fetch"
   ```

   Each snapshot must include a unique `threadId` and authoritative `threadText`;
   each card must use `sourceItemId: <threadId>` and `id: inbox-thread-<threadId>`, plus one full
   `email_thread`, a `proposedAction`, and at least one concrete action. Finalize through the
   invariant-enforcing command:

   ```sh
   pnpm tend -- cli sweep:finalize-inbox --feed inbox --source gmail-inbox --collection <collection-id> --snapshots-file snapshots.json --cards-file cards.json --checkpoint-file checkpoint.json
   ```

   Tend reconstructs the ordered ledger from immutable `inbox.page_collected` events and rejects broken
   token chains, repeated threads, nonterminal collections, or a source mismatch. Confirm the resulting sweep receipt has equal
   thread/card counts, a complete `threadCardMap`, and the preserved verified page chain.
10. Approve one harmless test mutation only if desired. Immediately before the connector call, run
    the full verification command below. Change the draft after approval once and confirm Tend
    rejects the stale approval instead of sending. Only after a successful verification and connector
    call should the work be completed.

    ```sh
    pnpm tend -- cli work:list --feed inbox --thread validation-inbox
    pnpm tend -- cli work:claim --feed inbox --thread validation-inbox
    pnpm tend -- cli action:verify --feed inbox --work <work-id> --token <capability-token> --mailbox owner@example.com
    pnpm tend -- cli work:complete --feed inbox --work <work-id> --token <capability-token> --result '{"response":"Verified the connector result.","done":true}'
    ```

The deterministic demo never accesses Gmail and is safe to repeat. A real-provider send or archive
is optional and must remain under the user's visible approval.
