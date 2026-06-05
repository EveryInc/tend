# Development

For contribution workflow, architecture expectations, and PR gates, start with
[`CONTRIBUTING.md`](../CONTRIBUTING.md). This page is the shorter command reference for local
development.

## Scripts

```sh
pnpm install
pnpm start
pnpm test
pnpm build
pnpm attention -- version
pnpm attention -- doctor
pnpm attention:build
pnpm attention:smoke
pnpm attention:package
```

## Local Runtime

Use `ATTENTION_HOME` to keep development data separate:

```sh
ATTENTION_HOME=.local-attention pnpm attention -- start --foreground
```

In another terminal, verify the runtime:

```sh
ATTENTION_HOME=.local-attention pnpm attention -- doctor
```

The doctor output is fully green only while the local API is running.

For the background runner, use:

```sh
ATTENTION_HOME=.local-attention pnpm attention -- start
ATTENTION_HOME=.local-attention pnpm attention -- health
ATTENTION_HOME=.local-attention pnpm attention -- stop
```

## Adding Capabilities

Prefer one domain method with thin adapters:

```text
domain/service behavior
  ├─ API route
  └─ CLI command when useful
```

Do not duplicate business logic across UI, CLI, and API.

## Tests

Domain tests live under `test/`. Add coverage for new invariants before exposing new agent tools.

## CI

Pull requests run the same core gates expected locally:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm attention:build
pnpm attention:smoke
pnpm attention:package
```

`pnpm attention:smoke` starts the compiled `dist-bin/attention` binary in foreground mode against a temporary
`ATTENTION_HOME`, checks `attention version`, checks `/api/status`, validates the app version, CLI
contract version and schema version, verifies the built UI is served, confirms core JSON CLI
commands work, stops the server, and removes the temporary data directory.

Use `pnpm attention:package` after the smoke check when preparing a local release archive. It writes
a platform-specific tarball and checksum under `dist-bin/releases/`. The tarball includes the
compiled binary, built `dist/` UI assets, license, and release docs.

## Releases

Release policy lives in [`docs/RELEASING.md`](./RELEASING.md). Keep `package.json`,
`CHANGELOG.md`, runtime version output, and release artifacts in sync.
