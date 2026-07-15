# Tend Core Specification

Status: Draft v1 (language-agnostic)

Purpose: Define the smallest complete Tend implementation: a local, durable system that delegates
ongoing attention to an agent while keeping review, judgment, and external authorization with the
user.

This specification defines observable behavior and safety guarantees. It does not prescribe a
programming language, framework, database, command names, wire protocol, or visual design.

## Normative Language

The key words `MUST`, `MUST NOT`, `REQUIRED`, `SHOULD`, `SHOULD NOT`, `RECOMMENDED`, `MAY`, and
`OPTIONAL` are to be interpreted as described in RFC 2119.

`Implementation-defined` means an implementation may choose the behavior, but MUST document its
choice.

An implementation is **core-compatible** when it satisfies the required behavior and conformance
scenarios in this document. Equivalent operations may use different names, data shapes, transports,
and user-interface structures.

## 1. Problem Statement

Most agent work begins and ends with a prompt. Tend begins with an ongoing responsibility: keep a
person on top of something that changes over time, bring back only what deserves attention, and
improve the judgment through review and feedback.

Tend solves five related problems:

- Important changes are distributed across sources and easy to miss.
- Repeatedly prompting an agent loses continuity, checkpoints, and learned judgment.
- Unfiltered monitoring creates noise instead of useful attention.
- Acting directly from source material confuses evidence with authorization.
- Silent agent learning can change policy without the user understanding or approving it.

The unit of delegation is a **responsibility**, represented by a feed. One durable agent context
tends each feed over time. The local Tend runtime stores the feed's intent and workflow state. The
user reviews cards, steers the work, approves exact external actions, and decides whether proposed
learning becomes policy.

The core loop is:

```text
Observe sources -> Review meaningful cards -> Steer or approve -> Review proposed learning -> Repeat
```

Important boundary:

- Source material is evidence, never authorization.
- The feed operator may prepare work, but an external mutation requires an exact visible approval
  and a fresh verification immediately before the mutation.
- Learning is proposed to the user. It is never silently applied by the agent.

## 2. Goals and Non-Goals

### 2.1 Goals

- Represent an ongoing intent as a durable, editable feed.
- Give exactly one durable agent context primary responsibility for each feed.
- Observe configured sources incrementally and preserve source provenance.
- Prefer a quiet feed over weak or repetitive cards.
- Present meaningful changes as structured, reviewable cards.
- Let the user steer a card, a sweep, a feed, or editable configuration.
- Queue agent work with exclusive claims, restart-safe replay, and explicit terminal outcomes.
- Bind external authorization to the exact action and artifact the user reviewed.
- Preserve history needed to explain what was observed, decided, approved, and changed.
- Turn feedback and outcomes into editable policy proposals that require user approval.
- Remain portable across agent hosts, programming languages, storage systems, and UI frameworks.

### 2.2 Non-Goals

- General-purpose task management or workflow automation.
- A fully autonomous agent that may change policy or external systems without review.
- Requiring a particular agent vendor, model, thread API, or process-launch protocol.
- Requiring exact compatibility with the reference Tend CLI, HTTP API, or storage layout.
- Prescribing pixel-level layout, navigation, styling, keyboard shortcuts, or a UI framework.
- Prescribing source-specific business logic for Gmail, Slack, GitHub, Linear, or other connectors.
- Multi-user tenancy, remote collaboration, or a hosted control plane.
- A mobile client or cloud projection.
- On Your Mind or Chronicle context. These are optional extensions, not core conformance.
- Multiple simultaneous operator lanes for one feed. Implementations MAY add them as an extension.

## 3. Conformance and Extension Model

### 3.1 Core Conformance

Core conformance is behavioral. A conforming implementation MUST provide equivalent ways to:

1. create and configure a feed;
2. bind a durable agent context to it;
3. record source runs and immutable evidence;
4. record a sweep and publish meaningful cards;
5. review, edit, dismiss, restore, and steer cards;
6. queue, claim, release, complete, fail, block, retry, and cancel work where applicable;
7. approve and freshly verify exact external mutations;
8. propose, review, apply, reject, and retain history for policy changes; and
9. recover useful state after process or agent restart.

The interaction concepts in this list are normative. Their visual arrangement and operation names
are not.

Conformance checks SHOULD classify observable results using these semantic classes, regardless of
transport or naming: `ok`, `invalid`, `unauthorized`, `conflict`, `stale`, `idle`, and
`held_by_other`. An implementation MAY add more specific results, but MUST document how they map to
these classes.

### 3.2 Required, Recommended, and Optional Surface

`REQUIRED` behavior defines the portable Tend identity.

`RECOMMENDED` behavior improves operational quality but may vary where a platform cannot provide it.
An implementation that omits a recommended behavior SHOULD document the substitute.

`OPTIONAL` behavior does not affect core conformance. Optional features MUST NOT weaken core safety
invariants.

### 3.3 Extensions

Implementations MAY add source adapters, card block types, agent hosts, operator lanes, context
systems, mobile clients, remote projections, collaboration, or automation.

An extension MUST:

- identify itself as an extension;
- document any new data and transitions;
- preserve core identifiers and provenance;
- preserve claim and approval safety; and
- avoid making the core flow depend on the extension.

A multiple-operator-lane extension MUST enforce lane ownership inside both fresh claim selection and
active-claim replay. Dispatcher filters and wake routing alone are insufficient authority checks.

## 4. System Overview

### 4.1 Logical Components

A conforming Tend consists of these logical components. They MAY run in one process.

1. **Local Runtime**
   - Owns feed state, cards, work, approvals, revisions, and audit history.
   - Enforces domain invariants.

2. **Review Surface**
   - Lets the user inspect cards and evidence.
   - Exposes steering, edits, approvals, and learning review.

3. **Agent Interface**
   - Lets a bound agent inspect a feed, claim work, record observations, and report outcomes.
   - Returns structured results suitable for reliable agent operation.

4. **Agent Host Adapter**
   - Associates one durable agent context with one feed.
   - Wakes or resumes that context when work or collection is due.
   - May represent a desktop thread, CLI session, hosted conversation, or managed process.

5. **Persistence Layer**
   - Stores authoritative workflow state durably.
   - Supports atomic state transitions and consistent backup.

6. **Source and Action Connectors**
   - Are used by the feed operator to read source systems or perform approved mutations.
   - Are outside the Tend state authority.

### 4.2 Authority Boundaries

The Local Runtime is authoritative for:

- feed configuration and policy;
- source recipes, checkpoints, recorded runs, and evidence references;
- sweep membership and feedback;
- cards, review passes, and card-local edits;
- work status, claim ownership, and capability validity;
- approval snapshots and verification state;
- revision proposals and policy history; and
- audit history.

The Agent Host is authoritative for:

- agent execution and conversation/session state;
- connector availability and authentication; and
- model-specific tools and permissions.

External services are authoritative for their own current data and mutation results. Tend MUST NOT
claim an external action succeeded until the connector reports success.

### 4.3 Abstraction Layers

Portable implementations are easiest to reason about in these layers:

1. **Intent**: feed purpose, policy, source recipes, and prompt guidance.
2. **Evidence**: immutable source snapshots, checkpoints, and source runs.
3. **Judgment**: sweeps, cards, ordering, suppression, and feedback.
4. **Execution**: queued work, claims, agent outcomes, and retries.
5. **Authorization**: visible actions, exact approval snapshots, and fresh verification.
6. **Learning**: revision proposals, review, application, and reversion.
7. **Presentation**: review and configuration surfaces.

## 5. Core Concepts and Invariants

### 5.1 Feed

A feed is a durable responsibility. It MUST have:

