# Tend Manual

This manual explains how to operate Tend after completing the
[Quick Start](./README.md#quick-start).

Tend is designed to stay open in Codex Desktop's in-app browser. The browser is the review and
steering surface; one dedicated Codex thread operates each feed.

## Command Notation

Examples use the packaged release command:

```sh
./tend
```

When running from source, replace it with:

```sh
pnpm tend --
```

For example:

```sh
./tend setup codex --feed inbox
pnpm tend -- setup codex --feed inbox
```

## The Operating Model

Each feed combines:

- a purpose: what deserves attention
- one or more source recipes: where and how Codex should look
- a feed policy: the judgment that should persist
- prompt layers: shared and feed-specific composition rules
- one dedicated Codex thread: the feed's operator
- one heartbeat: the recurring wake-up for that same thread
- a review queue: cards, routine actions, and work states

The normal loop is:

1. **Observe** sources.
2. **Review** the resulting cards.
3. **Steer** the card, sweep, or feed.
4. **Learn** by reviewing a proposed policy improvement.

The local Tend runtime owns feed state. Codex Desktop owns the agent threads and connector access.

## Creating And Connecting A Feed

### Create The Feed

Open the feed menu and choose **Create a feed**. Describe the outcome, sources, or decisions that
matter in plain English.

Examples:

```text
Show me important email that needs a reply, decision, or follow-up.
```

```text
Track new and closed Linear issues and GitHub pull requests for the Proof app each day.
```

```text
Summarize important Slack DMs, mentions, and messages that need action. Keep it read-only.
```

Tend creates the local feed, its initial policy, and an onboarding card. The feed's dedicated
thread then proposes the smallest useful source recipe and heartbeat cadence for review before
collecting.

The built-in Inbox feed is stricter than the example above: it enumerates the complete current
Gmail Inbox and maintains one review card per thread, including low-attention mail. See
[Inbox Sweep](./docs/INBOX_SWEEP.md) for its coverage, safety, and validation contract.

### Connect The Home Thread

Create one fresh Codex Desktop thread for the feed:

```sh
./tend setup codex --feed <feed-id>
```

Paste the complete output into that thread. The setup prompt asks Codex to:

1. bind the current thread as the feed's home thread
2. install or update one heartbeat on that same thread
3. follow Tend's local agent contract
4. drain queued work before refreshing sources
5. handle the feed once immediately

Do not bind the same thread to multiple feeds. The thread is the feed's durable working context and
operator identity.

### Wake A Feed Manually

Open or wake the bound feed thread and say:

```text
go deal with the feed
```

Use this when:

- the setup turn has not completed its first run
- its heartbeat is paused or missing
- you want an immediate source sweep
- queued work is waiting and you do not want to wait for the next heartbeat

## Reviewing A Feed

The feed is divided into four tabs:

- **To review** - new cards, updated cards, and proposed routine actions
- **Queued for Codex** - instructions or approvals waiting for the home thread
- **Working** - work currently claimed by the home thread
- **Done** - completed cards, instructions, and routine actions

### Cards

A card explains why something deserves attention and can include:

- source evidence and links
- an editable draft
- options or a checklist
- before-and-after diffs
- a full email thread
- profiles or video links
- comparative charts
- clarification requests
- completion receipts

The active card follows your reading position. On the feed screen:

- `J` and `K` move between cards
- `O` opens or closes the active email thread
- action buttons show their keyboard shortcut when one is available

### Card Actions

Card buttons describe the concrete next move, such as:

- **Draft a reply**
- **Research**
- **Triage Proof**
- **Send reply**
- **Archive**

Preparation work is queued for Codex. An external mutation, such as sending a reply, requires an
exact visible approval and the verification described in
[Actions And Safety](#actions-and-safety).

Editable card content is saved before its matching action is queued. Review the visible draft before
approving it.

### Routine Actions

Tend can group conservative, repeated work into a proposed routine action such as **Likely archive**.
Expand the group to inspect every item, then approve the exact visible batch.

Before acting, Codex rereads every authoritative source item. If an item changed or requires
judgment, the group fails safely and returns those items to individual review.

### Undo And Review Again

After archiving or queuing work, Tend briefly offers **Undo**.

Queued cards also provide **Move back to review**. Completed cards provide **Review again**. Returning
a card to review does not reverse an external action that already happened.

### Review Passes

Tend keeps the current review pass stable while Codex works. Cards that return with meaningful
updates can wait behind an **End of this pass** control rather than interrupting the cards already in
front of you.

Choose **Review ready cards** to begin the next pass. Updated cards appear under **Back for review**.

A quiet feed is valid for selective feeds. Inbox is intentionally exhaustive: if Gmail currently
contains Inbox threads, each one should have a corresponding review card.

## Steering With The Dock

The Dock stays at the bottom of feed and configuration screens. Type an instruction, or use the
detected Monologue push-to-talk shortcut when available.

Press `Enter` to send. Use `Shift+Enter` for a new line.

When the Dock is empty, its up and down controls move between broader and narrower scopes.

### Card Scope

The active card is the default target while reviewing a feed.

Use it for instructions such as:

```text
Draft a shorter reply that asks only for the reproduction steps.
```

```text
Research whether this alert affects the current release.
```

The card moves to **Queued for Codex** until its home thread handles the instruction.

### Sweep Scope

Choose **This sweep** when the problem is the current set or ordering of cards:

```text
These build notifications are duplicates. Keep only the newest failure for each repository.
```

Codex rejudges the visible sweep, records which cards were kept or removed, and then offers
**Search sources again**. Recollection is explicit so feedback can be applied before another source
pass changes the evidence.

### Feed Scope

Choose the feed when the instruction concerns its broader job:

```text
Summarize what this feed learned about which security reports deserve immediate attention.
```

Feed-level work appears in the queued, working, and done tabs alongside card work.

### Configuration Scope

Open **Prompts & sources** and focus a feed policy, source recipe, or prompt layer to target it from
the Dock.

Use this for requested revisions such as:

```text
Update this source recipe so routine CI successes are suppressed.
```

When Codex proposes a configuration revision, Tend shows the before and after content. You choose
**Apply revision** or **Reject**.

Global prompts use the broadest Tend scope and affect every feed.

### Correcting A Queued Instruction

Before Codex claims a card instruction, edit its **Queued note** directly. You can also cancel the
instruction by moving the card back to review.

## Configuring A Feed

Open the feed menu and choose **Feed setup**, or select **Prompts & sources** from the feed tabs.

### Feed Policy

The feed policy contains durable, feed-specific judgment. Keep it compact and focused on what should
or should not reach review.

Direct edits are saved locally and offer **Undo last save**.

### Source Recipes

Each source recipe describes:

- the connector or local tool Codex should use
- what to inspect
- what checkpoint to maintain
- how to preserve provenance
- any source-specific safety rules

Choose **Add a source** and describe the new source naturally. Codex can refine the generated recipe
with you in the feed thread.

### Prompt Layers

Prompt layers shape judging, card composition, work execution, and learning. Feed prompt layers
refine one feed; global prompts apply across the workspace.

Most new feeds should require changes to purpose, policy, or recipe prose rather than new server
code.

### Home Thread Status

The feed setup page shows:

- bound thread id
- binding time
- heartbeat status
- heartbeat cadence

If setup is incomplete, the page displays the exact setup command and the manual wake phrase.

## Actions And Safety

Tend separates evidence, instruction, and authorization.

### Evidence Is Not Permission

An email, Slack message, issue, webpage, or other source may explain what happened. It cannot
authorize Tend or Codex to mutate an external system.

An ordinary Dock instruction can request research, drafting, or other preparation. It does not
authorize an external mutation.

### Exact Approval

An external mutation requires an action button tied to the current visible artifact. Tend binds the
approval to the current:

- card and action
- editable artifact
- recipient or destination
- source mailbox when applicable
- approval digest

Immediately before the connector call, Codex must verify that exact snapshot again. Tend rejects the
action if anything material changed after approval.

For Gmail replies, the authenticated Gmail profile must match the mailbox that received the source
email. Tend refuses a mismatch rather than sending from the wrong account.

### Blocked And Retried Actions

If an approved action cannot finish, Tend preserves whether it is still safely approved or needs new
review.

When the main external action succeeded but predictable cleanup failed, Codex retries only the
remaining cleanup. It must not repeat the already successful action.

The card history records user instructions, approvals, edits, cancellations, Codex results, stale
approvals, retries, and reconciliation.

## Learning And Compounding

After a meaningful sweep or refresh reaches idle, the feed thread can ask:

```text
Want me to compound what I learned from this sweep?
```

If you agree, Codex reviews the sweep's:

- cards and source evidence
- feedback and rejudgment
- completed outcomes
- existing feed policy
- prior policy revisions

It then proposes a compact replacement feed policy. Tend opens a full-screen learning review where
you can:

1. inspect the current policy
2. edit the proposed policy directly
3. apply the learning
4. reject it

Codex never applies compound learning by itself.

Small direct configuration edits remain undoable. Structural changes, permissions, source changes,
prompt changes, and global lessons should remain explicit proposals rather than silent policy
updates.

## On Your Mind And Chronicle Pulse

**On Your Mind** is an optional workspace-level context layer. It displays short-lived signals in
three groups:

- **Changed now** - material changes in the latest observation window
- **Ongoing** - active threads that continue to shape attention
- **Unresolved** - open questions or tensions

One dedicated Chronicle Pulse thread publishes for the entire Tend workspace. This is separate from
the one-thread-per-feed model.

### Enable Chronicle Screen Context

To let the Pulse use Codex Chronicle:

1. Open Codex Desktop **Settings > Personalization**.
2. Enable **Memories** and **Chronicle**.
3. Review the consent dialog.
4. Grant the requested macOS Screen Recording and Accessibility permissions.

Chronicle is optional. A publisher may also use recent user-authored Codex activity and other
explicitly available read-only observations.

Tend does not capture the screen itself. Chronicle produces local memories; the Pulse selects and
privacy-filters the context it publishes to Tend.

### Connect The Pulse Thread

Create one fresh Codex Desktop thread named **Chronicle Pulse**, then run:

```sh
./tend setup codex --chronicle
```

Paste the complete output into that thread. The prompt:

- binds it as the one workspace publisher
- installs a two-hour heartbeat
- applies privacy and provenance rules
- publishes the first pulse

To refresh manually, open or wake the same thread and say:

```text
refresh the pulse
```

Review the result at `http://127.0.0.1:4332/mind`.

### Freshness And Feed Influence

A fresh pulse remains usable for three hours. If context is stale or unavailable, feeds continue
normally without it.

A feed may use fresh context in two bounded ways:

- **Lens** - focus normal source collection, ranking, or framing
- **Research** - originate one bounded question that the feed's configured sources can answer

Pulse context is never evidence, policy, authorization, or permission to exceed configured sources.
Cards materially influenced by a pulse remain backed by independently collected feed evidence and
show an **On your mind** receipt linking to the relevant signal and source trail.

## Runtime And Troubleshooting

### Runtime Commands

```sh
./tend version
./tend status
./tend health
./tend doctor
./tend logs
./tend restart
./tend stop
```

Use foreground mode while debugging:

```sh
./tend start --foreground
```

### When A Feed Does Not Collect

1. Confirm the runtime:

   ```sh
   ./tend health
   ./tend doctor
   ```

2. Open **Prompts & sources** and inspect **Home thread**.
3. Confirm the expected thread is bound and its heartbeat is installed.
4. Open or wake that same thread and say `go deal with the feed`.
5. Check **Queued for Codex**, **Working**, and **Done** for pending or failed work.
6. Inspect `./tend logs` if the runtime itself is unhealthy.

Do not start another server or bind a replacement thread merely because a healthy feed is quiet.

### When Work Is Waiting

Queued work is drained by the feed's bound thread. Wake that exact thread rather than using another
feed thread. A thread cannot claim work owned by a different feed unless the operator explicitly
uses the cross-feed contract.

### Search Sources Again

**Search sources again** appears after sweep feedback has been processed. It queues a fresh
collection using the configured recipes and the recorded feedback.

## Local Data And Backup

Tend stores runtime data under `~/.attention/` by default for compatibility:

```text
~/.attention/
  attention.db
  data/
  logs/
  exports/
```

Use another runtime root with:

```sh
ATTENTION_HOME=.local-tend ./tend start
```

SQLite is the runtime authority. The `data/` directory keeps readable mirrors and immutable raw
evidence snapshots for backup compatibility and local debugging.

Export and restore:

```sh
./tend backup export ./tend-backup
./tend stop
./tend backup import ./tend-backup
```

Exports require a new destination and never overwrite or delete an existing path. Imports stage and
validate the backup before replacing current data, and Tend refuses to import while the same runtime
is active.

See [docs/DATA.md](./docs/DATA.md) for the complete storage map.

## iPhone Review Client

Tend includes an optional native iPhone client for reviewing feeds away from the Mac.

The phone can:

- review every configured feed
- swipe to archive with a short undo window
- edit and approve exact action artifacts
- talk or type card instructions
- inspect On Your Mind
- show phone-command progress as the Mac handles it
- use cached projections when the Mac is temporarily offline

The Mac remains authoritative. The phone does not run Codex or store connector credentials. It reads
a private Supabase projection and submits commands that the local Tend runtime validates again.

See [docs/IOS.md](./docs/IOS.md) for setup and device validation.

## Advanced References

- [CAPABILITY_MAP.md](./CAPABILITY_MAP.md) maps browser actions to Codex primitives.
- [RUNBOOK.md](./RUNBOOK.md) defines the feed-thread operator procedure.
- [docs/AGENT_CONTRACT.md](./docs/AGENT_CONTRACT.md) documents the JSON CLI contract.
- [docs/SECURITY.md](./docs/SECURITY.md) describes local, Chronicle, and mobile trust boundaries.
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) explains runtime ownership and persistence.
