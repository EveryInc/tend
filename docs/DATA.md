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

- `attention.db` stores local runtime metadata and is the migration anchor for the local app.
- `data/` stores current feed state, cards, prompts, source recipes, runs, checkpoints, work queue, revisions, and events.

## Connector Credentials

Attention does not store Gmail, GitHub, Slack, browser, or other connector credentials. Those live in the local Codex Desktop runtime.

## Backup

```sh
attention backup export
attention backup export ./attention-backup
attention backup import ./attention-backup
```

The export command copies the local feed data directory. Future versions should include SQLite export/import once feed state is fully repository-backed.
