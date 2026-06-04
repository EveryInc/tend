# Install

## From Source

```sh
pnpm install
pnpm start
```

Open:

```text
http://127.0.0.1:4321
```

The local API listens on:

```text
http://127.0.0.1:4332
```

The local MCP endpoint is:

```text
http://127.0.0.1:4332/mcp
```

## Build A Bun Binary

```sh
pnpm build
pnpm attention:build
pnpm attention:smoke
./dist-bin/attention version
./dist-bin/attention start
```

The binary serves built UI assets, API, and MCP from `http://127.0.0.1:4332`.
On macOS, the same binary can run as a managed local service:

```sh
./dist-bin/attention start --background
./dist-bin/attention health
./dist-bin/attention logs
./dist-bin/attention restart
./dist-bin/attention stop
```

Package the current platform binary for local distribution:

```sh
pnpm attention:package
```

The package command writes `dist-bin/releases/attention-<version>-<platform>-<arch>.tar.gz` plus a
`.sha256` checksum. The archive contains the `attention` executable, built `dist/` UI assets, README,
license, contributor notes, install/agent/data/security/releasing docs, changelog, and the
operator/capability references.
The packaged executable resolves UI assets from the sibling `dist/` directory, so it can be launched
from inside the extracted folder or by absolute path from another working directory.

## Codex Setup

```sh
pnpm attention -- setup codex
```

Copy the printed MCP URL and setup prompt into Codex Desktop.

## Health Check

```sh
pnpm attention -- version
pnpm attention -- start --background
pnpm attention -- health
pnpm attention -- doctor
pnpm attention -- status
```

`version` prints the app version and MCP contract version. `doctor` checks local storage immediately.
It also calls the running local API at `/api/status`, so run `attention start` in another terminal
when you want the full server, version contract, and MCP readiness check to be green.

## Backup And Restore

```sh
pnpm attention -- backup export ./attention-backup
pnpm attention -- backup import ./attention-backup
```

Backups include `attention.db`, the readable `data/` mirrors, and a manifest. Legacy data-directory-only backups can still be imported; Attention removes the existing SQLite files so the imported mirrors become the source for rehydration on the next start.
