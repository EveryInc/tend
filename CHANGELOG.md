# Changelog

Tend uses SemVer for tagged release snapshots. Releases are provided for reproducibility, not as
a promise of ongoing maintenance.

## Unreleased

- Fix the public product name as Tend, ship `tend` release artifacts while retaining the
  pre-release `attention` command as an alias, and clarify Codex in-app-browser onboarding.
- Make `tend setup codex --feed <id>` generate a feed-specific prompt and document manual feed
  activation through the dedicated Codex thread.
- Add the local On Your Mind workspace, Chronicle publication contract, privacy-filtered source
  trails, and source-backed feed influence receipts.
- Advance the CLI contract to `0.2` with context binding, publication, health, and feed-safe read
  commands.
- Add the native Tend iPhone companion, private Supabase projection, and idempotent mobile command
  bridge.
- Advance the SQLite schema to `14` for mirrored mobile command receipts and deterministic audit
  event ordering.
- Harden local mutations, identifiers, backup/restore, background-process ownership, and
  transactional multi-record writes.
- Add Supabase and native iOS CI coverage, reproducible source prerequisites, and complete packaged
  documentation.

## 0.1.0 - Initial Local-First OSS Snapshot

- Local Bun executable serving UI and API from one process.
- SQLite runtime storage with readable file mirrors and backup compatibility.
- CLI-first Codex agent contract with feed binding, work queue, card, source-run, sweep, and learning commands.
- TanStack Router and TanStack Query UI structure.
- Binary build, smoke, and package scripts with bundled UI assets.
- CI verification for build, tests, binary smoke, and package creation.
- MIT license, contributor guidance, install/data/security/agent docs, runbook, and capability map.
