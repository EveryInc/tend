# Feed Thread Runbook

Operate Tend through the canonical `tend` executable on `PATH`. The CLI and server share
runtime state under `~/.attention/` by default, including the SQLite authority database, readable
data mirrors, logs, and exports. Source development uses the same command tree through
`pnpm tend --`; it also defaults to `~/.attention/`, so a future packaged binary reuses the same
data. Worktree or branch validation must set `ATTENTION_HOME=<tmp>` explicitly.

When UI code changed in a source checkout, run `pnpm build` before restarting the canonical service.
The packaged binary already ships its matching built assets.

The live local app is owned by one CLI:

```bash
tend start
tend health
tend restart
tend stop
tend logs
```

It owns API/UI port `4332`, the live PID lock, and the live health check. Feed threads run
`tend health` before operating through the API or CLI. They never start servers, kill ports, or
choose worktrees themselves. Use `tend doctor` for diagnostics. Use `ATTENTION_HOME=<tmp>`
with `tend start --foreground` when validating a branch against isolated runtime state.

Feed threads own their feed work end to end through the canonical API or CLI. When a feed pass
reveals a cross-app UX or code problem, record it without editing Tend product code from the feed
lane:

```bash
tend cli feedback:record \
  --feed <feed-id> \
  --title "<short pain point>" \
  --detail "<what happened, expected behavior, and useful card or sweep context>" \
  --source-thread <Codex-thread-id>
```

Then hand the same concise packet to the `Improve Tend workflow` thread. The improvement lane can
review the durable inbox with `tend cli feedback:list` and close landed fixes with
`tend cli feedback:resolve --feedback <id> --resolution "<what changed>"`.

## First Local Setup

When Codex starts this app on a Mac, check for Monologue before asking the user to configure
dictation:

```bash
tend cli setup:detect-monologue
```

If Monologue is installed, the command reads its local recording shortcut and persists the
browser-facing capability under ignored `~/.attention/data/integrations/dictation.json`. The dock then follows
that shortcut automatically when it is a supported single modifier. If Monologue is absent or its
custom shortcut is not yet supported, the command records that honestly and keeps the Inbox Sweep
Right Option fallback.

## Wake And Drain

When the user says `go deal with the feed`, use the exact feed and current thread ID:

```bash
tend cli work:list --feed <feed-id> --thread <thread-id>
tend cli work:claim --feed <feed-id> --thread <thread-id>
```

Always run `work:claim` at least once after `work:list`; it replays any in-flight item for your
lane after a restart.

Process the claimed item from current state. When it is complete:

```bash
tend cli work:complete \
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
tend cli action:verify --feed <feed-id> --work <work-id> --token <capability-token>
```

Repeat claim until it returns the idle handshake. An active claimed item also appears in `work:list`
for its own lane and is replayed by `work:claim`, so restart recovery stays simple and visible.

Before Codex claims a mistaken dictated note, correct it with `work:edit` or return its card to the
sweep with `card:return-to-review`. Returning a queued card cancels its unstarted local work. A done
card can be returned for another review pass, but this does not reverse an external action that
already happened.

## Claude Lane

Feeds can route work to a Claude Code session alongside the Codex home thread. The routing is
explicit: a per-item `assignee` set from the dock's route-to-Claude toggle, or the feed-level
drain agent (`tend cli feed:drain-agent --feed <feed> --agent claude`). Work is lane-scoped
at claim time, so the two lanes never see each other's items.

- The Claude session is woken by ledger lines in `data/agents/claude/wake.jsonl` and operates
  under `docs/CLAUDE_THREAD.md`.
- The TopBar chip shows the Claude lane's liveness (live / stale / offline) from its presence
  heartbeat. Routing to Claude while offline parks the work visibly; the queued strip offers
  `Reassign to Codex`, and returning presence replays wakes for still-queued items.
- A claimed item stuck with a dead session can be recovered by any successor session holding the
  same lane id (claim replay), or returned to the queue with
  `tend cli work:release --feed <feed> --work <work> --token <token>`. Rebinding the lane
  (`tend cli feed:bind --feed <feed> --agent claude --replace`) mints a new lane id and
  fences out old sessions.

## End Of Sweep

After a meaningful sweep or refresh reaches the idle handshake, always ask:

> Want me to compound what I learned from this sweep?

`Compound` means:

1. Review this sweep's cards, feedback, outcomes, and prior policy.
2. After the user agrees, queue `tend cli learning:request --feed <feed-id>`.
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
tend cli inspect --feed <feed-id>
```

The inspection includes the current prompt-safe `mindContext`. If it is fresh:

- Use `lens` when a signal should focus normal source queries, ranking, or framing.
- Use `research` when a feed-relevant signal raises one bounded question and the feed's configured
  source permissions allow that research.
- Never treat the context summary or Chronicle excerpts as evidence for the answer.
- Ignore context that does not fit the feed lane. A no-effect sweep is correct.

Use the connector, browser, computer-use workflow, local file, or source thread described by the
recipe.

For Inbox, do not use the general source-run and batch commands below. Enumerate every `in:inbox`
provider page and immediately persist each response with `sweep:record-inbox-page`; pass its
app-minted collection ID into the next page. For claimed recollection, include `--work <work-id>` on
every page receipt. Then call `sweep:finalize-inbox --collection <id>` with the complete snapshots,
cards, and checkpoint (and the same `--work` when claimed). Tend reconstructs the immutable page
ledger and activates coverage atomically. If a persisted receipt is wrong, use
`sweep:abandon-inbox-collection --collection <id> --reason <text>` before restarting collection;
the abandonment is durable and audited.

For all other feeds, preserve immutable retrieved evidence and record the completed run:

```bash
tend cli source:record-run \
  --feed <feed-id> \
  --source <source-id> \
  --snapshots '<json-array>' \
  --judgments '<json-array>' \
  --checkpoint '<json-object>'
