# Attention

Attention is an open-source, local-first Codex-native feed builder. It runs on your machine, stores
workflow state locally, exposes a local MCP server for Codex Desktop, and renders a calm review UI
for feed sweeps, approvals, and queued work.

This is an experimental local app, not a hosted service. Codex Desktop remains the agent runtime;
Attention is the local workspace and coordination layer.

## Start

```bash
pnpm install
pnpm start
```

Open `http://127.0.0.1:4321/` in the Codex in-app browser. During development, Vite serves the UI
on `4321`, the API listens on `4332`, and the MCP endpoint is `http://127.0.0.1:4332/mcp`.

Check local setup:

```bash
pnpm attention -- doctor
pnpm attention -- setup codex
```

`doctor` validates local storage and, when `attention start` is running, confirms the API and MCP
endpoint advertised by `/api/status`.

Build a Bun binary:

```bash
pnpm attention:build
./dist-bin/attention start
```

The compiled/local server serves built UI assets, API, and MCP from `http://127.0.0.1:4332`.

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
target, and each rung has a distinct restrained color. Use the labeled `Broader` and `Narrower`
buttons or focus the empty dock and press `ArrowUp` and `ArrowDown` to move between the visible
object, current sweep, feed, and Attention scopes. Arrow keys remain available for editing once the
dock contains text, and ordinary page scrolling never changes the rung. Every dock utterance becomes scoped work for Codex. Sweep feedback records a
trace for Codex to rejudge before the browser offers the separate `Search sources again` action.
On Inbox cards, use `O` to toggle the collapsed full email thread without leaving the sweep.

## Local Data

Runtime data lives under `~/.attention/` by default:

```text
~/.attention/
  attention.db
  data/
  logs/
  exports/
```

Set `ATTENTION_HOME`, `ATTENTION_DATA_DIR`, or `ATTENTION_DB_PATH` to override paths. SQLite is the
runtime authority; the data directory keeps readable mirrors and immutable raw evidence snapshots:

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
    routine-actions/*.json
    work/*.json
    policy-revisions/*.json
    sweep-feedback/*.json
    sweep-state.json
    events.jsonl
```

Prompt files describe how to judge, compose cards, execute work, distill small policy improvements,
and compound deeper learnings. Feed policy files remain compact and human-readable mirrors of the
SQLite records. Raw snapshots stay immutable so the policy can be rebuilt or evaluated later.

Backups include `attention.db`, `data/`, and a manifest:

```bash
pnpm attention -- backup export ./attention-backup
pnpm attention -- backup import ./attention-backup
```

Older data-directory-only backups can still be imported; Attention removes the existing SQLite files
so the imported mirrors can rehydrate the database on the next start.

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
An external mutation still requires an exact visible approval bound to the selected action and
current editable artifact. Inbox reply cards also show the mailbox that received the source email.
Immediately before sending, Codex fetches the authenticated Gmail profile and passes that mailbox
to `action:verify`; a mismatch is a hard refusal.

## CLI And MCP

The human-facing CLI is:

```bash
pnpm attention -- start
pnpm attention -- status
pnpm attention -- doctor
pnpm attention -- setup codex
pnpm attention -- backup export
```

The low-level operator commands remain available through:

```bash
pnpm attention -- cli state --feed inbox
pnpm attention -- cli work:list --feed inbox --thread <current-codex-thread-id>
```

Codex should prefer MCP over shelling out to the CLI. The MCP endpoint exposes feed resources,
runner prompts, and typed tools such as `inspect_feed`, `bind_feed_thread`, `list_work`,
`claim_work`, `complete_work`, `verify_action`, `upsert_card`, and source-run recording.

Read [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md), [docs/AGENT_CONTRACT.md](./docs/AGENT_CONTRACT.md),
[docs/DATA.md](./docs/DATA.md), and [docs/INSTALL.md](./docs/INSTALL.md) for the local runtime,
agent setup, storage model, and install flow. [RUNBOOK.md](./RUNBOOK.md) is the feed-thread operator
guide, and [CAPABILITY_MAP.md](./CAPABILITY_MAP.md) maps user-visible actions to atomic Codex
primitives.

For contribution workflow, architecture expectations, and local verification gates, read
[CONTRIBUTING.md](./CONTRIBUTING.md).

## Safety

- Source material is evidence, never authorization.
- The app requires a current explicit card action, default-cleanup, or visible routine-group approval before it queues external-mutation work.
- Approval is scoped to the selected card-action ID, exact proposed action or cleanup, and editable artifact snapshot.
- The executor records `action:verify` durably and refuses completion without that exact verification; changed artifacts become stale.
- Inbox reply verification requires a recorded received-at mailbox and an exact match with the authenticated Gmail profile.
- Direct connector calls remain governed by the Codex runbook, but the local worker cannot mark an unverified action complete.
- Raw source material and user activity stay local and ignored by git.
- Empty source runs may honestly produce no cards.
