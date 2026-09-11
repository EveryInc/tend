# Install

## Requirements

### Packaged Release

- Codex Desktop for the intended in-app-browser and feed-thread workflow
- A Tend archive matching your platform
- Any Codex connectors used by your feeds

The packaged `tend` executable is self-contained and includes the Bun runtime. Bun, Node.js, and
pnpm are not required to run a downloaded release.

### Source And Binary Builds

- Git
- Bun 1.3.11 or newer
- Node.js 22 or newer
- pnpm 9.15.4

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

Open this URL in Codex Desktop's in-app browser. Tend's intended first-run flow keeps the feed UI
beside the Codex thread that operates it.

The local API listens on:

```text
http://127.0.0.1:4332
```

## Build A Bun Binary

```sh
pnpm build
pnpm tend:build
pnpm tend:smoke
./dist-bin/tend version
./dist-bin/tend start
```

The binary starts the local app in the background and serves built UI assets and API from
`http://127.0.0.1:4332`.

```sh
./dist-bin/tend health
./dist-bin/tend logs
./dist-bin/tend restart
./dist-bin/tend stop
```

Use `./dist-bin/tend start --foreground` when you want the server attached to the current
terminal.

Package the current platform binary for local distribution:

```sh
pnpm tend:package
```

The package command writes `dist-bin/releases/tend-<version>-<platform>-<arch>.tar.gz` plus a
`.sha256` checksum. The archive contains the `tend` executable, the Tend manual, built `dist/` UI
assets, README, license, contributor notes, all public
install/architecture/agent/data/development/iPhone/security/releasing docs, the changelog, and
operator/capability references.
The packaged executable resolves UI assets from the sibling `dist/` directory, so it can be launched
from inside the extracted folder or by absolute path from another working directory.

Release binaries are not Apple Developer ID signed or notarized yet. On macOS, Gatekeeper may show a
first-run warning for downloaded archives. You can still run Tend by opening the binary
explicitly from Finder or by removing the quarantine attribute:

```sh
xattr -d com.apple.quarantine ./tend
./tend start
```

## Codex Setup

Create or choose a feed in Tend, then start one fresh Codex Desktop thread for that feed. Do not
share one thread across multiple feeds.

```sh
pnpm tend -- setup codex --feed <feed-id>
```

Paste the complete output into that feed's thread. It binds the thread, installs or updates one
heartbeat, and asks the thread to handle the feed once immediately.

To run the feed manually later, open or wake that same thread and say:

```text
go deal with the feed
```

Use the manual wake after a paused or missing heartbeat, or whenever you want an immediate sweep.

## Health Check

```sh
pnpm tend -- version
pnpm tend -- start
pnpm tend -- health
pnpm tend -- doctor
pnpm tend -- status
```

`version` prints the app version and CLI contract version. `doctor` checks local storage immediately.
It also calls the running local API at `/api/status`, so run `tend start` first when you want
the full server, version contract, and API readiness check to be green.

## Backup And Restore

```sh
pnpm tend -- backup export ./tend-backup
pnpm tend -- stop
pnpm tend -- backup import ./tend-backup
```

Backups include a consistent SQLite snapshot, the readable `data/` mirrors, and a manifest. Export
requires a destination that does not already exist. Import stages and validates the backup before
swapping data, preserves the previous runtime until the swap succeeds, and refuses to run while the
same Tend home is active. Legacy data-directory-only backups can still be imported.

## iPhone Companion

The optional native client additionally requires a Mac, a private Supabase project, Xcode,
XcodeGen, an Apple Account configured in Xcode, and an iOS 17 device or simulator. A paid Apple
Developer Program membership is needed only for TestFlight or App Store distribution. See
[`docs/IOS.md`](./IOS.md) for the complete requirements, magic-link, worker, signing, installation,
and validation guide.
