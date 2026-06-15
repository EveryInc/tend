# Install

## Prerequisites

Source development requires Bun 1.3.11 or newer, Node.js 22 or newer, and pnpm 9.15.4.

```sh
bun --version
node --version
corepack enable
corepack prepare pnpm@9.15.4 --activate
```

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
license, contributor notes, all public install/architecture/agent/data/development/iPhone/security/
releasing docs, changelog, and the operator/capability references.
The packaged executable resolves UI assets from the sibling `dist/` directory, so it can be launched
from inside the extracted folder or by absolute path from another working directory.

Release binaries are not Apple Developer ID signed or notarized yet. On macOS, Gatekeeper may show a
first-run warning for downloaded archives. You can still run Attention by opening the binary
explicitly from Finder or by removing the quarantine attribute:

```sh
xattr -d com.apple.quarantine ./attention
./attention start
```

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
pnpm attention -- stop
pnpm attention -- backup import ./attention-backup
```

Backups include a consistent SQLite snapshot, the readable `data/` mirrors, and a manifest. Export
requires a destination that does not already exist. Import stages and validates the backup before
swapping data, preserves the previous runtime until the swap succeeds, and refuses to run while the
same Attention home is active. Legacy data-directory-only backups can still be imported.