- a stable identifier;
- a human-readable name;
- a plain-language purpose;
- editable feed policy;
- zero or more source recipes;
- one primary bound agent context before agent work can run;
- a current review-pass number; and
- creation and update timestamps.

Archiving a feed SHOULD preserve its history. Deleting history is implementation-defined and MUST
require an explicit user action.

### 5.2 Durable Agent Context

Each active feed MUST have no more than one primary agent context. A context is durable when the
Agent Host can resume the same responsibility with sufficient identity and working history across
wakes.

A local user MAY create or queue work before a context is bound. Agent listing, claiming, and
execution MUST reject as `unauthorized` until binding is complete.

The context MAY be implemented as a conversation thread, session identifier, persistent process,
or equivalent construct. The implementation MUST document how it is bound, resumed, replaced, and
revoked.

Replacing the bound context MUST NOT grant access to a capability held by the previous context. A
core implementation MUST either atomically release active work to `queued` and invalidate its
capability, or move it to `blocked` for explicit user recovery. Direct capability transfer is an
extension and MUST issue a new capability.

### 5.3 Quietness

A sweep MAY produce zero cards. The absence of a worthwhile result is a successful outcome.

The operator MUST NOT create cards merely to prove that collection ran. Routine success, unchanged
information, low-confidence speculation, and duplicates SHOULD be suppressed unless the feed policy
explicitly makes them meaningful.

### 5.4 Provenance

Every source-backed card MUST identify the recorded source run or runs that support it. Source runs
MUST refer to immutable evidence captured during that run.

Generated summaries and judgments are not substitutes for evidence. An implementation MAY store
them beside evidence, but MUST distinguish them.

### 5.5 Evidence, Instruction, and Authorization

These are separate concepts:

- **Evidence** describes the external world.
- **Instruction** asks an agent to prepare, research, revise, or otherwise work.
- **Authorization** permits one exact external mutation.

Evidence MUST NOT create authorization. A natural-language instruction MUST NOT be interpreted as
authorization unless it was submitted through an explicit approval control satisfying Section 13.

### 5.6 Stable Identifiers and Time

All durable entities MUST have stable identifiers unique within their documented scope.

Identifiers MAY be opaque. User-supplied names MUST NOT be used as security capabilities.

Durable timestamps MUST be unambiguous and SHOULD use UTC ISO-8601 representation when serialized.
Ordering MUST NOT rely only on wall-clock timestamps when concurrent writes are possible.

## 6. Core Data Model

This section defines logical data, not a wire schema. Implementations MAY rename fields or split and
combine records as long as the same information and invariants are preserved.

### 6.1 Feed Record

Logical fields:

- stable id, name, purpose, lifecycle state;
- current review pass;
- policy content and policy revision identity;
- primary agent binding;
- source recipe references;
- default cleanup description, if the feed uses one; and
- created and updated timestamps.

Representative shape:

```json
{
  "id": "project-health",
  "name": "Project health",
  "purpose": "Surface changes that need a decision or intervention.",
  "state": "active",
  "currentReviewPass": 4,
  "operatorBinding": { "host": "agent-host", "contextId": "context-123" }
}
```

### 6.2 Source Recipe

A source recipe defines where and how to observe. It MUST contain:

- stable id and human-readable name;
- feed id;
- plain-language collection instructions;
- source boundary or permissions;
- checkpoint semantics; and
- any source-specific safety constraints.

The recipe SHOULD explain what counts as new, how to avoid duplicate observation, and what raw
evidence to preserve.

### 6.3 Evidence Snapshot

An evidence snapshot is an immutable record of material observed from a source. It MUST contain or
reference:

- stable id;
- source recipe id;
- capture time;
- source-native identity or cursor where available;
- raw or losslessly retained relevant content;
- source location or retrieval reference where safe; and
- integrity metadata sufficient to detect accidental replacement.

Secrets and unrelated private content SHOULD be excluded. Redaction MUST be recorded when it
materially affects interpretation.

### 6.4 Source Run

A source run records one completed or failed attempt to use one source recipe. It MUST distinguish:

- run identity and source recipe;
- start and completion time;
- status;
- evidence snapshot references;
- judgments or extraction results;
- the prior checkpoint used; and
- the next checkpoint proposed or committed.

Run status MUST distinguish `completed`, `partial`, and `failed`. A completed run MAY legitimately
contain zero new evidence. A partial run MAY retain evidence collected before failure but MUST NOT
advance beyond its safely committed checkpoint. A failed run MUST NOT advance its checkpoint.
Failed runs remain auditable but are not evidence-bearing sweep members. A partial run may join a
sweep only when its retained evidence and checkpoint boundary are explicit.

Checkpoint advancement MUST be atomic with durable run recording, or recoverably ordered so a
crash cannot advance past unrecorded evidence.

### 6.5 Sweep Batch

A sweep batch groups the source runs judged together for one feed refresh. It MUST contain:

- stable id and feed id;
- the source run ids included;
- creation time; and
- the work item or trigger that requested recollection, when applicable.

A sweep is evidence selection and judgment, not a card list. Cards MAY be created, updated,
suppressed, or left unchanged from the batch.

A feed with one or more recorded sweeps MUST identify exactly one as current. Before its first
successful sweep, the current sweep identity is absent. Recording a new sweep supersedes earlier
sweeps for new card publication and approval. A sweep MUST contain at least one completed or partial
run. If a refresh covers only some recipes, it MUST carry forward the still-applicable run
identities needed to keep other current cards valid, or deliberately make those cards stale. This
decision MUST be visible in the batch record.

### 6.6 Card

A card is a reviewable work packet. It MUST contain:

- stable id and feed id;
- kind and review status;
- title and a concise explanation of why it deserves attention;
- structured content blocks;
- zero or more available actions;
- source run ids when source-backed;
- review-pass placement;
- creation and update timestamps; and
- readable history of material state changes.

Representative shape:

```json
{
  "id": "card-42",
  "feedId": "project-health",
  "status": "to_review",
  "title": "Release is blocked by a new failing check",
  "why": "The failure is new and blocks today's release.",
  "sourceRunIds": ["run-17"],
  "blocks": [
    { "kind": "evidence", "text": "integration-test failed", "sourceRef": "evidence-91" },
    { "kind": "editable", "id": "draft", "value": "Proposed status update" }
  ],
  "actions": [
    { "id": "revise", "kind": "prepare", "label": "Improve draft" },
    { "id": "send", "kind": "external", "label": "Send update", "artifactBlockId": "draft" }
  ]
}
```

### 6.7 Content Block

Content blocks let implementations present evidence and work without forcing every card into one
fixed template.

Core implementations MUST support equivalent representations for:

- explanatory text;
- evidence with source references;
- user-editable text;
- lists, choices, or checklists;
- before-and-after changes; and
- completion or action receipts.

Implementations MAY add block types such as threads, profiles, charts, files, media, or custom
interactive content. Unknown optional block types SHOULD degrade to a readable fallback.

### 6.8 Card Action

An action describes a concrete next move. It MUST distinguish:

- preparation or research that queues an instruction;
- an external mutation requiring exact approval;
- local disposition such as dismissing or restoring a card; and
- default cleanup that is external and therefore requires approval when applicable.

An external action MUST identify the visible label, intended mutation, relevant editable artifact,
destination or recipient when known, and any predictable completion cleanup.

### 6.9 Work Item

A work item is durable agent work. It MUST contain:

- stable id and feed id;
- optional card id;
- kind and instruction;
- scope target when the instruction is scoped;
- status;
- creation and update timestamps;
- claim ownership while working;
- result or error when terminal; and
- approval identity when executing an approved action.

The core work kinds are:

