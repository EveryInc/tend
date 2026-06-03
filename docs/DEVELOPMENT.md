# Development

## Scripts

```sh
pnpm install
pnpm start
pnpm test
pnpm build
pnpm attention -- doctor
pnpm attention:build
```

## Local Runtime

Use `ATTENTION_HOME` to keep development data separate:

```sh
ATTENTION_HOME=.local-attention pnpm attention -- start
```

In another terminal, verify the runtime:

```sh
ATTENTION_HOME=.local-attention pnpm attention -- doctor
```

The doctor output is fully green only while the local API is running.

## Adding Capabilities

Prefer one domain method with thin adapters:

```text
domain/service behavior
  ├─ API route
  ├─ MCP tool
  └─ CLI command when useful
```

Do not duplicate business logic across UI, CLI, API, and MCP.

## Tests

Domain tests live under `test/`. Add coverage for new invariants before exposing new agent tools.

## CI

Pull requests run the same core gates expected locally:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm attention:build
```

CI also starts the compiled `dist-bin/attention` binary against a temporary `ATTENTION_HOME` and
checks `/api/status` before the job passes.
