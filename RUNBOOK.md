# Feed Thread Runbook

Operate Attention through the canonical `attention` executable on `PATH`. The CLI and server share
runtime state under `~/.attention/` by default, including the SQLite authority database, readable
data mirrors, logs, and exports. A checkout may run the source scripts for development, but feed
threads should prefer the installed executable once it exists.

The live local app is owned by one CLI:

```bash
attention start --background
attention health
attention restart
attention stop
attention logs
```

It owns API/UI/MCP port `4332`, the live PID lock, and the live health check. Feed threads run
`attention health` before operating through the API or CLI. They never start servers, kill ports, or
choose worktrees themselves. For branch validation, use `attention validate`; it uses temporary
runtime state plus port `14333`.

Feed threads own their feed work end to end through the canonical API or CLI. When a feed pass
reveals a cross-app UX or code problem, record it without editing Tend product code from the feed
lane:

```bash
pnpm cli -- feedback:record \
  --feed <feed-id> \
  --title "<short pain point>" \
  --detail "<what happened, expected behavior, and useful card or sweep context>" \
  --source-thread <Codex-thread-id>
```

Then hand the same concise packet to the `Improve Tend workflow` thread. The improvement lane can
review the durable inbox with `pnpm cli -- feedback:list` and close landed fixes with
`pnpm cli -- feedback:resolve --feedback <id> --resolution "<what changed>"`.

## Runtime Handoff

When retiring an older checkout-local runtime, record the handoff immediately after the one-time
copy:

```bash
attention cli runtime:mark-handoff --legacy-home <retired-runtime-root>
```

If a feed lane was already mid-turn, inspect for late writes:

```bash
attention cli runtime:reconcile --legacy-home <retired-runtime-root>
attention cli runtime:reconcile --legacy-home <retired-runtime-root> --apply-missing
```

The apply pass copies only missing immutable evidence artifacts such as raw snapshots, runs, and
sweep batches. It reports cards, work items, policies, event ledgers, and conflicting mutable files
without overwriting live state. Carry reviewed mutable changes such as a late policy revision
forward through the canonical CLI. The handoff command marks the retired runtime root with its live
replacement and freezes the old tree read-only, including `attention.db` and `data/`. If a retired
checkout is accidentally restarted, it must not accept another approval, note, or card write.

## First Local Setup

When Codex starts this app on a Mac, check for Monologue before asking the user to configure
dictation:

```bash
pnpm cli -- setup:detect-monologue
```

If Monologue is installed, the command reads its local recording shortcut and persists the
browser-facing capability under ignored `~/.attention/data/integrations/dictation.json`. The dock then follows
that shortcut automatically when it is a supported single modifier. If Monologue is absent or its
custom shortcut is not yet supported, the command records that honestly and keeps the Inbox Sweep
Right Option fallback.

## Wake And Drain

When the user says `go deal with the feed`, use the exact feed and current thread ID:

```bash
pnpm cli -- work:list --feed <feed-id> --thread <thread-id>
pnpm cli -- work:claim --feed <feed-id> --thread <thread-id>
```

Process the claimed item from current state. When it is complete:

```bash
pnpm cli -- work:complete \
  --feed <feed-id> \
  --work <work-id> \
  --token <capability-token> \
  --result '{"response":"What changed, what happened, and any uncertainty."}'
```

For Inbox work, honor any `operatorGuidance.replyDraftSender` returned by `work:claim`. Default
reply drafts and revisions to the owner of `sourceMailbox`: preserve that person's voice and
signature unless the user's instruction explicitly changes sender. Never sign as an assistant or
delegate by default.

Before an external mutation, verify the exact current approved action or default cleanup immediately
before acting:

```bash
pnpm cli -- action:verify --feed <feed-id> --work <work-id> --token <capability-token>
```

Repeat claim until it returns the idle handshake. An active claimed item is replayed so restart
recovery stays simple and visible.

Before Codex claims a mistaken dictated note, correct it with `work:edit` or return its card to the
sweep with `card:return-to-review`. Returning a queued card cancels its unstarted local work. A done
card can be returned for another review pass, but this does not reverse an external action that
already happened.

## End Of Sweep

After a meaningful sweep or refresh reaches the idle handshake, always ask:

> Want me to compound what I learned from this sweep?

`Compound` means:

1. Review this sweep's cards, feedback, outcomes, and prior policy.
2. After the user agrees, queue `pnpm cli -- learning:request --feed <feed-id>`.
3. Drain the resulting `compound_learnings` job and return an editable policy proposal.
4. Never apply the proposal without user approval.

If the user asks to compound and search again, compound first. Recollect after the reviewed policy
proposal is applied, or after the user explicitly says to continue without applying it.

Do not repeat the question when a wake begins idle and no meaningful sweep or refresh happened in
the current turn.

