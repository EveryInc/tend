# MCP events for the existing Tend runtime

Tend exposes an optional authenticated JSON-RPC endpoint at `/mcp` on the same
loopback server as its existing UI (normally `http://127.0.0.1:4332`). It implements
MCP event discovery, subscription, signed callback verification, and webhook delivery
according to [OpenAI's MCP Events guide](https://developers.openai.com/plugins/build/mcp-events).
This adds no second app, model credentials, replacement database, or cloud database.

## Connect the original runtime

1. Locate and verify the original runtime with `tend doctor`, including its actual
   `ATTENTION_HOME`, feed IDs, home thread bindings, policies, and private access.
   Back it up before deploying a changed executable. An empty local development
   home cannot stand in for the user's original runtime.
2. Start the updated executable against that same home. `/mcp` is disabled unless
   `TEND_MCP_TOKEN` is supplied by the runtime owner. Configure an existing private
   transport to forward only `/mcp` and authenticate requests with that bearer token.
   Never expose `/api/session`, the UI mutation API, or the whole loopback server.
   Obtain approval before creating a persistent credential, new tunnel, or expanded
   access grant. Do not reuse another app's transport or credentials.
3. Connect/rescan this endpoint through the original Tend plugin. Confirm
   `server/discover` advertises protocol `2026-07-28` and `events/list` lists
   `tend.work.ready`. A normal webhook URL or local Codex process does not establish
   a subscription to a dot.
4. In the actual destination Work/cloud conversation or dot, subscribe to
   `tend.work.ready` with `{ "feed_id": "<existing feed>", "thread_id":
   "<that feed's actual home thread>" }`. The platform supplies the public HTTPS
   callback and signing secret. Tend verifies its signed challenge before activation.
   Existing mismatched bindings require explicit reconciliation; never silently
   rebind a user's feed to a development conversation.

The bearer grants a single local owner access to all locally bound feeds; the
thread filter is a routing constraint, not independently authenticated conversation
identity. Deploy only behind private owner access. A hosted multi-user service
requires per-user authentication and grants rather than this local-owner adapter.

## What wakes the conversation

Existing UI actions that queue Codex work (feed/card instructions, voice instructions,
recollection, learning, approvals, and edits to queued card notes) add an event to
the same SQLite transaction as the work. Only calls carrying the current UI mutation
session can publish. Agent/CLI queue writes, connector imports, passive state reads,
and Claude-lane work do not publish events. Inputs that only edit a draft or policy
without queuing work retain their existing behavior.

An active subscription suppresses the older auto-drain dispatcher for its feed.
Each event contains only feed/thread/work IDs and its revision. The existing feed
policy and work are retrieved through `tend_work_claim`; user text stays out of
webhook payloads. `tend_event_status` lists accepted events whose work remains queued.
Acceptance means callback HTTP success, not conversation receipt or completion.

`tend_work_claim` claims exactly the referenced work and replays an interrupted
claim's capability. `tend_work_respond` saves ordinary instruction responses to the
same work/card state shown in the UI, and replaying an identical response creates
no duplicate completion. Specialized work and external actions keep the existing
CLI, approval, and immediate action-verification requirements. Event receipt grants
no external-action authority.

## Reliability and privacy

Subscription identities are deterministic and refresh in place. Subscriptions last
at most 24 hours and must be refreshed before `refreshBefore`. A feed has one active
callback. Unsubscribe is idempotent and fences verification in flight. Expiry,
rebinding, cancellation, or changed queued-work revisions stop pending delivery.

The outbox survives process interruption. Retries keep the event ID and exact body,
refresh the signing timestamp, and use bounded exponential backoff (eight attempts).
410 revokes the subscription; 413 and permanent client errors stop retries. Secret
rotation verifies the replacement secret and dual-signs for five minutes.

Callbacks require HTTPS, port 443, no embedded credentials or redirects, and public
IPv4 DNS results pinned to the socket while retaining hostname/TLS verification.
IPv6-only callbacks are currently unsupported. Verification and responses are bounded
by time and size. Subscription delivery secrets stay only in the owner's SQLite
database; restrict access to that database and any raw database copies. Do not export or log
subscription payloads. Tend backup export strips delivery tables before writing the backup;
reconnect the plugin after a restore. Old accepted-event entries are retained locally
for duplicate detection; no application text or bearer token is stored in them.

## Required live acceptance test

After review and deployment to the verified original runtime, coordinate one harmless
instruction with the actual parent conversation:

1. Record discovery, subscription ID, successful challenge, actual feed/home binding,
   and configured private endpoint without recording credentials.
2. Enter a uniquely identifiable harmless note through the existing UI.
3. Confirm durable outbox publication and callback 2xx, then independently confirm the
   actual destination conversation received that event ID and referenced work.
4. Have that conversation claim the exact event and record a harmless response.
5. Read the existing UI state and verify the response and single completion audit.
   Retry claim/response and confirm no duplicate effects. Check a mismatched feed and
   canceled note do not reach that subscription.
6. Interrupt delivery/claim once, resume, and verify the same event/claim is recovered.

The isolated tests in `test/mcpEvents.test.ts` exercise the actual HTTP input and MCP
routes with synthetic state and a simulated signed receiver. They cannot establish
that a real dot subscribed, woke, or responded. Report live acceptance separately.