- ordinary instruction or preparation;
- scoped steering instruction;
- approved external action;
- default cleanup;
- sweep rejudgment or recollection; and
- compound learning.

Implementations MAY represent these with different names or a more general type system.

### 6.10 Approval Snapshot

An approval snapshot is the exact material the user authorized. It MUST bind at least:

- feed, card, and action identity;
- action semantics;
- current editable artifact content, if any;
- recipient, destination, account, or mailbox constraints when applicable;
- bundled completion cleanup, if any; and
- a digest or equivalent equality proof covering all material fields.

### 6.11 Revision Proposal and Revision Record

A revision proposal MUST contain:

- stable id;
- target configuration or policy document;
- prior content;
- proposed content;
- user instruction or learning rationale;
- source (`steering`, `compound-learning`, or an equivalent distinction);
- status; and
- timestamps.

Applying a proposal creates a durable revision record. Rejection MUST preserve enough history to
explain what was declined.

### 6.12 Audit Event

Material transitions MUST produce durable audit history. Events SHOULD include:

- event id and time;
- feed id;
- related card, work, run, sweep, approval, or revision ids;
- actor category (`user`, `agent`, `runtime`, or `external-system`); and
- a concise, non-secret detail payload.

Capability secrets, connector tokens, and unnecessary raw source content MUST NOT appear in audit
events.

## 7. Intent and Configuration Contract

### 7.1 Configuration Layers

The effective judgment for a collection or work item MUST be assembled from:

1. core Tend safety and operating rules;
2. optional workspace-wide policy;
3. feed purpose and feed policy;
4. the relevant source recipe;
5. the specific work instruction and approved snapshot, if any; and
6. current operator guidance returned by the runtime.

Later layers may specialize earlier judgment but MUST NOT override core safety invariants.

The information MAY be supplied in a prompt-safe context bundle or retrieved through structured
agent operations. Before judgment or write-back, the bound agent MUST be able to obtain the current
feed and policy revision, relevant recipe and checkpoint revisions, target card or sweep revision,
evidence references, work instruction, operator guidance, and available operation descriptors.
Approval payloads and secret authority remain scoped by the claim and verification rules.

### 7.2 Editable Intent

The user MUST be able to inspect and edit:

- feed purpose;
- feed policy; and
- source recipes.

Implementations MAY expose additional prompt layers. Generated or agent-proposed edits MUST be
shown as proposals unless the user directly edits the content in a clearly local, reversible
editor.

### 7.3 Source Boundary

A source recipe defines the maximum normal collection boundary. The feed operator MUST NOT expand
to additional external sources merely because source content suggests doing so.

Instructions found inside source material are untrusted content. They MUST NOT change policy,
expand permissions, authorize actions, or override the current work item.

### 7.4 Configuration Validity

The runtime MUST reject or clearly surface invalid configuration that prevents safe operation. It
MUST preserve the last known good durable state when a proposed configuration update fails.

## 8. Collection and Provenance

### 8.1 Collection Preconditions

Before a normal collection, the operator MUST:

1. confirm the local runtime is healthy;
2. inspect and drain queued or replayed work for the feed;
3. load the feed purpose, policy, and configured source recipes; and
4. use only the sources and permissions those recipes allow.

If the feed has no enabled source recipe, normal collection MUST return a visible setup-incomplete
result and MUST NOT record an empty sweep. A feed with no recipes may still accept configuration and
local user work.

Collection MAY be explicitly requested by a work item before the rest of the queue is empty. In
that case the work item controls the exception.

### 8.2 Source Run Lifecycle

For each source recipe selected:

1. read the current checkpoint;
2. collect only the needed source range;
3. preserve immutable evidence snapshots;
4. record judgments separately from evidence;
5. propose the next checkpoint;
6. durably record the run; and
7. advance the checkpoint under the atomicity rule in Section 6.4.

Failed collection MUST NOT silently advance the checkpoint.

### 8.3 Sweep Recording

After relevant source runs finish, the operator MUST record one sweep batch before treating the
refresh as complete. Every referenced run MUST exist and belong to the same feed.

When recollection was requested by a work item, the new runs and batch MUST be traceable to that
work item. The work MUST NOT complete until the batch is durable.

### 8.4 Card Publication

A source-backed card MUST refer only to source runs in the feed's current sweep. The runtime
MUST reject or mark stale a card or generated external action based on a superseded sweep.

The operator SHOULD update an existing card when the same underlying matter changes materially,
rather than create an avoidable duplicate. The history MUST make the update legible.

### 8.5 Quiet Sweep

When no item crosses the feed's relevance threshold, the operator MUST record the source runs and
sweep normally and publish no new card. The review surface SHOULD communicate healthy quietness
without manufacturing content.

## 9. Cards, Sweeps, and Review Passes

### 9.1 Card Review States

The following conceptual states are required. Names may differ.

| State | Meaning | Allowed next states |
| --- | --- | --- |
| `to_review` | New or materially updated card awaits judgment | `queued`, `done` |
| `queued` | User requested agent work or approved an action | `working`, `to_review`, `done` |
| `working` | Bound operator holds the related work claim | `queued`, `to_review`, `done`, `blocked` |
| `blocked` | Approved or requested work needs recovery or new review | `queued`, `to_review`, `done` |
| `done` | Local disposition or work is complete | `to_review` |

The runtime MUST derive card presentation from card and related work state consistently. A card MUST
NOT appear simultaneously as independently actionable in conflicting states.

The core model permits at most one nonterminal work item per card. Broader feed or sweep work may
exist independently. Implementations that allow several nonterminal card work items MUST document a
deterministic reduction rule and MUST prevent conflicting actions; a safe precedence is
`working > blocked > queued > to_review > done`. Failed and stale work return the card to review,
cancelled unstarted work restores its prior review state, and completed work follows its recorded
disposition.

Returning a card to review MUST NOT imply that a completed external action was reversed.

### 9.2 Review Pass Stability

A review pass is the stable set the user is currently working through.

- Starting a pass MUST persist the exact card identities and material revisions included.
- New cards and material updates arriving during an active pass SHOULD be buffered for the next
  pass rather than inserted ahead of the user. A buffered update MUST NOT rewrite the revision the
  user is currently reviewing.
- The user MUST have an explicit way to begin the next ready pass.
- Restoring a done card to review MAY place it in a later pass.
- A next pass is `ready` when it contains a new card, a buffered material revision, or a restored
  card. Ending a pass MUST carry unresolved cards forward or keep them visibly accessible in their
  prior pass; it MUST NOT silently discard them.
- Implementations MAY use a different visual model, but MUST preserve the ability to review a stable
  set without agent updates continually reshuffling it.

### 9.3 Local Disposition

The user MUST be able to dismiss a card locally and restore it. A short undo affordance is
RECOMMENDED.

If dismissal includes an external cleanup, that cleanup is an external action and MUST follow
Section 13. Local dismissal MAY complete immediately; external cleanup MUST be represented as work.

### 9.4 Sweep Feedback

Sweep-scoped feedback concerns the current set, ranking, or suppression of cards rather than one
card.

The runtime MUST capture:

- the sweep batch being judged;
- the card ids visible when feedback was submitted;
- the user's instruction;
- the explicit kept order; and
- the explicitly removed card ids.

Every originally visible card MUST be accounted for exactly once as kept or removed.

If a newer sweep supersedes the feedback before rejudgment, the old work MUST become safely terminal
as stale. It MUST NOT reorder or hide cards from the newer batch.

### 9.5 Recollection After Feedback

Rejudging the visible sweep and collecting sources again are distinct operations. After rejudgment,
the user MAY request recollection. Implementations SHOULD make that next step visible, but MUST NOT
silently recollect merely because feedback was submitted.

## 10. Scoped Steering