Dock work includes its explicit `target` and `intent`. Interpret the utterance from current state:
write back cards, source changes, reranked sweeps, or a revision proposal as appropriate. Do not
treat broad natural-language dock input as a literal prompt edit.

## Collect

Read the effective recipe with:

```bash
pnpm cli -- inspect --feed <feed-id>
```

Use the connector, browser, computer-use workflow, local file, or source thread described by the
recipe. Preserve immutable retrieved evidence and record the completed run:

```bash
pnpm cli -- source:record-run \
  --feed <feed-id> \
  --source <source-id> \
  --snapshots '<json-array>' \
  --judgments '<json-array>' \
  --checkpoint '<json-object>'
```

For a claimed `recollect_sources` item, add `--work <claimed-recollection-work-id>` to each
`source:record-run` call. Do not pad. If nothing deserves attention, record an empty judgment set
and stop.

After the relevant sources have completed, record one judged sweep batch separately. A batch can
refer to multiple source runs:

```bash
pnpm cli -- sweep:record-batch --feed <feed-id> --runs '["<run-id>"]'
```

For a claimed `recollect_sources` item, add `--work <claimed-recollection-work-id>`. This binds the
judged batch to the work item and requires each referenced run to carry the same lineage.

For claimed scoped sweep-feedback work, rejudge the visible card IDs from its trace and write back
the explicit kept order and removed IDs. Only this claimed-work write-back may reorder or hide cards:

```bash
pnpm cli -- sweep:rejudge \
  --feed <feed-id> \
  --feedback <feedback-id> \
  --ordered-cards '["<kept-card-id>"]' \
  --removed-cards '["<removed-card-id>"]'
```

The ledger refuses to complete `sweep_rejudge` work until that feedback trace has a recorded
rejudgment. If a newer sweep batch supersedes a claimed trace, `sweep:rejudge` automatically marks
the old item `stale` so the feed lane can keep draining. The ledger also refuses to complete
`recollect_sources` work until a new sweep batch has been recorded for that claimed recollection
work item. Referenced source runs must already exist in the same feed. Recollection batches must
use source runs recorded for the same claimed work item.

For an existing local JSON artifact, import it without passing private payload text through the
shell:

```bash
pnpm cli -- source:import-json-file --feed <feed-id> --source <source-id> --path <local-file>
```

Use `source:import-file` for local text or JSONL artifacts.

Commit a judged card with structured blocks through a file-backed payload. Do not interpolate
structured card JSON into the shell: card prose can contain backticks, dollar signs, and other
shell-significant text.

```bash
pnpm cli -- card:upsert --feed <feed-id> --card-file <local-json-file>
```

Card block payloads are validated before Tend writes them. Use `text` for `memo` and `receipt`
blocks, `items` for `evidence`, `options`, and `checklist`, and Markdown link syntax inside receipt
text. For comparative cohort metrics, prefer one compact two-series `chart` block:

```json
{
  "id": "d1-retention",
  "type": "chart",
  "label": "D1 retention",
  "chart": {
    "unit": "%",
    "max": 100,
    "series": [{ "label": "Came back" }, { "label": "Worked again" }],
    "rows": [{ "label": "Jun 1", "values": [23, 13] }],
    "note": "Worked again is the healthier KPI."
  }
}
```

During migration only, an explicitly selected provenance-bearing card from the old Attention
Workbench can be converted into the new block format:

```bash
pnpm cli -- legacy:import-attention-card --feed company-attention --path <batch-json> --card-id <id>
```

For parallel Inbox migration, explicitly selected current Inbox Sweep cards can be converted while
Inbox Sweep remains authoritative:

```bash
pnpm cli -- legacy:import-inbox-card --feed inbox --path <current-brief-json> --card-id <id>
```

## Learn

After meaningful feedback, revise `policy.md` only for small feed-specific improvements. Keep it
compact. Structural changes, new permissions, prompt edits, source changes, and global lessons
become explicit proposal cards:

```bash
pnpm cli -- proposal:create --feed <feed-id> --title "..." --brief "..." --instruction "..."
```

For a prompt, recipe, feed-policy, or global-policy diff that should appear in the browser approval
stack, write the actual proposed content rather than appending the user's raw instruction:

```bash
pnpm cli -- revision:propose \
  --feed <anchor-feed-id> \
  --target '{"kind":"prompt_layer","feedId":"<feed-id>","promptId":"judge.md"}' \
  --instruction "Why this change is proposed" \
  --content "<complete proposed markdown>"
```

`action:verify` is mandatory operator procedure before external connector mutation for both approved
actions and default cleanup. The app enforces the digest again when work completes, but this
prototype does not yet wrap connector tools in a capability-scoped executor. Do not describe direct
connector mutation as mechanically prevented.