```

When context influenced a run, write the context use to a local JSON file and pass it without shell
interpolation:

```json
{
  "updateId": "mind_...",
  "mode": "research",
  "signalIds": ["paywall"],
  "researchQuestion": "What evidence-backed paywall improvements fit Every?"
}
```

```bash
tend cli source:record-run \
  --feed <feed-id> \
  --source <source-id> \
  --snapshots '<json-array>' \
  --judgments '<json-array>' \
  --checkpoint '<json-object>' \
  --context-use-file <local-json-file>
```

For a claimed non-Inbox `recollect_sources` item, add `--work <claimed-recollection-work-id>` to each
`source:record-run` call. Do not pad. If nothing deserves attention, record an empty judgment set
and stop.

After the relevant non-Inbox sources have completed, record one judged sweep batch separately. A batch can
refer to multiple source runs:

```bash
tend cli sweep:record-batch \
  --feed <feed-id> \
  --runs '["<run-id>"]' \
  --context <mind-update-id>
```

For a claimed `recollect_sources` item, add `--work <claimed-recollection-work-id>`. This binds the
judged batch to the work item and requires each referenced run to carry the same lineage.

For claimed scoped sweep-feedback work, rejudge the visible card IDs from its trace and write back
the explicit kept order and removed IDs. Only this claimed-work write-back may reorder or hide cards:

```bash
tend cli sweep:rejudge \
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
tend cli source:import-json-file --feed <feed-id> --source <source-id> --path <local-file>
```

Use `source:import-file` for local text or JSONL artifacts.

Commit a judged card with structured blocks through a file-backed payload. Do not interpolate
structured card JSON into the shell: card prose can contain backticks, dollar signs, and other
shell-significant text.

```bash
tend cli card:upsert --feed <feed-id> --card-file <local-json-file>
```

Card block payloads are validated before Tend writes them. Use `text` for `memo` and `receipt`
blocks, `items` for `evidence`, `options`, and `checklist`, and Markdown link syntax inside receipt
text. An `email_thread` block must contain the authoritative source email, including `From:`,
`To:`, and `Subject:` headers; use a `memo` block for a summary. For comparative cohort metrics,
prefer one compact two-series `chart` block:

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

For source-backed cards created from a sweep, include the source run IDs that supplied the evidence:

```json
{
  "id": "gmail-thread-example",
  "sourceRunIds": ["run_current_sweep"]
}
```

If context materially selected, prioritized, or reframed the card, add a distinct receipt:

```json
{
  "contextInfluence": {
    "updateId": "mind_...",
    "signalIds": ["paywall"],
    "mode": "research",
    "effect": "selected",
    "summary": "Prompted by the active paywall diagnosis.",
    "researchQuestion": "What evidence-backed paywall improvements fit Every?"
  }
}
```

Research-mode receipts require a matching research source run. Lens-mode receipts require the same
context update to be pinned to the current sweep. Tend rejects source-free or mismatched receipts.

Tend rejects card writes and generated card actions when those source runs are no longer part of the
current sweep batch. If a newer Gmail or Cora sweep changes the underlying truth, refresh sources and
rewrite the card from the current batch instead of replaying an older source snapshot.

For conservative batched cleanup, write one current routine group instead of several competing
approval groups:

```bash
tend cli routine:upsert --feed <feed-id> --group '<json-object>'
```

Recording a newer sweep batch or a newer proposed routine group automatically marks older unapproved
routine groups `stale` and releases any old-only cards back to review. Carry forward only still-valid
items in the new group payload; do not hand-edit routine group JSON to hide stale approvals.

During migration only, an explicitly selected provenance-bearing card from the old Tend
Workbench can be converted into the new block format:

```bash
tend cli legacy:import-attention-card --feed company-attention --path <batch-json> --card-id <id>
```

For parallel Inbox migration, explicitly selected current Inbox Sweep cards can be converted while
Inbox Sweep remains authoritative:

```bash
tend cli legacy:import-inbox-card --feed inbox --path <current-brief-json> --card-id <id>
```

## Learn

After meaningful feedback, revise `policy.md` only for small feed-specific improvements. Keep it
compact. Structural changes, new permissions, prompt edits, source changes, and global lessons
become explicit proposal cards:

```bash
tend cli proposal:create --feed <feed-id> --title "..." --brief "..." --instruction "..."
```

For a prompt, recipe, feed-policy, or global-policy diff that should appear in the browser approval
stack, write the actual proposed content rather than appending the user's raw instruction:

```bash
tend cli revision:propose \
  --feed <anchor-feed-id> \
  --target '{"kind":"prompt_layer","feedId":"<feed-id>","promptId":"judge.md"}' \
  --instruction "Why this change is proposed" \
  --content "<complete proposed markdown>"
```

`action:verify` is mandatory operator procedure before external connector mutation for both approved
actions and default cleanup. The app enforces the digest again when work completes, but this
prototype does not yet wrap connector tools in a capability-scoped executor. Do not describe direct
connector mutation as mechanically prevented.
