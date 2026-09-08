# Data

Tend is local-first. By default, user data lives under:

```text
~/.attention/
  attention.db
  data/
  logs/
  exports/
```

Override the runtime root with:

```sh
ATTENTION_HOME=/path/to/attention tend start
```

## Current Storage

- `attention.db` stores local runtime metadata, active workspace feed membership, editable prompt/policy documents, feed cards, routine action groups, source recipes/checkpoints, source run records, sweep state/artifacts, revision records, feed audit events, and queued/claimed/completed work items.
- `data/workspace.json` mirrors active feed membership for backup compatibility and migration from older local installs.
- `data/global-policy.md`, `data/prompts/*.md`, `data/feeds/*/policy.md`, and `data/feeds/*/prompts/*.md` mirror editable prompt/policy documents for backup compatibility and readable local debugging.
- `data/feeds/*/cards/*.json` mirrors feed cards for backup compatibility and readable local debugging.
- `data/feeds/*/routine-actions/*.json` mirrors routine action groups for backup compatibility and readable local debugging.
- `data/feeds/*/sources.json`, `data/feeds/*/sources/*.md`, and `data/feeds/*/checkpoints/*.json` mirror source recipes and checkpoints.
- `data/feeds/*/runs/*.json` mirrors source run records for backup compatibility and readable local debugging.
- `data/feeds/*/sweep-state.json`, `data/feeds/*/sweeps/*.json`, and `data/feeds/*/sweep-feedback/*.json` mirror sweep state, batches, and feedback traces.
- `data/revision-proposals/*.json`, `data/workspace-revisions/*.json`, and `data/feeds/*/policy-revisions/*.json` mirror revision records.
- `data/feeds/*/events.jsonl` mirrors feed audit events for backup compatibility and readable local debugging.
- `data/feeds/*/work/*.json` mirrors work items for backup compatibility and readable local debugging.
- `data/feeds/*/feed.md` stores a readable feed description. `data/feeds/*/raw/**` stores immutable raw evidence snapshots.
- `data/agents/claude/presence.json`, `data/agents/claude/wake-state.json`, and `data/agents/claude/wake.jsonl` store Claude-lane operational state. Wake lines contain only server-controlled ids/counts and never source text, instructions, or capability tokens.
- `data/mind-context/binding.json` mirrors the one bound Chronicle publisher.
- `data/mind-context/updates/*.json` mirrors recent privacy-filtered On Your Mind publications and
  retains older records while a card references them for provenance.
  Full filtered OCR exists only in these local records and the dedicated `/mind` detail API; it is
  omitted from publication receipts, normal feed CLI output, cards, and logs.

## Connector Credentials

Tend does not store Gmail, GitHub, Slack, browser, or other connector credentials. Those live in the local Codex Desktop runtime.

## Backup

```sh
tend backup export
tend backup export ./tend-backup
tend stop
tend backup import ./tend-backup
```

The export command writes a backup directory with:

```text
tend-backup/
  attention.db
  data/
  manifest.json
```

`attention.db` is a consistent SQLite snapshot of the runtime authority. `data/` contains readable
file mirrors and immutable raw evidence snapshots. Export writes through a temporary staging
directory and refuses to overwrite or delete an existing destination.

Import first copies the backup into a temporary staging directory. Tend refuses to import while
the same runtime home is active, then swaps the staged database and data into place with rollback if
the swap fails. Older data-directory-only backups are still accepted; the next local runtime start
rehydrates `attention.db` from those imported file mirrors.

## Process locks

Service commands, mutations, and agent wake writes use separate SQLite lock files whose operating-system locks end when the owning process exits.
An empty marker file at the old lock path prevents older binaries from entering the same critical section.
Keep the marker and SQLite files in place; deleting a lock file can let processes lock different files at the same path.
Stop all older Tend processes before upgrading this lock format.
If an ownerless legacy `attention.lock`, `data/.mutation-lock`, or `data/.agent-wake-lock` directory remains, the command reports its exact path and refuses to reclaim it automatically.
Remove that directory only after confirming no older process is using the home.
