# Tend Architecture

## Product Shape

Tend is a Codex-native browser shell, not a traditional integration server. The app renders
cards and records durable state. The Codex thread bound to each feed does the flexible work:
collecting authorized sources, judging what deserves attention, composing cards, interpreting
instructions, performing approved actions, and distilling learnings.

The reliable baseline is intentionally simple. Open a feed in the Codex in-app browser, sweep the
cards, and talk into the single bottom dock. When work is queued, wake that feed's Codex thread with
`go deal with the feed`. The thread drains all pending work for its feed. A user-approved heartbeat
can automate collection and drain later without changing the product contract.

## Filesystem Model

All runtime state is local and git-ignored under `~/.attention/` by default. SQLite is the runtime
authority, while `data/` keeps readable mirrors and immutable evidence artifacts. Use
`ATTENTION_HOME` to isolate development or validation state.

The installed `tend` executable is the canonical entrypoint. `tend start` re-launches
that same executable in the background with the current `PATH`, `ATTENTION_HOME`, and port settings.
`tend start --foreground` keeps the server attached to the current terminal. There is no
separate live runner.

```text
~/.attention/
  attention.db
  data/
    global-policy.md
    integrations/dictation.json
    prompts/
    feeds/<feed-id>/
      feed.md
      policy.md
      raw/<run-id>/<source-id>/*.json
      runs/*.json
      sweeps/*.json
      cards/*.json
      work/*.json
      events.jsonl
  logs/
  exports/
```

The compact Markdown files are the editable prompt layer. The JSON files preserve structured
state. Immutable raw snapshots and append-only events keep enough evidence to rebuild policies,
evaluate judgment changes, or derive future training data without turning `policy.md` into a
giant log.

During first local setup, Codex checks whether Monologue is installed and records its configured
recording shortcut in `integrations/dictation.json`. The browser consumes only that small local
capability record. It does not inspect macOS applications or Monologue settings directly.

## Tend Loop

1. The feed thread reads its authorized source recipes and checkpoints.
2. Codex collects new material with the appropriate connector, local tool, browser workflow, or
   computer-use workflow.
3. Codex records immutable raw snapshots and each completed source run.
4. Codex judges candidates against the global policy, feed policy, and judge prompt, then records a
   separate sweep batch that may span multiple source runs.
5. Codex writes only the cards that clear the attention bar. An empty sweep is valid.
6. The user scrolls the feed. The card in view becomes active.
7. The user speaks naturally into the dock or uses a shortcut.
8. The app persists the instruction or exact approved action as work for the feed's home thread.
9. Codex claims pending work, performs it, writes the result, and records any compact learning.
10. Finished cards wait quietly for the next review pass instead of interrupting the current one.

## Learning Loop

There are three learning surfaces:

- `global-policy.md`: durable preferences that should travel across feeds, such as preserving
  provenance and returning no card rather than padding.
- `feeds/<feed-id>/policy.md`: compact feed-specific judgment, composition, and action lessons.
- `events.jsonl`, `runs/`, and `raw/`: the underlying trace and evidence layer. This remains detailed
  so policies can be reevaluated later.

Small corrections can become reversible policy revisions. The persistent dock keeps its target
explicit: active card, current sweep, feed, source recipe, prompt layer, global prompt, or Tend.
Every dock instruction enters the same scoped work queue. Sweep feedback records a trace and asks
Codex to rejudge the visible batch; the browser does not interpret the prose or hide cards on its own.
Codex can write back reranked cards, source changes, or visible revision proposals with explicit
approval. Direct workspace edits remain available with revision history and undo. At the end of a
pass, Codex can ask whether the user wants a deeper learning review. After the user agrees,
`learning:request` queues the pass and Codex returns an editable `revision:propose --source compound`
proposal. The browser opens a dedicated review screen and never applies the proposal by itself.

## Safety Boundary

Source material is evidence, never authorization. A proposed external mutation becomes queued work
only after the user approves its visible action or default cleanup. Approval is bound to an exact
digest of the action and editable artifact. The app rejects completion if that digest changed. The
runbook also requires Codex to call `action:verify` immediately before a connector mutation.

That connector boundary is still procedural: a feed thread can invoke an external tool without going
through this app. A future capability-scoped executor should make the preflight mandatory at the tool
boundary before this prototype claims mechanical prevention of unapproved sends.

For Inbox, the imported Inbox Sweep card is a parallel-comparison surface during migration. Inbox
Sweep and Gmail remain authoritative for current operational state until this implementation has
been exercised enough to graduate.

## Feed Ownership

Each feed has one default home Codex thread in `thread.json`. That thread owns routine collection,
drain, and learning. Explicit cross-feed work is allowed when useful, but accidental cross-feed
claims are rejected. Extra feeds are archived durably outside the active workspace rather than
deleted.