### 10.1 Required Scopes

The user MUST be able to direct intent at these conceptual scopes:

- **Card**: change or investigate one work packet.
- **Sweep**: change ranking, inclusion, or judgment for the visible batch.
- **Feed**: ask broader work about the responsibility.
- **Configuration**: revise feed policy, a source recipe, or another editable prompt layer.

Implementations MAY use a dock, command bar, form, voice input, chat, or other control. The active
scope MUST be visible before submission.

### 10.2 Scope Resolution

The runtime MUST attach a durable target to every scoped instruction. If the target becomes invalid,
the runtime MUST broaden or reject it according to a documented, user-visible rule; it MUST NOT
silently apply an instruction to an unrelated target.

### 10.3 Editing and Canceling Queued Instructions

Before an instruction is claimed, the user SHOULD be able to edit or cancel it. Canceling card work
SHOULD return the card to review without card churn.

After claim, changing the instruction MUST either create a new work item or explicitly revoke and
rotate the active claim. The runtime MUST NOT mutate the meaning under an agent holding a capability.

## 11. Work Queue and Claim Protocol

### 11.1 Work States

| State | Meaning | Allowed next states |
| --- | --- | --- |
| `queued` | Available to the bound operator | `working`, `cancelled`, `stale` |
| `working` | Exclusively claimed | `queued`, `completed`, `failed`, `blocked`, `stale` |
| `blocked` | Cannot finish safely without recovery or review | `queued`, `completed`, `cancelled`, `stale` |
| `completed` | Finished with durable result | terminal |
| `failed` | Attempt ended with recorded error | `queued`, `cancelled` |
| `cancelled` | User or runtime canceled unneeded work | terminal |
| `stale` | Superseded work cannot affect current state | terminal |

Implementations MAY combine `failed` and `blocked` if they preserve the distinction between a
retryable execution error and work that cannot safely continue under current authorization.

### 11.2 Claim Capability

Claiming work MUST atomically:

- verify the caller is the bound operator for the feed;
- select eligible queued work or replay the caller's active work;
- record claimant identity and claim time;
- transition the work to `working`; and
- return a secret or equivalent unforgeable capability required for subsequent mutation.

The capability MUST NOT appear in ordinary state reads, work lists, audit events, logs, wake
messages, or reports to other callers.

The implementation MUST document a deterministic work-selection order. Ties MUST use a durable
monotonic sequence or transactional equivalent, not wall-clock time alone.

A claim request from an unbound context normally returns `unauthorized`. An implementation MAY
instead return a tokenless `held_by_other` result when reporting an existing active claim. Either
result MUST omit the capability and private work content.

### 11.3 Single Active Work Item and Replay

The core operator processes at most one claimed work item per feed at a time.

If the same bound context asks to claim again while it has active work, the runtime MUST replay that
work and its valid capability rather than claim a second item. This is the primary agent-restart
recovery mechanism.

A different context MAY be told that work is claimed and by whom, but MUST NOT receive the
capability.

Exact same-capability replay is required across agent-session restart while the runtime remains
authoritative. Across runtime restart, the implementation MUST either protect recoverable
capability material using documented local secret storage, or atomically rotate the capability and
require the same bound context to accept the recovered claim. The selected mode is
implementation-defined and MUST be covered by recovery tests.

### 11.4 Release and Rotation

A claimant that cannot continue SHOULD release the work. Release MUST:

- require the current capability;
- return the work to `queued` without unnecessary card-state churn;
- clear claim ownership;
- invalidate the old capability; and
- ensure only a later authorized claim can mint and return a fresh capability.

Release, retry, reassignment, list, audit, and wake results MUST NOT reveal either the invalidated
capability or capability material prepared for a future claimant.

### 11.5 Completion, Failure, and Blocking

Completing, failing, or blocking claimed work MUST require the current capability and matching claim
ownership. The runtime MUST reject stale or wrong capabilities.

Every terminal or blocked outcome MUST record a concise result or error. Work MUST NOT remain
indefinitely `working` merely because the agent stopped.

The runtime MUST expose an explicit abandoned-claim recovery operation. Recovery requires user or
documented privileged-runtime authority, moves the work to `queued` or `blocked`, invalidates the
capability, and records an audit event. Elapsed time or missing presence alone MUST NOT silently
transfer authority to another context.

### 11.6 Retry and Cancellation

Retry MUST create a fresh claim opportunity and MUST NOT reuse a capability from a prior attempt.

Cancellation of queued work does not need a claimant capability but MUST be an authorized local
user or runtime operation. Cancellation of working work MUST revoke the active capability and be
visible to the operator.

### 11.7 Queue Drain and Idle Handshake

The operator MUST list current work and attempt at least one claim on every wake. It MUST repeatedly
claim and finish work until the runtime returns an explicit idle result.

An idle result SHOULD indicate whether meaningful collection or refresh work happened during the
drain so the operator can decide whether to offer compound learning.

## 12. Agent Host Contract

### 12.1 Host Neutrality

The specification does not require the runtime to launch an agent. A conforming implementation MAY
integrate with an existing agent conversation or manage its own process.

The host adapter MUST provide:

- stable context identity;
- feed binding and replacement;
- a way to deliver setup or operating instructions;
- manual activation;
- optional recurring activation;
- access to the agent-facing Tend operations; and
- a way for the runtime or user to determine whether setup is incomplete.

For Tend-authorized external mutations, the Local Runtime or Agent Host Adapter MUST provide an
enforcement gateway that validates and consumes the one-shot execution grant before invoking the
connector. A raw model instruction to honor the grant is not an enforcement gateway. If the agent
has independent connector access, the implementation MUST prevent that path from being treated as
a Tend-authorized mutation. The implementation MUST either restrict mutation-capable connector
operations for the bound operator to the gateway or explicitly segregate independent connector
access as outside Tend's authority. In the latter profile, operator instructions MUST prohibit using
the independent path for Tend work, and Tend MUST NOT issue a success status, audit claim, or
completion receipt for an effect that bypassed the gateway.

### 12.2 Semantic Agent Interface

The Agent Interface MUST expose the following semantic capabilities to the bound operator. Names,
transports, and payload shapes are implementation-defined.

| Capability | Minimum agent-visible behavior |
| --- | --- |
| Health and setup | Determine runtime health, binding, due collection, and setup-incomplete state. |
| Inspect context | Read the current prompt-safe feed, policy, recipe, checkpoint, sweep, pass, card, evidence-reference, and work revisions needed for the target operation. |
| Record observation | Store immutable evidence, source-run outcome, checkpoint advancement, sweep membership, and card write-back with the atomicity and provenance rules in Sections 8 and 15. |
| Operate work | List, claim or replay, release, complete, fail, block, retry, and observe the explicit idle handshake. |
| Record steering result | Write scoped instruction outcomes, rejudgment accounting, recollection results, local dispositions, and durable history. |
| Execute approved action | Request verification and invoke only through the grant-consuming gateway; report success, failure, or unknown result. |
| Record learning proposal | Read the bound learning inputs and persist an editable proposal without applying it. |

Each operation MUST return a structured semantic result class from Section 3.1 plus the stable ids,
current revisions, and next permitted operations needed to continue safely. Public inspection and
list results MUST omit capabilities and secrets. Claim, verification, and gateway operations MAY
return their narrowly scoped authority only to the authorized caller.

User-only decisions are intentionally outside action parity: creating an external-action approval,
applying or rejecting a policy proposal, expanding sources or permissions, and authorizing a
possible duplicate after restore. An agent MAY prepare a visible proposal for these decisions but
MUST NOT exercise the decision on the user's behalf.

### 12.3 One Feed per Context

