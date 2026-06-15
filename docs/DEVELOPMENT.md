# Development

For contribution workflow, architecture expectations, and PR gates, start with
[`CONTRIBUTING.md`](../CONTRIBUTING.md). This page is the shorter command reference for local
development.

## Scripts

```sh
corepack enable
corepack prepare pnpm@9.15.4 --activate
pnpm install
pnpm start
pnpm check
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

### Native Mobile

Start and validate the local Supabase stack:

```sh
pnpm exec supabase start
pnpm exec supabase db reset --local
pnpm exec supabase test db
```

The repository pins the Supabase CLI as a development dependency, so these are the same commands
used in CI.

Generate the Xcode project and run the `Tend` scheme:

```sh
brew install xcodegen
cd ios
xcodegen generate
open Tend.xcodeproj
```

UI tests launch with fixture data and do not require cloud credentials. The gated bridge integration
test uses a temporary Tend home and local Supabase:

```sh
TEND_SUPABASE_E2E=1 \
TEND_TEST_SUPABASE_URL=<local-api-url> \
TEND_TEST_SUPABASE_ANON_KEY=<local-publishable-key> \
TEND_TEST_SUPABASE_SERVICE_ROLE_KEY=<local-service-role-key> \
TEND_TEST_SUPABASE_JWT_SECRET=<local-jwt-secret> \
bun test test/mobile-supabase-e2e.test.ts
```

See [`docs/IOS.md`](./IOS.md) for production configuration and physical-device installation.

## CI

Pull requests run the same core gates expected locally:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm attention:build
pnpm attention:smoke
pnpm attention:package
```

`pnpm check` runs TypeScript, Oxlint, and Bun tests. `pnpm attention:smoke` starts the compiled
`dist-bin/attention` binary in foreground mode against a temporary `ATTENTION_HOME`, checks
`attention version`, checks `/api/status`, validates the app version, CLI contract version and schema
version, verifies the built UI is served, confirms core JSON CLI commands work, stops the server,
and removes the temporary data directory.

Use `pnpm attention:package` after the smoke check when preparing a local release archive. It writes
a platform-specific tarball and checksum under `dist-bin/releases/`. The tarball includes the
compiled binary, built `dist/` UI assets, license, and release docs.

CI also starts a local Supabase stack, resets and pgTAP-tests the database, runs the real mobile
bridge integration test, generates the Xcode project, and runs the native `Tend` unit and UI test
targets on a macOS runner.

## Releases

Release policy lives in [`docs/RELEASING.md`](./RELEASING.md). Keep `package.json`,
`CHANGELOG.md`, runtime version output, and release artifacts in sync.
