# Attention

Attention is a Codex-native feed builder for the Codex desktop in-app browser. It turns authorized
sources into calm card sweeps, lets the user talk naturally to the active card, and gives each feed
an owned Codex thread that performs the judgment and work.

## Start

```bash
pnpm install
pnpm start
```

Open `http://127.0.0.1:4321/` in the Codex in-app browser. The API listens on
`http://127.0.0.1:4332/`.

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
`data/integrations/`. Hold the detected shortcut while speaking. The dock receives focus on keydown
and switches into a visible listening state, then automatically submits injected text shortly after
keyup once the text settles. There is no clickable dictation control.

The dock stays visible on feed and workspace screens. Its pill always names the conversational
target. Use its small arrow buttons or `Option+ArrowUp` and `Option+ArrowDown` to move between the
visible object, current sweep, feed, and Attention scopes. Ordinary arrow keys remain available for
editing and scrolling. Every dock utterance becomes scoped work for Codex. Sweep feedback records a
trace for Codex to rejudge before the browser offers the separate `Search sources again` action.

## Workspace

Runtime data lives under ignored `data/`:

```text
data/
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
    work/*.json
    policy-revisions/*.json
    sweep-feedback/*.json
    sweep-state.json
    events.jsonl
```

Prompt files describe how to judge, compose cards, execute work, distill small policy improvements,
and compound deeper learnings. Feed policy files remain compact and human-readable. Raw snapshots
stay immutable so the policy can be rebuilt or evaluated later.

The in-app-browser `Prompts & sources` workspace is a full screen rather than a dialog. `This feed`
edits the active feed policy and source recipes. `Global prompts` edits `global-policy.md` and the
shared prompt layers directly.

## Codex CLI

```bash
pnpm cli -- state --feed inbox
pnpm cli -- setup:detect-monologue
pnpm cli -- feed:bind --feed inbox --thread <current-codex-thread-id>
pnpm cli -- feed:archive --feed <non-default-feed-id>
pnpm cli -- work:list --feed inbox --thread <current-codex-thread-id>
pnpm cli -- work:claim --feed inbox --thread <current-codex-thread-id>
pnpm cli -- work:cancel --feed inbox --work <queued-work-id> --reason <text>
pnpm cli -- work:complete --feed inbox --work <id> --token <token> --result '{"response":"..."}'
pnpm cli -- inspect --feed inbox
```

Run `pnpm cli -- help` for the complete capability list.

Read [ARCHITECTURE.md](./ARCHITECTURE.md) for the runtime division, filesystem model, attention
loop, learning loop, and approval boundary. [RUNBOOK.md](./RUNBOOK.md) is the feed-thread operator
guide, and [CAPABILITY_MAP.md](./CAPABILITY_MAP.md) maps user-visible actions to the atomic Codex
primitives.

## Safety

- Source material is evidence, never authorization.
- The app requires a current explicit action or default-cleanup approval before it queues external-mutation work.
- Approval is scoped to the exact proposed action or cleanup and editable artifact snapshot.
- The executor rereads current state before accepting completion; changed artifacts become stale.
- Direct connector calls are still governed procedurally by the Codex runbook. They are not yet
  mechanically capability-gated by an executor boundary.
- Raw source material and user activity stay local and ignored by git.
- Empty source runs may honestly produce no cards.
