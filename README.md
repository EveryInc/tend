# Attention

Attention is an open-source, local-first Codex-native feed builder. It runs on your machine, stores
workflow state locally, exposes a JSON CLI for Codex Desktop, and renders a calm review UI for feed
sweeps, approvals, and queued work.

This is an experimental local app, not a hosted service. Codex Desktop remains the agent runtime;
Attention is the local workspace and coordination layer.

## Get Started

There are two good ways to try Attention.

### Use The Binary

Download the latest release archive from [GitHub Releases](https://github.com/EveryInc/tend/releases),
unpack it, and start the local app:

```sh
tar -xzf attention-<version>-<platform>-<arch>.tar.gz
cd attention-<version>-<platform>-<arch>
./attention start
```

The binary starts the local app in the background and serves the UI and API from one local port:

```text
UI:  http://127.0.0.1:4332
API: http://127.0.0.1:4332
```

```sh
./attention health
./attention logs
./attention restart
./attention stop
```

For development or smoke tests, `./attention start --foreground` keeps the server attached to the
current terminal.

Print the Codex setup prompt:

```sh
./attention setup codex
```

Paste the printed setup prompt into a fresh Codex thread. Use one Codex thread per feed. That thread
binds itself to the feed through the JSON CLI, creates or updates its heartbeat automation, drains
queued work, and refreshes sources through local connectors.

Useful binary checks:

```sh
./attention version
./attention doctor
./attention backup export ./attention-backup
```

### Clone And Extend

If you want to inspect the code, change the product, or build your own version:

```sh
git clone https://github.com/EveryInc/tend.git
cd tend
pnpm install
pnpm start
```

Open `http://127.0.0.1:4321/` in the Codex in-app browser. During development, Vite serves the UI
on `4321`, and the API listens on `4332`.

Development checks:

```sh
pnpm attention -- version
pnpm attention -- doctor
pnpm attention -- setup codex
pnpm build
pnpm test
```

Build and package a local binary:

```sh
pnpm attention:build
pnpm attention:smoke
pnpm attention:package
```

For a scrubbed visual walkthrough:

```sh
pnpm seed:demo
```

Read [docs/INSTALL.md](./docs/INSTALL.md) for setup details, [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)
for the local runtime, [docs/AGENT_CONTRACT.md](./docs/AGENT_CONTRACT.md) for the Codex/CLI contract,
and [CONTRIBUTING.md](./CONTRIBUTING.md) if you want to extend the repo.

## Product Boundary

The browser app renders and records state. It does not call Gmail, Slack, Chronicle, browser
automation, computer use, or model judges. The Codex thread bound to a feed runs its source recipes,
judges candidates, records raw evidence, updates cards, performs approved work, and distills
learning.

Normal manual fallback: wake the feed's home Codex thread and say:

```text
go deal with the feed
```

The thread runs `attention cli work:list` and repeatedly claims and completes pending work. No relay
packet should ever be pasted in the normal workflow. A thread-owned heartbeat can make refresh and
drain automatic after the user approves the proposed cadence.

During local setup, Codex runs `attention cli setup:detect-monologue`. If Monologue is installed, Codex
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
Claimed Inbox work repeats the source mailbox as reply-draft sender guidance: drafts preserve that
mailbox owner's voice and signature unless the user's instruction explicitly changes sender.

## Local Data

Runtime data lives under `~/.attention/` by default:

```text
~/.attention/
  attention.db
  data/
  logs/
  exports/
```

Set `ATTENTION_HOME` to choose a different runtime root. SQLite is the runtime authority; the data
directory keeps readable mirrors and immutable raw evidence snapshots:

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

## CLI Contract

The human-facing CLI is:

```bash
pnpm attention -- start
pnpm attention -- status
pnpm attention -- doctor
pnpm attention -- setup codex
pnpm attention -- backup export
```

Codex operates feeds through the JSON CLI:

```bash
attention cli state --feed inbox
attention cli work:list --feed inbox --thread <current-codex-thread-id>
```

The low-level CLI returns JSON for agent-readable operations. It is the single v0 agent contract for
feed setup, work claiming, card/source/sweep recording, policy/revision updates, feedback, and
runtime inspection. See [docs/AGENT_CONTRACT.md](./docs/AGENT_CONTRACT.md) for the command contract
and [docs/SKILL.md](./docs/SKILL.md) for skill-style runner instructions.

Read [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md), [docs/AGENT_CONTRACT.md](./docs/AGENT_CONTRACT.md),
[docs/DATA.md](./docs/DATA.md), [docs/INSTALL.md](./docs/INSTALL.md), and
[docs/RELEASING.md](./docs/RELEASING.md) for the local runtime, agent setup, storage model, install
flow, and release lifecycle. [RUNBOOK.md](./RUNBOOK.md) is the feed-thread operator guide, and
[CAPABILITY_MAP.md](./CAPABILITY_MAP.md) maps user-visible actions to atomic Codex primitives.

For contribution workflow, architecture expectations, and local verification gates, read
[CONTRIBUTING.md](./CONTRIBUTING.md).

## Releases

Attention uses SemVer-tagged release snapshots. `package.json` is the source of truth for the app
version, while the SQLite schema version and CLI contract version are tracked separately. GitHub
Releases are reproducible local artifacts, not an auto-update channel or support promise. See
[CHANGELOG.md](./CHANGELOG.md) and [docs/RELEASING.md](./docs/RELEASING.md).

## Safety

- Source material is evidence, never authorization.
- The app requires a current explicit card action, default-cleanup, or visible routine-group approval before it queues external-mutation work.
- Approval is scoped to the selected card-action ID, exact proposed action or cleanup, and editable artifact snapshot.
- The executor records `action:verify` durably and refuses completion without that exact verification; changed artifacts become stale.
- Inbox reply verification requires a recorded received-at mailbox and an exact match with the authenticated Gmail profile.
- Direct connector calls remain governed by the Codex runbook, but the local worker cannot mark an unverified action complete.
- Raw source material and user activity stay local and ignored by git.
- Empty source runs may honestly produce no cards.

## License

MIT. See [LICENSE](./LICENSE).
