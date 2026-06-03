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

- `attention.db` stores local runtime metadata, active workspace feed membership, and feed audit events.
- `data/workspace.json` mirrors active feed membership for backup compatibility and migration from older local installs.
- `data/feeds/*/events.jsonl` mirrors feed audit events for backup compatibility and readable local debugging.
- `data/` stores current feed artifacts: cards, prompts, source recipes, runs, checkpoints, work queue, and revisions.

## Connector Credentials

Attention does not store Gmail, GitHub, Slack, browser, or other connector credentials. Those live in the local Codex Desktop runtime.

## Backup

```sh
attention backup export
attention backup export ./attention-backup
attention backup import ./attention-backup
```

The export command copies the local feed data directory. Active feed membership and audit events are mirrored into `data/`, so feed visibility and audit history survive data-directory backup even though SQLite is now the local runtime authority for those records.
