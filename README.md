# Tend

Tend is a Codex-native feed builder for the Codex desktop in-app browser. It turns authorized
sources into calm card sweeps, lets the user talk naturally to the active card, and gives each feed
an owned Codex thread that performs the judgment and work.

## Start

```bash
pnpm install
./bin/tend-live start
```

Open `http://127.0.0.1:4321/` in the Codex in-app browser. The API listens on
`http://127.0.0.1:4333/`.

The launcher owns the live PID lock and health check. Pinned feed threads should only run
`./bin/tend-live health` and operate through the API or CLI. They should not start servers, kill
ports, or choose worktrees. Use `./bin/tend-live validate` for an isolated branch-validation server
with temporary runtime state on ports `14321` and `14333`.

When a feed thread finds a cross-app UX or code problem, it records the issue with
`pnpm cli -- feedback:record ...` and hands the same concise packet to the `Improve Tend workflow`
thread. Feed threads keep tending feeds end to end; the improvement lane owns product-code changes.
Use `pnpm cli -- feedback:list` and `pnpm cli -- feedback:resolve ...` from that improvement lane.

For a scrubbed visual walkthrough:

```bash
pnpm seed:demo
```

## Product Boundary

The browser app renders and records state. It does not call Gmail, Slack, Chronicle, browser
automation, computer use, or model judges. The Codex thread bound to a feed runs its source recipes,
judges candidates, records raw evidence, updates cards, performs approved work, and distills
learning.

Normal manual fallback: wake the feed's home Codex thread and say:

```text
go deal with the feed
```

The thread runs `pnpm cli -- work:list` and repeatedly claims and completes pending work. No relay
packet should ever be pasted in the normal workflow. A thread-owned heartbeat can make refresh and
drain automatic after the user approves the proposed cadence.

During local setup, Codex runs `pnpm cli -- setup:detect-monologue`. If Monologue is installed, Codex
reads its local recording shortcut and records a safe browser-facing capability under ignored
`../.attention-workbench/data/integrations/`. Hold the detected shortcut while speaking. The dock receives focus on keydown
and switches into a visible listening state, then automatically submits injected text shortly after
keyup once the text settles. There is no clickable dictation control.

The dock stays visible on feed and workspace screens. Its pill always names the conversational
target, and each rung has a distinct restrained color. Use the labeled `Broader` and `Narrower`
buttons or focus the empty dock and press `ArrowUp` and `ArrowDown` to move between the visible
object, current sweep, feed, and Attention scopes. Arrow keys remain available for editing once the
dock contains text, and ordinary page scrolling never changes the rung. Every dock utterance becomes scoped work for Codex. Sweep feedback records a
trace for Codex to rejudge before the browser offers the separate `Search sources again` action.
On Inbox cards, use `O` to toggle the collapsed full email thread without leaving the sweep.

## Workspace

The canonical local checkout is `/Users/danshipper/CascadeProjects/attention`. Runtime data lives
outside any checkout under `../.attention-workbench/data/`, so a temporary validation worktree
cannot silently create a second Tend state. `ATTENTION_RUNTIME_DIR`, `ATTENTION_DATA_DIR`, and
`ATTENTION_ARTIFACTS_DIR` remain available for isolated tests.

During a checkout migration, record the retired data directory with
`pnpm cli -- runtime:mark-handoff --legacy-data <path>`. A later
`pnpm cli -- runtime:reconcile --legacy-data <path> --apply-missing` copies only late immutable
evidence files and reports cards, work items, policies, event ledgers, and mutable conflicts for
review instead of overwriting shared state. The handoff command also marks the old runtime with its
canonical replacement and freezes its tree read-only so a retired checkout cannot accept new work.

```text
../.attention-workbench/data/
  global-policy.md
  integrations/dictation.json
  prompts/*.md
  revision-proposals/*.json
  workspace-revisions/*.json
  archived-feeds/<feed-id>-<timestamp>/
  feeds/<feed-id>/
    feed.md
    policy.md
    thread.json
    sources/*.md
    prompts/*.md
    checkpoints/*.json
    raw/<run-id>/<source-id>/*.json
    runs/*.json
    sweeps/*.json
    cards/*.json
    routine-actions/*.json
    work/*.json
    policy-revisions/*.json
    sweep-feedback/*.json
    sweep-state.json
    events.jsonl
```