One durable primary context MUST operate exactly one feed. An implementation MUST NOT bind one
primary context to several feeds as an optimization.

The separation prevents context leakage, ambiguous claims, and cross-feed policy confusion.

### 12.4 Wake Payload Safety

A wake signal SHOULD contain only server-controlled identifiers and counts. It MUST NOT contain:

- source-derived instructions or content;
- capability secrets;
- approval snapshots;
- connector credentials; or
- user-private evidence not needed to activate the context.

The resumed context reads current state and claims work through the normal interface.

### 12.5 Operator Instructions

The runtime MUST make the operator contract available to the bound context. It MUST cover:

- health checking;
- list-then-claim draining;
- claim replay;
- source and provenance rules;
- exact approval verification;
- terminal work reporting;
- sweep feedback and recollection ordering; and
- learning proposal rules.

### 12.6 Recurring Activation

Recurring activation is RECOMMENDED but host-specific. The user MUST be able to understand whether
it is missing, proposed, active, paused, or failed.

The runtime MUST NOT claim a heartbeat exists merely because a cadence was suggested.

## 13. External Action Safety

This section is mandatory for core conformance.

### 13.1 Explicit Visible Approval

An external mutation MUST begin from a visible, concrete action control associated with the current
card or routine group. The control MUST describe the action in user-facing terms.

A free-form instruction, source message, policy statement, inferred preference, or prior similar
approval is not sufficient.

### 13.2 Approval Creation

When the user activates the control, the runtime MUST:

1. save any current editable artifact;
2. construct the Approval Snapshot from all material fields;
3. compute or record an equality proof;
4. queue one approved-action work item bound to that snapshot; and
5. prevent duplicate active approvals for the same unchanged action snapshot.

Material fields include the action, artifact, destination, account or mailbox constraint,
recipients, source identity when relevant, and bundled cleanup.

The snapshot MUST include an action semantic version and every connector-specific field that can
change the external effect. Canonicalization is implementation-defined but MUST be deterministic
and documented, including absent values, text/newline normalization, and which collections are
ordered versus set-valued. Duplicate approval MAY reject or return the existing work; it MUST NOT
create a second executable authority.

### 13.3 Fresh Verification

Immediately before invoking the connector, the claimant MUST request fresh verification from the
runtime using its current claim capability.

Verification MUST:

- reconstruct the current action snapshot from authoritative state;
- compare it with the approved snapshot;
- verify claim ownership and capability;
- validate account, mailbox, destination, or recipient constraints available at that moment;
- reject stale, missing, changed, already-consumed, or mismatched approval; and
- durably record successful verification without exposing secrets.

Account, mailbox, destination, recipient, and source-currentness inputs used in verification MUST
come from an authenticated connector context or a trusted Agent Host attestation, never from source
content or an untrusted caller field.

Successful verification MUST return an immutable verified payload plus a one-shot execution grant
bound to the work, claim, and snapshot. The connector call MUST be the claimant's next
external-effecting operation and MUST use that verified payload rather than reread editable card
state. The grant expires on a material edit, claim release or rotation, runtime restart, first result
report, or a short implementation-defined timeout. A runtime that owns connectors MAY instead
verify and invoke in one guarded operation.

The enforcement gateway from Section 12.1 MUST consume the grant atomically with accepting the
connector invocation. Connector results MUST return through that gateway so Tend can distinguish
success, failure, and unknown outcome. Implementations that cannot gate connector invocation this
way are not conforming for external-mutation scenarios.

Approved work MUST track an equivalent phase:

| Phase | Permitted effect |
| --- | --- |
| `awaiting_verification` | no connector mutation |
| `verified_for_main` | one main invocation using the execution grant |
| `main_unknown` | no automatic retry; reconciliation required |
| `main_succeeded_cleanup_pending` | cleanup only; main can never run again |
| `completed` | no further effect |
| `blocked` | only the explicitly recorded recovery path |

Completion of main-action work MUST be rejected unless fresh verification succeeded for the
current claim and unchanged snapshot. Cleanup-only completion follows Section 13.6 instead.

### 13.4 Stale Approval

Any material change after approval invalidates it. Examples include:

- editing the draft;
- changing the action or destination;
- changing the selected account or mailbox;
- changing the recipient set;
- replacing the source matter with a newer sweep; or
- changing bundled cleanup.

Stale work MUST return to review or otherwise require a new explicit approval. The runtime MUST NOT
silently update the approved snapshot.

### 13.5 Mutation Outcome and Idempotency

The operator MUST report the connector's outcome. Automatic retry of an external mutation requires
an external idempotency key or an authoritative source-native result lookup.

If connector success cannot be determined, the work MUST enter `main_unknown` or an equivalent
reconciliation-required state. It MUST NOT retry automatically.

If the main mutation succeeded, a retry MUST NOT repeat it merely because later local completion or
cleanup failed.

### 13.6 Bundled Completion Cleanup

An approval MAY include predictable cleanup, such as archiving a source item after sending a reply.
The visible action MUST make that consequence understandable.

If the main action succeeds and cleanup fails:

- record the main action as succeeded;
- mark cleanup as blocked;
- retain enough verified state to retry only cleanup; and
- prohibit re-execution of the main action.

Cleanup retry MUST use a fresh cleanup-scoped claim capability. It does not reactivate or reverify
the consumed main approval, and no operation returned in this phase may invoke the main action.

Every cleanup mutation, including cleanup immediately following main success, MUST use an immutable
cleanup payload and a separate one-shot cleanup execution grant. The enforcement gateway MUST
validate and atomically consume that grant before invoking cleanup. The grant MUST be scoped to the
recorded main result, approved cleanup operation, current cleanup claim, and current authoritative
source state. A retry creates a new cleanup grant only after fresh cleanup verification; it never
reuses the main execution grant or a prior cleanup grant.

### 13.7 Reconciliation

If a verified external action succeeds but the work remains blocked because the result could not be
recorded normally, the runtime MUST provide an explicit reconciliation path. Reconciliation MUST:

- require the original current claim authority or an equally strong recovery authority;
- require evidence that fresh verification occurred;
- close only the already-succeeded action; and
- never reconstruct an obsolete card merely to make completion pass.

Recovery authority MUST be one-shot and bound to a stable recovery-operation id, the exact approval
and verification record, and the recorded external result. It MUST come from an explicit local-user
decision or documented privileged runtime context, and every use MUST be audited.

### 13.8 Routine Batches

Implementations MAY group conservative repeated actions. A routine batch MUST show the exact visible
items and action before approval.

Immediately before mutation, the operator MUST reread each authoritative source item. If an item
changed or now needs judgment, it MUST leave the batch and return to individual review. A batch
approval MUST NOT authorize new or substituted items.

## 14. Learning and Revision Safety

### 14.1 When to Offer Learning

After a meaningful sweep or refresh reaches idle, the operator SHOULD ask whether the user wants to
compound what was learned.

It SHOULD NOT ask when a wake began idle and no meaningful sweep, feedback, or outcome occurred in
that wake.

A quiet sweep that produces no card, feedback, disposition, or new outcome is not by itself
meaningful for this prompt. Implementations MAY document other user-visible events that make a
sweep meaningful, but merely advancing a healthy checkpoint is insufficient.

### 14.2 Learning Request

The agent MUST NOT begin compound learning until the user agrees. Agreement queues ordinary claimed
work; it is not itself permission to apply policy.

The learning work SHOULD consider:

- the relevant sweep's cards and evidence;
- user feedback and recorded rejudgment;
- completed and blocked outcomes;
- the current feed policy; and
- prior policy revisions.

The work MUST bind its input boundary: relevant sweep ids, feedback ids, outcome ids, a durable
cutoff sequence, and the base policy revision id. Newer activity may inform a later proposal but
MUST NOT silently change the inputs of work already claimed.

