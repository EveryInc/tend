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
