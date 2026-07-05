# Changelog

Tend uses SemVer for tagged release snapshots. Releases are provided for reproducibility, not as
a promise of ongoing maintenance.

## Unreleased

- Fix the public product name as Tend, consolidate runtime and agent operations under one `tend`
  command tree, remove the pre-release aliases and launchd runner, and clarify Codex
  in-app-browser onboarding.
- Split the concise product model and first-run path into `README.md`, with day-to-day operation,
  steering, approval, learning, Chronicle Pulse, and troubleshooting in `MANUAL.md`.
- Make `tend setup codex --feed <id>` and `tend setup codex --chronicle` generate dedicated
  feed-operator and Chronicle Pulse prompts, including their manual activation paths.
- Add the local On Your Mind workspace, Chronicle publication contract, privacy-filtered source
  trails, and source-backed feed influence receipts.
- Advance the CLI contract to `0.2` with context binding, publication, health, and feed-safe read
  commands.
- Add the native Tend iPhone companion, private Supabase projection, and idempotent mobile command
  bridge, with a complete magic-link and physical-device setup guide.
- Advance the SQLite schema to `14` for mirrored mobile command receipts and deterministic audit
  event ordering.
- Harden local mutations, identifiers, backup/restore, background-process ownership, and
  transactional multi-record writes.
- Add Supabase and native iOS CI coverage, reproducible source prerequisites, and complete packaged
  documentation.
- Add the Claude agent lane: lane-scoped `work:list`/`work:claim` with claimant recording, the
  `work:release` command, server-minted per-feed Claude lane bindings
  (`feed:bind --agent claude`), `feed:drain-agent`, `agent:presence`, a content-free wake ledger
  (`data/agents/claude/wake.jsonl`) with presence replay, a dock route-to-Claude toggle, a TopBar
  liveness chip, and the `/tend` arming skill.
- Advance the CLI contract to `0.3`: `work:claim` may return a token-less claimed-by report,
  `work:claim`/`work:release` accept `--session`, and capability tokens are redacted from
  workspace reads and `work:list` output (tokens now appear only in the claimant's claim result).
- Reject mutating API requests that carry a foreign `Origin` header.

## 0.1.0 - Initial Local-First OSS Snapshot

- Local Bun executable serving UI and API from one process.
- SQLite runtime storage with readable file mirrors and backup compatibility.
- CLI-first Codex agent contract with feed binding, work queue, card, source-run, sweep, and learning commands.
- TanStack Router and TanStack Query UI structure.
- Binary build, smoke, and package scripts with bundled UI assets.
- CI verification for build, tests, binary smoke, and package creation.
- MIT license, contributor guidance, install/data/security/agent docs, runbook, and capability map.