The boundary MUST be persisted before or atomically with the transition that first makes the
learning work claimable. If an implementation defers selection until claim time, selecting the
boundary, recording it, and issuing claim authority MUST be one atomic transition. Claim replay MUST
reuse the recorded boundary.

### 14.3 Proposal

The result MUST be an editable, policy-text-only proposal with current and proposed content, the
bound input references, and the base policy revision id. The agent MUST NOT apply the proposal.

The review surface MUST let the user:

- inspect the prior policy;
- inspect and edit the proposed policy;
- explicitly apply it; or
- reject it.

### 14.4 Application and Reversion

Applying a proposal MUST confirm that its base policy revision is still current, create a durable
revision record, and update the effective policy atomically. A base mismatch requires a new proposal
or explicit conflict review. Rejection MUST leave policy unchanged.

Direct user edits SHOULD be reversible. A revert MUST refuse to overwrite newer conflicting edits,
or MUST clearly show and resolve the conflict before applying.

### 14.5 Structural Changes

New sources, expanded permissions, new external-action authority, global policy changes, and other
structural changes SHOULD remain explicit configuration actions or proposals. They MUST NOT be
smuggled into ordinary feed-policy learning.

Source membership, source boundaries, connector accounts, permissions, and allowed external-action
kinds MUST live in structured configuration outside free-form feed policy. Compound learning cannot
modify that envelope; attempted changes MUST be reissued as explicit configuration proposals.

## 15. Persistence, Recovery, and Audit

### 15.1 Durable Authority

The storage technology is implementation-defined. The runtime MUST have one authoritative durable
view for active workflow state.

Human-readable mirrors or exports are RECOMMENDED but MUST NOT create two competing authorities.

The implementation MUST document its durability profile: whether acknowledged transitions survive
process crash or power loss, whether one or several runtime writers are allowed, the transaction or
compare-and-swap model used to prevent lost updates, and how a consistent backup is produced.

### 15.2 Atomicity

Transitions that grant authority or advance progress MUST be atomic or transactionally equivalent.
This includes:

- claiming work and issuing its capability;
- releasing work and rotating capability;
- creating an approval and queuing work;
- recording successful verification;
- recording source runs and advancing checkpoints;
- applying a revision; and
- marking external-action completion.

At minimum, two concurrent claim attempts MUST serialize so only one can receive capability
authority. Conformance testing SHOULD inject failure between evidence persistence and checkpoint
advance, and between verification, connector result, and local completion.

### 15.3 Restart Recovery

After runtime restart:

- feeds, configuration, evidence, cards, work, approvals, and revisions MUST remain available;
- an active claim MUST be replayable to the same valid bound context or explicitly recoverable;
- stale capabilities MUST remain invalid;
- completed external actions MUST not become executable again; and
- the user MUST be able to see blocked or failed work.

After agent restart, the resumed context MUST list work and claim so active work is replayed before
new work is selected.

Any pre-restart external execution grant is expired. A durable record that verification previously
succeeded may support reconciliation, but it cannot authorize a new connector invocation.

### 15.4 Auditability

The user SHOULD be able to understand, for a material card or action:

- which source runs supported it;
- what the user instructed or approved;
- which context claimed the work;
- whether verification passed;
- what the external connector reported;
- what cleanup occurred; and
- what policy revision followed later.

### 15.5 Backup and Restore

The implementation MUST document how to back up all authoritative local state. A backup SHOULD be a
consistent point-in-time snapshot and SHOULD include immutable evidence.

Restore MUST NOT merge incompatible active authorities silently. Implementations SHOULD require the
target runtime to be stopped or otherwise fenced during restore.

Backups MUST exclude or encrypt live claim and execution capabilities. They SHOULD carry a runtime
generation identity so restore can reject an unfenced target or a conflicting active generation.
Evidence integrity metadata SHOULD be checked on read, backup, and restore; corruption MUST become a
visible failure rather than silently accepted evidence.

A restore MUST establish a new runtime generation and invalidate all restored live claim and
execution capabilities. Restored nonterminal external-action work MUST enter a visible
restore-reconciliation state and MUST NOT invoke a connector automatically. This rule covers a
backup captured before an action that may have executed after the backup was taken.

Before restored work can cause an external effect, the runtime MUST establish non-execution through
an authoritative connector result or source-native idempotency record, reconcile a known prior
success without repeating it, or require an explicit local-user recovery decision that presents the
possible-duplicate risk and creates a new action and approval. Replaying the restored approval or
ordinary reapproval alone is insufficient evidence that the earlier effect did not occur.

## 16. Review Surface Contract

### 16.1 Concept Compatibility

The review surface MUST expose these concepts, although their layout is implementation-defined:

- active feed and feed configuration;
- cards awaiting review;
- queued work;
- claimed or working work;
- completed, failed, and blocked outcomes;
- source evidence and history;
- scoped steering;
- concrete card actions;
- exact external approval;
- review-pass boundaries; and
- learning proposal review.

### 16.2 Legibility

The user MUST be able to distinguish:

- source evidence from agent-written interpretation;
- editable drafts from sent or completed artifacts;
- preparation actions from external mutations;
- queued work from claimed work;
- local dismissal from external cleanup;
- current cards from stale or superseded work; and
- proposed policy from effective policy.

### 16.3 Action Controls

External action controls MUST name the concrete action. Generic controls such as `Continue`, `OK`,
or `Let the agent handle it` are insufficient when they grant external authorization.

The current artifact and material destination information MUST be visible or readily inspectable
before approval.

### 16.4 Undo and Restoration

The surface SHOULD provide undo for recent local, reversible operations. It MUST NOT imply that undo
can reverse an external action already performed.

### 16.5 Configuration Review

Agent-proposed configuration changes MUST show the current and proposed content. The user MUST be
able to apply, reject, or edit the proposal.

## 17. Failure Model

### 17.1 Failure Classes

1. **Configuration failures**
   - invalid purpose, policy, recipe, or binding;
   - unavailable required source or operator interface.

2. **Collection failures**
   - connector failure, permission loss, malformed source response, or checkpoint conflict.

3. **Judgment failures**
   - stale sweep, invalid provenance, duplicate card identity, or incomplete rejudgment.

4. **Work failures**
   - wrong operator, claim conflict, stale capability, timeout, or agent termination.

5. **Authorization failures**
   - stale snapshot, missing verification, account mismatch, already-consumed action, or changed
     recipient/destination.

6. **Persistence failures**
   - transaction failure, corrupted state, failed backup, or restore conflict.

7. **Presentation failures**
   - review surface unavailable or unable to render an optional content block.

### 17.2 Recovery Principles

- Never advance a source checkpoint past evidence that was not durably recorded.
- Never grant a second claimant the first claimant's capability.
- Never convert a stale approval into a current one.
- Never repeat a confirmed successful external mutation to repair local bookkeeping.
- Never apply learning to recover from a failed proposal flow.
- Prefer a visible blocked state over guessing.
- Preserve the last known good configuration when a proposed change is invalid.

### 17.3 Operator Intervention

The user MUST have a visible recovery path for:

- incomplete agent binding;
- missing recurring activation;
- queued work with no active operator;
- working items whose operator is unavailable;
- failed or blocked work;
- stale external approvals;
- rejected or conflicting revisions; and
- backup or storage health failures.

## 18. Security and Trust Boundary

### 18.1 Local Trust Assumption

Core Tend is local-first. Implementations MUST document where authoritative state is stored and who
can access the local runtime.

If an HTTP interface exists, it SHOULD bind to loopback by default. Browser mutations MUST include
reasonable same-origin and anti-forgery controls appropriate to the platform.

