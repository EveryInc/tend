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

- `attention.db` stores local runtime metadata, active workspace feed membership, feed cards, routine action groups, source recipes/checkpoints, source run records, sweep state/artifacts, revision records, feed audit events, and queued/claimed/completed work items.
- `data/workspace.json` mirrors active feed membership for backup compatibility and migration from older local installs.
- `data/feeds/*/cards/*.json` mirrors feed cards for backup compatibility and readable local debugging.
- `data/feeds/*/routine-actions/*.json` mirrors routine action groups for backup compatibility and readable local debugging.
- `data/feeds/*/sources.json`, `data/feeds/*/sources/*.md`, and `data/feeds/*/checkpoints/*.json` mirror source recipes and checkpoints.
- `data/feeds/*/runs/*.json` mirrors source run records for backup compatibility and readable local debugging.
- `data/feeds/*/sweep-state.json`, `data/feeds/*/sweeps/*.json`, and `data/feeds/*/sweep-feedback/*.json` mirror sweep state, batches, and feedback traces.
- `data/revision-proposals/*.json`, `data/workspace-revisions/*.json`, and `data/feeds/*/policy-revisions/*.json` mirror revision records.
- `data/feeds/*/events.jsonl` mirrors feed audit events for backup compatibility and readable local debugging.
- `data/feeds/*/work/*.json` mirrors work items for backup compatibility and readable local debugging.
- `data/` stores current feed artifacts that are still file-backed: prompts and raw snapshots.

## Connector Credentials

Attention does not store Gmail, GitHub, Slack, browser, or other connector credentials. Those live in the local Codex Desktop runtime.

## Backup

```sh
attention backup export
attention backup export ./attention-backup
attention backup import ./attention-backup
```

The export command copies the local feed data directory. Active feed membership, cards, routine action groups, source recipes/checkpoints, source run records, sweep artifacts, revision records, audit events, and work items are mirrored into `data/`, so feed visibility, UI artifacts, provenance, audit history, and queued agent work survive data-directory backup even though SQLite is now the local runtime authority for those records.