Prompt files describe how to judge, compose cards, execute work, distill small policy improvements,
and compound deeper learnings. Feed policy files remain compact and human-readable. Raw snapshots
stay immutable so the policy can be rebuilt or evaluated later.

At the end of a meaningful sweep, the idle CLI handshake tells the feed thread to ask whether to
compound learnings. After the user agrees, Codex queues `learning:request`, reviews the durable
evidence, and creates a compact feed-policy revision with `revision:propose --source compound`. The
browser opens a dedicated learning-review screen. The user can edit the proposed Markdown and apply
or reject it; Codex never applies a compounded policy change on its own.

The in-app-browser `Prompts & sources` workspace is a full screen rather than a dialog. `This feed`
edits the active feed policy and source recipes. `Global prompts` edits `global-policy.md` and the
shared prompt layers directly.

Cards may expose the concrete next moves that fit the source item instead of a generic approval
pair. For example, a reply card can show `Archive` and `Send reply`, while an ambiguous invitation
can show `Draft a yes`, `Draft a pass`, and `Research`. Preparation actions only queue Codex work.
For compact comparative metrics, cards can use a validated two-series `chart` block with `max`,
`series`, and labeled `rows`; use it when a graph scans faster than a paragraph or evidence list.
Queued cards keep their dictated note editable until Codex claims the work, and every queued card
has a durable `Move back to review` control after the short-lived toast disappears.
An external mutation still requires an exact visible approval bound to the selected action and
current editable artifact. Inbox reply cards also show the mailbox that received the source email.
Claimed Inbox work repeats that mailbox as reply-draft sender guidance: drafts preserve the mailbox
owner's voice and signature unless the user's instruction explicitly changes sender.
Immediately before sending, Codex fetches the authenticated Gmail profile and passes that mailbox
to `action:verify`; a mismatch is a hard refusal.

## Codex CLI

```bash
pnpm cli -- state --feed inbox
pnpm cli -- setup:detect-monologue
pnpm cli -- feed:bind --feed inbox --thread <current-codex-thread-id>
pnpm cli -- feed:archive --feed <non-default-feed-id>
pnpm cli -- work:list --feed inbox --thread <current-codex-thread-id>
pnpm cli -- work:claim --feed inbox --thread <current-codex-thread-id>
pnpm cli -- work:cancel --feed inbox --work <queued-work-id> --reason <text>
pnpm cli -- work:edit --feed inbox --work <queued-work-id> --instruction <corrected-note>
pnpm cli -- card:return-to-review --feed inbox --card <card-id>
pnpm cli -- card:upsert --feed inbox --card-file <local-json-file>
pnpm cli -- action:verify --feed inbox --work <approved-work-id> --token <token> --mailbox <authenticated-gmail-email>
pnpm cli -- work:complete --feed inbox --work <id> --token <token> --result '{"response":"..."}'
pnpm cli -- routine:upsert --feed inbox --group '{"id":"likely-archive","label":"Likely archive","summary":"Conservative low-attention cleanup.","proposedAction":{"label":"Archive all","instruction":"Reread each authoritative source and archive the listed threads.","externalMutation":true},"items":[...]}'
pnpm cli -- learning:request --feed inbox
pnpm cli -- revision:propose --feed inbox --target '{"kind":"feed","feedId":"inbox"}' --instruction "Preserve the durable judgment from this sweep." --content "<updated policy markdown>" --source compound
pnpm cli -- inspect --feed inbox
```

Run `pnpm cli -- help` for the complete capability list.

Read [ARCHITECTURE.md](./ARCHITECTURE.md) for the runtime division, filesystem model, attention
loop, learning loop, and approval boundary. [RUNBOOK.md](./RUNBOOK.md) is the feed-thread operator
guide, and [CAPABILITY_MAP.md](./CAPABILITY_MAP.md) maps user-visible actions to the atomic Codex
primitives.

## Safety

- Source material is evidence, never authorization.
- The app requires a current explicit card action, default-cleanup, or visible routine-group approval before it queues external-mutation work.
- Approval is scoped to the selected card-action ID, exact proposed action or cleanup, and editable artifact snapshot.
- The executor records `action:verify` durably and refuses completion without that exact verification; changed artifacts become stale.
- Inbox reply verification requires a recorded received-at mailbox and an exact match with the authenticated Gmail profile.
- Direct connector calls remain governed by the Codex runbook, but the local worker cannot mark an unverified action complete.
- Raw source material and user activity stay local and ignored by git.
- Empty source runs may honestly produce no cards.