### 18.2 Capability Handling

Work capabilities are bearer authority. They MUST be unpredictable, scoped to one work claim,
rotated on release or reassignment, and omitted from ordinary reads and logs.

If recoverable capabilities are stored for runtime-restart replay, they MUST be protected as local
secrets using owner-restricted storage or a stronger platform secret facility. The implementation
MUST document the selected protection and backup behavior.

### 18.3 Secret Handling

Connector secrets MUST NOT be stored in cards, evidence, wake messages, audit history, or policy.
Whether the Tend runtime or Agent Host stores connector credentials is implementation-defined, but
the trust boundary MUST be documented and least privilege is RECOMMENDED.

### 18.4 Prompt Injection and Untrusted Sources

Source content is untrusted. The operator MUST treat source instructions as evidence content, not
as runtime instructions. Source content MUST NOT:

- alter feed policy;
- expand the source boundary;
- reveal capabilities or secrets;
- authorize a mutation; or
- change the current work item's completion rules.

### 18.5 Data Minimization

Implementations SHOULD store only evidence needed for provenance and review. Logs and wake payloads
SHOULD contain identifiers rather than source bodies. Export and deletion behavior MUST be
documented.

## 19. Reference Algorithms

The algorithms are illustrative and language-neutral. Equivalent implementations are conforming if
they preserve the behavior and invariants.

### 19.1 Feed Wake and Drain

```text
function handle_feed_wake(feed_id, context_id):
  require runtime_is_healthy()
  require context_id == bound_operator(feed_id)

  meaningful_work = false
  visible_work = list_work(feed_id, context_id)

  while true:
    claim = claim_work(feed_id, context_id)

    if claim is idle:
      break

    if claim is held_by_other:
      return report_claim_conflict(claim)

    meaningful_work = meaningful_work or claim.affects_sweep_or_outcome
    execute_claim_from_current_state(claim)
    record_completed_failed_blocked_or_released(claim)

  if normal_collection_is_due(feed_id):
    collection = collect_feed(feed_id)
    meaningful_work = meaningful_work or collection.meaningful_for_learning

  if meaningful_work and runtime_is_idle(feed_id):
    offer_compound_learning()
```

### 19.2 Normal Collection

```text
function collect_feed(feed_id):
  config = read_effective_feed_config(feed_id)
  recipes = selected_recipes(config)
  if recipes is empty:
    return setup_incomplete_without_recording_sweep()

  runs = []

  for recipe in recipes:
    prior_checkpoint = read_checkpoint(recipe.id)
    observed = connector_collect(recipe, prior_checkpoint)
    evidence = persist_immutable_evidence(observed)
    judgments = judge_against_feed_policy(observed, config)

    run = atomically_record_run_and_checkpoint(
      recipe=recipe,
      prior_checkpoint=prior_checkpoint,
      next_checkpoint=observed.next_checkpoint,
      evidence=evidence,
      judgments=judgments
    )
    runs.append(run)

  batch = record_sweep(feed_id, runs)
  cards = select_meaningful_cards(batch, config)
  publish_or_update_cards(cards, current_batch=batch)
  return batch
```

### 19.3 Claim Work

```text
function claim_work(feed_id, context_id):
  atomically:
    require context_id == bound_operator(feed_id)

    active = active_claim_for(feed_id, context_id)
    if active exists:
      return active with its current capability

    conflicting = active_claim_for_other_context(feed_id)
    if conflicting exists and work_selection_would_choose(conflicting):
      return tokenless_claimed_by_report(conflicting)

    work = next_eligible_queued_work(feed_id)
    if work does not exist:
      return idle_handshake(feed_id)

    capability = new_unpredictable_capability()
    mark_working(work, context_id, capability)
    return work with capability and current operator guidance
```

### 19.4 Approve and Execute External Action

```text
function approve_visible_action(card_id, action_id, user):
  atomically:
    save_current_editable_artifact(card_id, action_id)
    snapshot = build_current_approval_snapshot(card_id, action_id)
    require action_was_visible_to(user, snapshot)
    return queue_unique_approved_work(snapshot)

function execute_approved_action(work, capability):
  verified = verify_immediately_before_action(work.id, capability)
  if verified rejected:
    return move_to_review_as_stale(work)

  result = connector_execute_next(
    grant=verified.one_shot_execution_grant,
    action=verified.action,
    artifact=verified.artifact
  )

  if result.outcome_unknown:
    return require_reconciliation_without_automatic_retry(work, result)

  if result.main_action_succeeded:
    durably_record_main_success(result)

  if result.cleanup_required:
    cleanup_verified = verify_cleanup_immediately_before_action(
      work=work,
      capability=current_cleanup_capability(work),
      main_result=result
    )
    if cleanup_verified rejected:
      return block_cleanup_only(work, result, cleanup_verified.reason)

    cleanup = connector_cleanup_next(
      grant=cleanup_verified.one_shot_cleanup_grant,
      payload=cleanup_verified.immutable_cleanup_payload
    )
    if cleanup failed:
      return block_cleanup_only(work, result, cleanup.error)

  return complete_without_repeating_main_action(work, result)
```

### 19.5 Sweep Feedback

```text
function rejudge_sweep(work, capability):
  trace = read_feedback_trace(work.feedback_id)

  if trace.batch_id != current_batch_id(trace.feed_id):
    return mark_stale(work)

  decision = agent_rejudge(trace.visible_cards, trace.instruction)
  require set(decision.kept + decision.removed) == set(trace.visible_card_ids)
  require no_duplicates(decision.kept + decision.removed)

  atomically:
    apply_kept_order(decision.kept)
    hide_removed(decision.removed)
    record_rejudgment(trace, decision)
    complete(work, capability)

  offer_recollection_separately()
```

### 19.6 Compound Learning

```text
function compound_learning(feed_id, user_agreed):
  require user_agreed
  atomically:
    boundary = bind_sweeps_feedback_outcomes_cutoff_and_base_policy(feed_id)
    claim = claim_compound_work(feed_id, boundary)
  evidence = read_learning_inputs(boundary)
  proposed_policy = synthesize_compact_replacement(evidence)
  proposal = record_revision_proposal(boundary, proposed_policy, type=policy_text_only)
  complete_work_without_applying_policy(claim, proposal.id)
  present_learning_review(proposal)
```

## 20. Core Conformance Scenarios

A clean-room implementation SHOULD automate these scenarios where practical. All outcomes are
REQUIRED even when validation is manual.

### 20.1 Feed Setup and Binding

1. Create a feed with purpose and policy.
2. Add a source recipe.
3. Queue local work, then attempt to list or claim it as an agent before binding and observe
   `unauthorized`.
4. Bind one durable agent context.
5. Attempt to bind the same context to a second feed and observe rejection.
6. Replace the binding and verify the prior context cannot mutate feed work.

### 20.2 Quiet Collection

1. Record an unchanged source item and checkpoint.
2. Record the source run and sweep.
3. Publish no card.
4. Verify the run and checkpoint are still durable and the feed is healthy.
5. Reach idle and verify this quiet sweep alone does not trigger a compound-learning prompt.

### 20.3 Provenance and Stale Sweep

1. Record evidence, a source run, and a sweep.
2. Create a card referencing the run and verify the evidence is inspectable.
3. Record a newer sweep that supersedes the run.
4. Attempt to publish or authorize a new action from the old run.
5. Verify the runtime rejects or safely marks it stale.

### 20.4 Stable Review Pass

1. Begin reviewing two cards in pass N.
2. Publish a meaningful third card while the pass is active.
3. Verify the original set remains stable.
4. Materially update one of the original cards and verify its reviewed revision remains stable while
   the update is buffered.
