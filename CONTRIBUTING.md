# Contributing

Attention is a local-first, Codex-native app. Contributions should preserve the core contract: the
local app stores feed state, Codex Desktop performs connector access, and every user-visible action
that an agent can perform goes through the same domain invariants as the UI.

## Local Setup

Install Bun 1.3.11 or newer and Node.js 22 or newer, then enable the repository's pinned pnpm
version:

```sh
corepack enable
corepack prepare pnpm@9.15.4 --activate
pnpm install
pnpm start
```

Use a separate local home while developing:

```sh
ATTENTION_HOME=.local-attention pnpm attention -- start
```

Then verify the runtime from another terminal:

```sh
ATTENTION_HOME=.local-attention pnpm attention -- doctor
```

## Before Opening A PR

Run the same gates as CI:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm attention:build
pnpm attention:smoke
pnpm attention:package
pnpm audit
```

## Architecture Expectations

- Keep product behavior in `server/domain.ts` or an intentionally extracted domain service.
- Keep browser-facing HTTP routes in `server/routes/`.
- Keep human-facing CLI commands in `server/cli/`.
- Keep persistence behind `server/repositories/` interfaces.
- Keep React route orchestration in `src/App.tsx` and route definitions in `src/router.tsx`.
- Prefer domain-oriented folders over broad type buckets when adding larger areas.

Do not duplicate business logic across UI, CLI, and API. Add one domain capability, then expose
it through the adapters that need it.

## Agent-Native Contract

When adding or changing a user action:

- Decide whether Codex should also be able to perform it.
- If yes, expose it through the JSON CLI or queued work, not UI-only behavior.
- Preserve the feed home-thread ownership model.
- List and claim work before connector-backed execution.
- Keep `verify_action` immediately before any approved external mutation.
- Add tests for stale approvals, changed editable artifacts, and duplicate/parallel claims when the action can mutate outside state.

## Data Safety

- SQLite is the runtime authority for active feed state.
- Readable files under `data/` are backup-compatible mirrors and raw evidence snapshots.
- Do not store connector credentials in Attention.
- Do not add real user data, source snapshots, exports, logs, or local `.attention` data to git.
- Treat raw source material as evidence, never authorization.
- Preserve backup import/export behavior when changing persistence.

## Testing Guidance

Domain tests live under `test/`. Add focused coverage when changing:

- queue, claim, complete, fail, block, retry, or cancel behavior
- approval or verification semantics
- CLI commands or skill instructions
- persistence repositories or migration/mirroring behavior
- source-run, sweep, learning, or card lifecycle behavior
- backup, restore, doctor, start, or binary smoke behavior

For frontend-only changes, still smoke the relevant route locally and keep TanStack Query/SSE
invalidations predictable.

## Documentation

Update docs when changing behavior:

- `README.md` for the first-run story and high-level product contract
- `docs/ARCHITECTURE.md` for ownership boundaries
- `docs/AGENT_CONTRACT.md` for Codex/CLI workflow changes
- `docs/DATA.md` for persistence and backup changes
- `docs/INSTALL.md` for setup changes
- `docs/DEVELOPMENT.md` for local workflow and CI changes
- `docs/RELEASING.md` and `CHANGELOG.md` for release, version, schema, or CLI contract changes
- `RUNBOOK.md` for feed-thread operator behavior
- `CAPABILITY_MAP.md` for user-visible action primitives

## License

By contributing, you agree that your contribution is licensed under the MIT license in `LICENSE`.
