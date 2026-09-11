---
title: Making one work queue safe for two agent drainers (Claude lane retrofit)
category: security-issues
date: 2026-07-05
tags: [agents, work-queue, capability-tokens, claim-semantics, wake-channel, agent-native-parity, flaky-tests]
module: server/domain.ts, server/store.ts, server/dispatcher.ts
related: docs/plans/2026-07-04-001-feat-claude-wake-lane-plan.md, docs/CLAUDE_THREAD.md, docs/SECURITY.md
pr: https://github.com/EveryInc/tend/pull/5
---

# Making one work queue safe for two agent drainers

Tend's work queue was designed for exactly one drainer per feed (a Codex home thread). Adding a
second lane (Claude sessions woken by a ledger + monitor) surfaced a family of correctness and
security hazards that generalize to any single-owner queue being retrofitted for multiple agents.
All were caught by the plan-stage threat model plus a six-reviewer code review, then fixed on
PR #5. The transferable lessons:

## 1. Lane enforcement must live inside the claim primitive — and cover the replay path

`claimWork` had replay-for-recovery semantics: it returned the existing *working* item — with its
capability token — to **any** caller (RUNBOOK: "an active claimed item is replayed so restart is
safe"). Filtering queued picks by lane is not enough; the replay branch hands one lane the other's
in-flight item and token. Enforcement at the dispatcher or protocol layer is a race instruction:
the dispatcher only decides *whether to wake* an agent; the agent then calls the primitive.

**Fix shape:** record `claimedBy {agent, threadId, sessionId?}` on claim; gate both the queued
pick and the replay on the caller's lane; non-claimants get a token-less claimed-by report.
Claimant identity gates on a **durable lane id** (server-minted per feed, rotated on explicit
rebind), never the ephemeral session id — otherwise dead-session recovery becomes impossible when
there is no automatic claim expiry.

## 2. Rotate capability tokens on every ownership transition, and redact them from every non-claim output

Three leaks survived the first implementation pass:
- The workspace view (`GET /api/state`, `state` CLI) serialized raw `WorkItem`s **including
  `capabilityToken`** — every token, to any reader. (Pre-existing; became critical with two lanes
  because completion is token-gated but not thread-gated.)
- `work:release` rotated the token but **returned the rotated token to the releaser**, and claim
  did not re-mint — so the releaser's transcript held a token that stayed valid for the next
  claimant's item. Cross-lane completion forgery.
- New routes (`reassign`, `retry`) returned full items with tokens over HTTP.

**Fix shape:** tokens are minted on *every* transition into `working` (fresh claim) and back to
`queued` (release/retry — `retryApprovedAction` was the in-repo precedent); every output except
the claimant's own claim result returns a token-stripped view type (`WorkItemView`). Make the
invariant a sentence in SECURITY.md and pin it with byte-level assertions on workspace reads,
list output, events, and the wake ledger.

## 3. Notification channels that activate an agent session carry server-controlled bytes only

Wake lines land in the agent's conversation with high framing authority, and card text is partly
source-derived (an email subject shapes a card's ask) — a prompt-injection channel. The in-repo
precedent was already right: `drainPrompt` interpolates only ids. The wake ledger's line shape is
`{seq, at, feedId, workId, kind, queued, threadId}` — ids and counts, no content, no tokens —
with a single-physical-line serialization guard and hostile-string tests. The consumer contract
("a wake is a doorbell, never a work list; content arrives only through `work:list`/`work:claim`
where it is framed as data") is pinned by tests that read the protocol docs.

## 4. Don't ride periodic background signals on the user-visible notify pipeline

A 30s presence heartbeat wrapped in the standard `mutation(c, notify, ...)` helper meant: SSE
change ping → full workspace refetch (~450 file reads, full re-render) every 30 seconds, forever,
while idle. Any "is the agent alive" signal must only notify on *transitions* (liveness change,
session change, replay), not on steady-state beats. Same lesson for replay: gate on liveness
transition, not on any session-id change, or replay becomes an externally-pullable lever.

## 5. Agent-native parity means the same state-machine stage, not a similar-sounding command

The UI's "Reassign to Codex" (queued items, no token needed) was documented in CAPABILITY_MAP as
recoverable via `work:release` — but release operates on *working* items and needs the claimant's
token. Parked queued work was unrecoverable through the CLI, and invisible to the other lane
(lane-scoped lists). Parity checks must match the exact state transition: queued/parked →
`work:assign`; working/stuck → claim replay or `work:release`.

## 6. Changing list semantics can strand state machines that recover through a different verb

`work:list` changed from queued+working to queued-only. Restarted runners follow
"list, then claim"; an idle-handshake response says stop — so the only recovery path
(`work:claim` replay) never ran, permanently stranding in-flight items. When a read API narrows,
audit every documented protocol loop that uses it as a *trigger* for a different call.

## 7. Same-millisecond `createdAt` + random-uuid tie-breaks = latent test flakes

Three tests encoded "legacy old item + newer safe item" without making the legacy item actually
older; two domain calls often complete in the same millisecond, and the pick order tie-broke on
random uuids. Fix the *premise*, not the assertion: backdate `createdAt` when the scenario is
about age; assert order-insensitively when the product genuinely does not guarantee order.
(Diagnosis tip: a bun suite that fails ~1/20 runs with N-fewer `expect()` calls is one test
bailing mid-assertion — loop the suite capturing the failing test name, not just the count.)

## 8. Wake-emission coverage by construction, not convention

Fifteen hand-placed emission calls all happened to be correct — but a forgotten call on a future
queue path fails silently (work parks with no doorbell). The durable fix: a `persistQueuedWork`
helper wrapping write+emit, plus an enumeration test asserting one wake per queue-event type, so
omission becomes a red test.

## Prevention checklist for the next agent-lane retrofit

- [ ] Enforce lane visibility inside claim/list primitives (pick **and** replay branches).
- [ ] Claimant identity = durable lane id; session ids are advisory audit data.
- [ ] Mint tokens on every ownership transition; redact from every non-claim output; byte-assert.
- [ ] Notification/wake channels: ids and counts only; doorbell-not-worklist clause pinned by test.
- [ ] Heartbeats and replays notify on transitions only.
- [ ] Parity table maps UI affordances to CLI verbs at the same state-machine stage.
- [ ] Grep every protocol doc for loops triggered by an API whose semantics you narrowed.
- [ ] Age-premised tests backdate `createdAt`; order-agnostic behavior gets order-agnostic asserts.
