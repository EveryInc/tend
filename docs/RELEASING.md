# Releasing

Attention releases are tagged local-first snapshots. They make builds reproducible and bug reports
specific; they do not imply a hosted service, auto-update channel, or support SLA.

## Versioning

- `package.json` is the source of truth for the app version.
- Use SemVer.
- Before `1.0.0`, minor releases may contain breaking changes, but release notes must call them out.
- Patch releases should be bug fixes only.
- Prereleases use normal SemVer labels, for example `0.2.0-beta.1`.

## Compatibility Versions

The app version, SQLite schema version, and CLI contract version are separate.

- App version: user-visible release snapshot.
- SQLite schema version: local database shape. Forward-only migrations are expected.
- CLI contract version: agent-facing command compatibility.

`attention version`, `attention status`, `attention doctor`, and `/api/status` report the app version
and CLI contract version. `attention doctor` also reports the SQLite schema version.

Compatibility rules:

- Do not remove CLI commands casually.
- Prefer additive CLI changes.
- Document breaking CLI or schema changes in `CHANGELOG.md`.
- Refuse to open data from a newer schema version once that guard exists.
- Take or instruct a backup before destructive migrations.

## Release Checklist

1. Update `package.json` version.
2. Update `CHANGELOG.md`.
3. Run:

   ```sh
   pnpm install --frozen-lockfile
   pnpm build
   pnpm test
   pnpm attention:build
   pnpm attention:smoke
   pnpm attention:package
   ```

4. Confirm `attention version` reports the new version.
5. Commit the version and changelog changes.
6. Tag and push:

   ```sh
   git tag v0.1.1
   git push origin main --tags
   ```

7. Review the draft GitHub Release, attached archives, and checksums.
8. Publish the release when the artifacts look correct.

## Artifacts

Release archives are named:

```text
attention-<version>-<platform>-<arch>.tar.gz
attention-<version>-<platform>-<arch>.tar.gz.sha256
```

Each archive contains:

- `attention` executable
- bundled `dist/` UI assets
- `README.md`
- `CONTRIBUTING.md`
- `LICENSE`
- install, agent, data, security, and releasing docs
- runbook and capability map
- `manifest.json`

## Automation

The release workflow runs on `v*` tags. It builds native binaries on the configured GitHub-hosted
runners, runs the binary smoke test, packages each archive, uploads artifacts, and creates a draft
GitHub Release with generated notes.
