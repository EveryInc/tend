# Security

Tend is local-first and binds its development server to `127.0.0.1` by default.

## Trust Boundary

- The local Tend app stores workflow state and evidence.
- Codex Desktop performs connector access.
- Gmail, GitHub, Slack, browser, and other connector credentials are not stored by Tend.
- External mutations require approved work and immediate `verify_action` checks.

## Localhost

The API is a local HTTP endpoint and must not be exposed on a public network. Browser mutations
require JSON, a loopback same-origin request, and a per-process mutation token fetched by the local
UI. These checks prevent an unrelated website from silently posting to a running Tend server;
they are not a substitute for keeping the listener on loopback.

## On Your Mind

Chronicle context may include privacy-filtered OCR. Tend stores the full filtered windows only in
the local SQLite database, readable file mirror, and dedicated `/mind` detail API. Publication
receipts, cards, and feed-safe CLI reads omit full OCR.

The built-in filter removes common secrets, email addresses, long account numbers, and local user
paths. It is defense in depth, not a substitute for source restraint: publishers must include only
short windows that support a published signal.

## iPhone And Supabase

- SQLite on the Mac remains authoritative; Supabase is a disposable private projection and command
  mailbox.
- The iPhone receives no connector credentials, capability tokens, Codex thread ownership, or local
  artifact paths.
- The phone uses only a Supabase publishable key plus a Keychain-backed user session. The Supabase
  secret/service key stays on the Mac in a mode `400` or `600` owner-only config file.
- Row-level security limits every read and command RPC to `auth.uid()`.
- Commands carry feed, card, action, and work digests and are revalidated locally before mutation.
- Cached snapshots and drafts use complete file protection and are deleted on sign-out.
- On Your Mind reaches the phone only after the existing Chronicle privacy filter has run.

## Reporting

For vulnerabilities, open a private report through the repository's security advisory flow if available. If not, contact the maintainers before publishing details.
