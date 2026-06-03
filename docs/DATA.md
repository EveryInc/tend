# Data

Attention is local-first. By default, user data lives under:

```text
~/.attention/
  attention.db
  data/
  logs/
  exports/
```

Override the location with:

```sh
ATTENTION_HOME=/path/to/attention attention start
```

or:

```sh
ATTENTION_DATA_DIR=/path/to/data attention start
ATTENTION_DB_PATH=/path/to/attention.db attention start
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

## Connector Credentials

Attention does not store Gmail, GitHub, Slack, browser, or other connector credentials. Those live in the local Codex Desktop runtime.

## Backup

```sh
attention backup export
attention backup export ./attention-backup
attention backup import ./attention-backup
```

The export command writes a backup directory with:

```text
attention-backup/
  attention.db
  data/
  manifest.json
```

`attention.db` is the SQLite runtime authority. `data/` contains readable file mirrors and immutable raw evidence snapshots. Importing this backup restores both.

Older data-directory-only backups are still accepted. When importing a legacy data-only backup, Attention replaces `data/` and removes the existing SQLite files so the next local runtime start rehydrates `attention.db` from the imported file mirrors.
