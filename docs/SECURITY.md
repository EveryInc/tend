# Security

Attention is local-first and binds its development server to `127.0.0.1` by default.

## Trust Boundary

- The local Attention app stores workflow state and evidence.
- Codex Desktop performs connector access.
- Gmail, GitHub, Slack, browser, and other connector credentials are not stored by Attention.
- External mutations require approved work and immediate `verify_action` checks.

## Localhost

The API and MCP endpoint are local HTTP endpoints. Treat them as trusted-local interfaces and avoid exposing them on a public network.

## Reporting

For vulnerabilities, open a private report through the repository's security advisory flow if available. If not, contact the maintainers before publishing details.