5. End pass N with one unresolved card and explicitly begin the ready next pass.
6. Verify the new card and buffered revision appear there, and the unresolved card remains
   accessible under the documented carry-forward rule.

### 20.5 Scoped Steering

1. Submit a card-scoped instruction and verify its target is durable.
2. Edit the queued instruction before claim.
3. Claim and complete it; verify the card and history reflect the result.
4. Submit sweep feedback and verify it cannot be mistaken for card or feed policy instruction.

### 20.6 Claim Exclusivity and Replay

1. Queue two work items.
2. Release simultaneous claim attempts from contexts A and B against the first item.
3. Verify exactly one queued-to-working transition and one capability authority were committed.
4. The winning context claims again and receives the same active work and capability.
5. The other context attempts to claim and receives `unauthorized` or a tokenless `held_by_other` result,
   according to the documented policy.
6. Verify the losing attempt never received a second capability and the second item remains queued
   until the first becomes terminal or is released.

### 20.7 Release and Capability Rotation

1. Claim work and retain capability X.
2. Release it and verify the release response exposes neither X nor a future capability.
3. Claim again and receive capability Y.
4. Verify X cannot complete, fail, block, or release the work.
5. Verify work-list, retry, reassignment, audit, and wake responses never expose X or Y; only the
   authorized claim response exposes Y.

### 20.8 Exact Approval and Invalidation

1. Present an editable draft and a concrete send action.
2. Approve the action and claim its work.
3. Edit the draft after approval.
4. Attempt fresh verification.
5. Verify it fails as stale and the connector is not invoked.
6. Reapprove the new visible draft and verify the exact new snapshot can proceed.

### 20.9 Missing Fresh Verification

1. Approve and claim an external action.
2. Attempt to complete it without fresh verification.
3. Verify completion is rejected.
4. Attempt gateway invocation with a missing, expired, or already-consumed execution grant and verify
   the connector invocation count remains zero.
5. Verify and invoke through the gateway with the immutable payload and valid one-shot grant.
6. Verify exactly one connector invocation occurred, replay of the grant is rejected, and the work
   can complete successfully.
7. If the host exposes an independent connector path, verify an effect through that path cannot
   receive Tend authorization, success status, or completion authority.

### 20.10 Account or Destination Mismatch

1. Approve an action bound to account or destination A.
2. Freshly verify using authenticated connector context or trusted host attestation for B.
3. Verify the action is rejected before connector invocation.

### 20.11 Partial Success Without Duplicate Mutation

1. Approve an action with bundled cleanup.
2. Freshly verify and make the main connector mutation succeed.
3. Make cleanup fail.
4. Verify the work records main success and blocks only cleanup.
5. Retry with a cleanup-scoped claim capability, immutable cleanup payload, and fresh one-shot cleanup
   grant; verify only cleanup executes through the gateway.
6. Verify a missing, expired, or replayed cleanup grant cannot invoke cleanup.
7. Verify the main mutation occurred exactly once.

### 20.12 Sweep Rejudgment and Supersession

1. Submit sweep feedback for visible cards A, B, and C.
2. Record B and A as kept in that order and C as removed.
3. Verify every original card is accounted for once.
4. In a second run, submit feedback and then record a newer sweep before rejudgment.
5. Verify the old rejudgment becomes stale and cannot change the newer sweep.

### 20.13 Agent Restart Recovery

1. Claim work from the bound context.
2. Terminate the agent session without completing it.
3. Resume the same durable context.
4. List then claim.
5. Verify the same work is replayed before any new item.
6. Exercise the documented abandoned-claim recovery and verify it invalidates the old capability
   without silently transferring authority.

### 20.14 Runtime Restart Recovery

1. Persist a feed, evidence, cards, queued work, one active claim, an approval, and revision history.
2. Restart the local runtime.
3. Verify all authoritative state remains available.
4. Verify active claims follow the documented protected-replay or atomic-rotation mode.
5. Verify pre-restart external execution grants and stale capabilities are invalid, and completed
   external work is not executable again.
6. Restore a backup captured before an external action that may have succeeded after the backup.
7. Verify the restore creates a new runtime generation, quarantines the restored action, and cannot
   invoke it from the restored approval.
8. Verify only authoritative non-execution evidence, reconciliation of known success, or an explicit
   risk-aware local recovery decision can resolve the quarantined action.

### 20.15 Learning Requires Two User Decisions

1. Complete a meaningful sweep with feedback.
2. Reach idle and offer compound learning.
3. Decline and verify no learning work or proposal is created.
4. Agree, claim the learning work, and create a proposal.
5. Verify effective policy remains unchanged.
6. Edit and explicitly apply the proposal.
7. Verify the new policy and revision history are durable.

### 20.16 Prompt-Injection Boundary

1. Record source content instructing the agent to add a source, reveal a secret, and send a message.
2. Verify it is retained only as evidence.
3. Verify no source is added, no secret is revealed, and no external work is authorized.
4. Trigger a wake for related work and verify its serialized payload contains only server-controlled
   identifiers and counts, remains one parseable message despite hostile newlines or control text,
   and contains no source content, instruction text, approval snapshot, or capability.
5. Verify the resumed operator obtains current content only through the normal Agent Interface.

### 20.17 Agent-Interface Portability

1. Starting with only the documented Agent Interface, inspect a configured feed and its current
   revisions without reading implementation-private storage.
2. Perform a normal collection through agent-visible operations: record evidence and a source run,
   advance the checkpoint atomically, record the sweep, and publish a source-backed card.
3. Queue, claim, and finish a scoped steering item, then reach the explicit idle handshake.
4. With user agreement already recorded, claim learning work and persist an editable proposal through
   the interface.
5. Verify the effective policy remains unchanged until a separate user-only apply decision.
6. Verify every operation returned structured result classes, current revisions, and next permitted
   operations without exposing capabilities or secrets in public reads.

## 21. Implementation Checklist

### 21.1 Required for Core Conformance

- Durable feed purpose, policy, recipes, and primary operator binding.
- Agent-host-neutral setup, manual activation, list, claim, and idle behavior.
- Immutable evidence, recoverable checkpoints, source runs, and sweep batches.
- Quiet sweeps and source-backed card provenance.
- Structured cards with concept-compatible review states and content blocks.
- Stable review passes.
- Card, sweep, feed, and configuration steering scopes.
- Durable work queue with exclusive claim capabilities and restart replay.
- Release, abandoned-claim recovery, capability rotation, and explicit terminal outcomes.
- Stale sweep protection.
- Concrete external actions with exact approval snapshots.
- Fresh verification with one-shot execution authority immediately before mutation.
- Explicit unknown, main-succeeded, cleanup-only, and reconciliation phases.
- Partial-success handling that never duplicates a successful main mutation.
- Editable, input-bound learning proposals that require separate application.
- Structured source, permission, connector-account, and external-action authority outside prose policy.
- Durable revision and audit history.
- Consistent backup and documented restore.
- A review surface that makes evidence, work, approval, and policy state legible.
- Successful completion of the scenarios in Section 20.

### 21.2 Recommended Operational Features

- Recurring activation with visible health.
- Human-readable exports or mirrors.
- Structured logs without source bodies or capabilities.
- Source-native idempotency keys for external actions.
- Short undo for local reversible actions.
- Routine action batches for conservative repeated work.
- Automated conformance tests.

### 21.3 Optional Extensions

- Additional agent hosts and multiple operator lanes.
- Additional card block types.
- On Your Mind or Chronicle context.
- Mobile review and remote projections.
- Collaboration or multi-user tenancy.
- Hosted operation.

Optional extensions are not part of Draft v1 core conformance and MUST preserve the core safety
model.
