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

## Build A Bun Binary

```sh
pnpm build
pnpm attention:build
pnpm attention:smoke
./dist-bin/attention version
./dist-bin/attention start
```

The binary starts the local app in the background and serves built UI assets and API from
`http://127.0.0.1:4332`.

```sh
./dist-bin/attention health
./dist-bin/attention logs
./dist-bin/attention restart
./dist-bin/attention stop
```

Use `./dist-bin/attention start --foreground` when you want the server attached to the current
terminal.

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

Paste the printed skill setup prompt into a fresh Codex Desktop thread.

## Health Check

```sh
pnpm attention -- version
pnpm attention -- start
pnpm attention -- health
pnpm attention -- doctor
pnpm attention -- status
```

`version` prints the app version and CLI contract version. `doctor` checks local storage immediately.
It also calls the running local API at `/api/status`, so run `attention start` first when you want
the full server, version contract, and API readiness check to be green.

## Backup And Restore

```sh
pnpm attention -- backup export ./attention-backup
pnpm attention -- backup import ./attention-backup
```

Backups include `attention.db`, the readable `data/` mirrors, and a manifest. Legacy data-directory-only backups can still be imported; Attention removes the existing SQLite files so the imported mirrors become the source for rehydration on the next start.
