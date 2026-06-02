# Feed Thread Runbook

## First Local Setup

When Codex starts this app on a Mac, check for Monologue before asking the user to configure
dictation:

```bash
pnpm cli -- setup:detect-monologue
```

If Monologue is installed, the command reads its local recording shortcut and persists the
browser-facing capability under ignored `data/integrations/dictation.json`. The dock then follows
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

Before an external mutation, verify the exact current approved action or default cleanup immediately
before acting:

```bash
pnpm cli -- action:verify --feed <feed-id> --work <work-id> --token <capability-token>
```

Repeat claim until it returns `null`. An active claimed item is replayed so restart recovery stays
simple and visible.

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
rejudgment. It also refuses to complete `recollect_sources` work until a new sweep batch has been
recorded for that claimed recollection work item. Referenced source runs must already exist in the
same feed. Recollection batches must use source runs recorded for the same claimed work item.

For an existing local JSON artifact, import it without passing private payload text through the
shell:

```bash
pnpm cli -- source:import-json-file --feed <feed-id> --source <source-id> --path <local-file>
```

Use `source:import-file` for local text or JSONL artifacts.

Commit a judged card with structured blocks:

```bash
pnpm cli -- card:upsert --feed <feed-id> --card '<json-card>'
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
