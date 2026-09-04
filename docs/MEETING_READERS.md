# Meeting readers in a normal Tend feed

Use two or more independent readers to find a few worthwhile moments in the same complete meeting
sources. Review their cards together, compare alternate versions without seeing the model name by
default, and use your own feedback to improve the feed. One reader is also supported.

This uses Tend's existing feed, source-run, card, voice and Compound records. It does not require an
edition feed, an import from another product, or a separate comparison database.

## What runs automatically, and what does not

| Step | Responsibility |
|---|---|
| Choose sources, questions and permitted providers | User and the feed's coordinating task |
| Fetch complete sources, record gaps, freeze a packet | Coordinating task using permitted connectors |
| Run explicit reader configurations concurrently on identical input | Existing local Tend server |
| Preserve raw output, hashes, model receipts and failures | Existing source run |
| Check evidence/readability, match equivalent topics, publish cards | Coordinating task; not the reader runner |
| Compare versions, record likes/preferences and voice feedback | Native Tend UI and event history |
| Distill feedback into an editable policy proposal | Existing Compound workflow, applied only after user review |
| Generate a card image, preview a message and send it | Separate agent-operated, exactly approved action |

The supplied examples are a starter contract, not an installed collection recipe or an automatic
publisher. A source-run receipt proves which input and output were used, not that the input contained
every permitted meeting or that an interpretation is correct.

## Set up another person's feed

Use a Tend build that includes the `readers:*` commands (`tend version` reports CLI contract `0.6`
with retry comparisons). Copying the prompt into an older install does not install the runner or comparison UI.

Use their own local Tend runtime and their own Codex/Claude accounts. The installed app defaults to
`~/.attention`; set `ATTENTION_HOME` explicitly for an isolated test. Do not restore another person's
runtime backup: it contains private sources, feedback, context, tasks and possibly pending actions.
A feed ID is not a user-account boundary. Global policy, On Your Mind and connector access are
workspace-level concerns. Keep the API on loopback; do not expose it as a shared hosted app.

Start from an existing feed such as Company Attention, or create a normal feed:

```bash
tend cli feed:create --brief "Meeting ideas worth reading" --thread <current-task-id>
tend setup codex --feed <feed-id>
```

Use the real returned feed ID. The setup prompt guides home-task binding; for this pilot tell the
task to **run manually first and defer the heartbeat**. Source development uses `pnpm tend --`
instead of `tend`. Install and service ownership remain covered by [Install](INSTALL.md) and the
[runbook](../RUNBOOK.md); a feed task does not silently launch a second runtime.

In Prompts & sources, give the feed a small authorized meeting-source recipe. Use the
[reader prompt](../examples/meeting-readers/reader-prompt.md) as the meeting-specific judge layer and
keep the ordinary feed's action rules for its non-reading cards. The reading exception should say:
an interesting, supported exchange or idea can stand alone; it does not need an invented task,
urgency or recommended action. Its face is a concrete title plus one compact paragraph; evidence
opens separately. This setup is an explicit edit or reviewed proposal, not a side effect of a reader
run.

Fill the packet's owner brief with that person's role, current questions, known context and
exclusions. Include optional authorized strategy/message references with dates, not an assumed
company strategy. On Your Mind is optional and must be fresh and feed-relevant; it supplies a lens,
never source evidence or broader permission. Start calibration empty. Add only that person's actual
feedback on exact earlier card faces; do not borrow another user's likes or infer taste from their
mailbox, job title or attendance.

## What to collect, and what to look for

Start with a small mix of complete, permitted conversations from the last few days. Choose sources
by the owner's current questions, then read each whole conversation before selecting moments. A
meeting does not need an "important" title to contain a good idea.

| Conversations to collect | What they can reveal |
|---|---|
| Product or engineering reviews; architecture discussions | Open tradeoffs, surprising constraints, approaches another team could reuse |
| Customer demos, onboarding sessions or support calls | What people actually understood, resisted, asked for or used—not just the team's pitch |
| Cross-team planning and retrospectives | Conflicting assumptions, unclear ownership, useful disagreements, where work is getting stuck |
| Project kickoffs and execution reviews | How a plan is becoming real decisions; compare with an authorized, dated plan when one exists |
| Working sessions and design critiques | A concrete example, explanation or technique that makes a problem easier to think about |
| Editorial, marketing or launch discussions | Reusable arguments, examples and recurring themes worth thinking or writing about |
| Prototype or vendor walkthroughs | How a mechanism works, its limits and open questions; distinguish claims from demonstrated results |

For a first pilot, a couple of product/engineering conversations, one audience-facing call and one
cross-team discussion are enough to try. Collect only those the owner has authorized; these examples
do not expand connector permissions. Keep the starter's sensitive-topic exclusions, including
performance reviews and named-person hiring/firing decisions. A relevant strategy or message document
is supporting context, not a substitute for the conversation.

### Five lenses from the initial reading trials

These are the five questions used by the tested reader prompt. Early feedback particularly favored
useful ideas, real choices and concrete perspectives on the work. Audience reactions were a
requested lens to keep testing. Borrow the questions, not another person's taste history. They have
no quotas, and a new owner can enable only the ones they want in
`brief.enabled_lenses`. The examples below are fictional illustrations, not private trial cards or
recorded feedback.

| Lens | Question to read with | A concrete thing worth surfacing |
|---|---|---|
| **Open choices** (`tiebreaker`) | What real choice is still unresolved, and could my judgment help? | The import team can buy a connector and ship Friday, or build one over two weeks to retain offline support. The room is split; neither option was chosen. |
| **Plans versus stated intent** (`off_strategy`) | Did a concrete decision depart from an applicable plan? | The dated plan says to test with five customers before launch; the team agrees to launch next week without those tests. Show both statements, not a vague strategy alarm. |
| **Ideas worth passing along** (`worth_spreading`) | What example, distinction or technique could I use or share? | A timed-out request made two appointments when the agent retried. The fix: retries reuse one request ID, and the booking service returns the original result instead of creating another booking. |
| **What it was like in the room** (`room_texture`) | What observable exchange explains how the work or collaboration is going? | In the release retro, the frontend group was waiting for backend approval while the backend group thought frontend owned the release. Both thought the next move belonged to someone else. |
| **A message meets its audience** (`message_tested`) | How did someone actually react to the product or promise? | The demo offers automatic rescheduling. A customer replies: "Please don't move it for me. Show me the open slot so I can choose." That reaction is the interesting part. |

Use `off_strategy` only with a supplied, applicable dated reference in `references.strategy`;
otherwise leave it off. For `message_tested`, collect the actual audience reaction, including
confusion or resistance. An internal pitch or a presenter's claim that customers loved it is not the
same evidence. For `room_texture`,
show words, behavior and work context without diagnosing someone's personality or mental state.

### Make the questions personal

For a product/engineering feed, choose two or three current questions such as:

- Where can the agent finish a useful workflow, and where does a person still need to step in?
- Which technical choices are genuinely open, and what evidence would settle them?
- What did a customer do or say that changes how we should build or explain the product?
- What has one team learned that another team could reuse?
- How does a promising technique actually work, and where did the discussion about it land?
- What recurring question or tension could be useful to think or write about?

Put the chosen questions, with dates, in `brief.current_questions`. Add the meetings or decisions the
owner already knows to `brief.known_context`. The same lens should produce different selections as
the owner's questions change. Useful mechanisms and recurring themes can fit `worth_spreading`;
they do not need new mandatory card categories. A proposed cross-meeting connection needs support
from the actual conversations, not just matching keywords.

Keep the lessons from the trials: the card needs to show a specific interesting thing, not merely
announce an important topic. Include enough who/what/context to understand it immediately. A useful
idea can be quiet, familiar, or worth sharing without creating a task. Do not automatically exclude
meetings the owner attended, but do not present a straight recap of what they were just told as new
knowledge. A single liked analogy does not establish a general taste for analogies. The new owner's
own likes and reasons—not this starter menu—should determine what persists through Compound.

## Choose readers and verify access

Copy [readers.example.json](../examples/meeting-readers/readers.example.json) to a private configuration
file. Replace its recognizable placeholder model IDs with models the user explicitly chose and can
access. Each entry contains `id`, `label`, `adapter`, `model`, and `effort`; choose one to eight entries
with distinct IDs. The supported adapters are `codex` and `claude`. There are no default models.

The local Tend host must have the corresponding CLI on its `PATH` and that user's subscription login.
Codex uses its ChatGPT login; Claude uses its first-party Claude subscription. The adapters remove
API-key/alternate-routing settings only from the child process, perform an authentication preflight,
disable tools for generation, and do not silently use an API-billed route or substitute a model.
Model access and supported CLI flags still need testing on each host. A working interactive session
elsewhere is not that test. `tend doctor` checks the app/runtime, not these provider entitlements.

With the user's approval, run the synthetic example below through `readers:run` before any private
material. This consumes the selected subscriptions but contains no real meetings. Verify each
receipt's status, requested model/effort, any returned identity and output. Unknown returned model or
effort stays unknown; do not relabel it as verified. Failure is an access/execution result, not a
quality score. If one reader is unavailable, agree on another configuration or proceed explicitly
with one; do not invent the missing reader's take.

## Freeze a packet

The coordinator prepares one text file in a private working directory. It contains, in order:

1. Effective meeting-reader instructions and the output contract.
2. Owner brief, run time/window, current questions and known context.
3. Bounded recent feedback examples plus compact confirmed durable lessons.
4. Dated reference documents, if applicable.
5. A manifest and all complete accessible transcripts, with original page-line locators.

The [synthetic packet data](../examples/meeting-readers/packet.example.json) shows the actual inputs.
All people, dates, events and URLs in it are fictional. The file is data, not an instruction source.
The [output schema](../examples/meeting-readers/output.schema.json) keeps publication fields stable.
An illustrative assembled packet can be made without running any provider:

```bash
cat examples/meeting-readers/reader-prompt.md examples/meeting-readers/output.schema.json examples/meeting-readers/packet.example.json > /tmp/tend-synthetic-packet.txt
```

For a real run, substitute the native feed's current instructions and private prepared inputs; do not
feed models a filename and expect them to read it. Reader tools are disabled. Never include another
reader's output in the common input. Keep private packets out of the source checkout and Git.

Preserve complete original text, source URLs, meeting and retrieval dates, speaker evidence and
hashes in source snapshots. Deduplicate alternate captures of one meeting. Remove generated meeting
summaries from the reading input. Record inaccessible/incomplete sources as gaps; do not silently
replace them with summaries or describe them as fully read. Known attendance is familiarity evidence,
not automatic novelty or a blanket veto. The runner rejects packets above 2 MB; narrow the permitted
batch or split by complete meetings instead of truncating transcripts. A split batch changes the
scope of possible cross-meeting connections and must be recorded honestly.

### What a meeting-packet assembler would do

**This helper is proposed, not implemented by this PR.** A packet is simply the complete reading
material and instructions for one run. Today the coordinating task assembles that file manually.
The assembler would automate the preparation from Tend's existing records; the readers would still
decide what is interesting.

For example: four saved meetings, three current questions and a few earlier rated cards become one
frozen reading file. Every configured reader gets that same file independently.

The smallest useful helper would:

1. Gather the selected feed's authorized, saved full transcripts, preserving source IDs, dates,
   speaker evidence and original line locators. Deduplicate alternate captures and report missing or
   incomplete material. It cannot reconstruct a missing transcript from a summary.
2. Add the effective reader instructions, owner brief and enabled lenses, applicable dated
   references, bounded recent feedback on exact card faces, and that owner's approved durable
   lessons. Do not silently promote a pending Compound proposal into instructions.
3. Write one packet file and a readable inventory of its sources, gaps, size and input versions.
   Stop or explicitly split by whole meetings if it exceeds the runner's 2 MB limit. Pass the result
   to the existing `readers:run`, which already saves the exact input and its hash on the source run
   and sends identical input to each reader.

This would remove repetitive copying and reduce accidental differences between reader inputs. A
changed question or new feedback would enter the next assembled packet; it would not rewrite an old
run. The first version can be a small local helper with source-format checks, not another model call
or database.

Source collection still uses the permitted connectors. The assembler would not search new accounts,
pick only promising quotes, summarize away the rest of a meeting, infer someone's taste, or publish
cards. Whole-source reading, selection, evidence/readability review and approved publication remain
separate steps.

## First manual run

Before collection, inspect the feed and drain any queued work through its bound task:

```bash
tend health
tend cli inspect --feed <feed-id>
tend cli work:list --feed <feed-id> --thread <home-task-id>
tend cli work:claim --feed <feed-id> --thread <home-task-id>
```

After authorized collection, record the complete source snapshots, current judgments and checkpoint
through file-backed inputs. For the synthetic access check, the coordinator can wrap the example
packet object in a one-element snapshots array and explicitly mark its checkpoint as synthetic;
use a separate test feed/runtime, not a real company's current sweep.

```bash
tend cli source:record-run --feed <feed-id> --source <source-id> --snapshots-file <snapshots.json> --judgments-file <judgments.json> --checkpoint-file <checkpoint.json>
tend cli readers:run --feed <feed-id> --run <returned-run-id> --packet-file <packet.txt> --readers-file <readers.json> --prompt-sha256 <frozen-prompt-sha256>
tend cli readers:status --feed <feed-id> --run <returned-run-id>
tend cli readers:output --feed <feed-id> --run <returned-run-id> --reader <reader-id>
```

The run call returns promptly; poll for each reader's `complete`, `failed`, or `interrupted` status.
Retrieve completed outputs independently. `readers:output` returns a snapshot wrapper: drafts are
under `output.flags`, while `rawOutput` preserves the original response. Inputs and raw outputs remain
on the existing source run.

Record the SHA-256 of the exact frozen prompt when starting readers. Retry comparisons require it
on both attempts, in addition to the packet hash. Never invent a missing historical prompt hash.

Only one local reader worker may own a runtime, even if another server selects a different port.
A second live owner is refused before recovery can alter its receipts. Use the owning Tend service;
do not delete its ownership record to force another instance to start. After a process has stopped,
the next owner marks abandoned reads interrupted without replaying providers.

Repeating the identical request returns recorded state without relaunching providers. Deliberate
re-execution, a changed packet, or changed configuration requires a new source run; a failed reader
is not silently retried, and a successful one is not replaced. Do not republish duplicates when
resuming a partially completed coordination pass.

Review every complete transcript before choosing among drafts. Check these separately:

- **Evidence:** source membership, exact quoted spans, speaker attribution, later qualifications,
  final decision versus open proposal, and reference dates. The sample schema is an output contract;
  it does not itself verify any source quote or interpretation.
- **Readability and interest:** title plus face must show the actual interesting exchange, idea,
  choice or reaction without opening the evidence. Keep worthwhile quieter ideas and explicit
  uncertainty. Do not reject them merely for lacking urgency or invent a grand implication to make
  a recap seem new. The allowance is zero to four cards per reader, not a quota.

Record the reviewed source run in the shared current sweep before publishing:

```bash
tend cli sweep:record-batch --feed <feed-id> --runs '["<returned-run-id>"]'
tend cli card:upsert --feed <feed-id> --card-file <reviewed-card.json>
```

For claimed recollection work, pass its `--work <work-id>` to both source-run and sweep recording,
as the runbook requires. A normal batch may include multiple real source runs. Do not overwrite a
newer sweep to replay an old reader result.

### Publication contract

| Saved reader output | Native reading card |
|---|---|
| `flags[].id` | `reading.draftId`, matching a real unique draft in that reader's saved output |
| `flags[].title` | `title`, exact unless a review edit is disclosed |
| `flags[].face` | `why`, exact unless a review edit is disclosed |
| `flags[].context`, `moment`, source metadata | Supporting blocks with source links/locators |
| Native source-run and configured reader ID | `sourceRunIds`, `reading.runId`, `reading.readerId` |
| Coordinator-confirmed equivalent observation | Optional `reading.topicKey`; cross-run matching also requires `readers:compare` |

Keep reading cards free of executable actions. Tend derives writer identity from the completed
receipt. When a necessary review edit changes title or face, attach
`reading.reviewEdit: {"by":"Coordinator","note":"Specific reason for the edit"}` and preserve the
raw draft. The annotation is disclosure, not a factual-quality certificate. After publication,
different wording requires a new card ID; an old rating must not silently move to the rewrite.

The [hand-written synthetic output](../examples/meeting-readers/output.example.json) demonstrates
the schema. It is not a model run, an evaluation vote, or material to publish with a fabricated
reader receipt. The coordinator should record factual rejections and reasons in the existing
work-completion receipt when handling claimed work; on a manual run, retain them in its local
coordination record. Rejected originals remain in the saved reader output. The runner does not
automatically append review decisions to source judgments, and these notes must not become a hidden
taste-ranking system that discards a model's worthwhile selection merely for being quiet.

## Review, learn, then schedule

Versions share a card only with the same explicit run/topic key or a validated retry comparison.
Do not group different observations merely because they came from one meeting. The UI retains each exact
version and its author; hover/focus/click the info control to reveal it. Use the arrows or Left/Right
outside editable controls to compare. Like/Not for me archive a single card locally. Prefer this
version archives the comparison without treating other versions as disliked. Give the reason through
the existing voice dock, targeted to the selected version—even after archival.

### Read without dismissing each card

In the feed, set **Reading cards → Mark read as I scroll**. This is opt-in per feed; ordinary
action cards still require a deliberate disposition. Like and Not for me remain optional,
including on each carousel version. Prefer this version is a separate comparison choice.

Tend waits for roughly two seconds of meaningful foreground visibility, including the beginning
and end of the card face, then a deliberate forward scroll past the card. Loading the page,
switching tabs, selecting text, jumping with code, or quickly flicking past does not count.
Tall cards can be read in parts. **Mark read** is also available without scrolling. Automatic
marking waits until the card is offscreen. During this visit, reading cards keep their place:
read cards are subtly shaded, and rating or preferring a version does not remove the card before
you can add feedback. You can scroll back, switch versions, change a rating, or use voice feedback.
A Like on one version does not mark its unrated alternatives reviewed. The Feed tab counts unread
topics, even while read and reviewed cards remain visible. The end leaves room to pass the final card.

**Read history** retains the cards, sources, ratings and comparisons. Switching tabs preserves your
current feed session; a reload or a new feed visit starts with unread topics. **Undo** or **Mark unread**
restores a neutrally read topic; it never clears a Like or Not for me. A group pass records its exact
members and only the versions actually viewed, not a pretend read on every alternative. A newly
arriving version makes the topic eligible again. A return for review or later feedback work also
invalidates old read progress. Reading is not a positive or negative training signal; compounding
still uses explicit feedback only.

This uses existing feed configuration and the event ledger, not a new service or database.
It does not alter card content/status, approve work, or change a source. API and CLI operations:

```sh
tend cli feed:reading-mode --feed <feed-id> --mode stream
tend cli reading:progress --feed <feed-id> --progress-file <progress.json>
```

`progress.json` supplies `clientEventId`, `groupId`, exact `members`, the subset `viewedMembers`,
and `read`. Marking read also requires `expectedCardUpdatedAt`, a map from each member ID to its
displayed `updatedAt`, so an old browser tab cannot mark a later feedback response read.
Unread requires `expectedEventId` from the current receipt so a stale undo cannot
erase newer progress. `POST /api/feeds/:feed/reading-mode` and
`POST /api/feeds/:feed/reading-progress` provide the same guarded operations. Feed state exposes
`readingProgress`; the event ledger retains history. Session order is client-only group IDs;
card bodies and feedback always come from current feed state. Use `--mode review` to stop automatic
marking without discarding history. Older builds safely ignore these additive fields/events,
but will show neutrally read cards again; they do not support this mode.

### Local engagement, separate from ratings

Reading cards also record local engagement in either reading mode, tied to the exact card revision
and a random feed-visit ID. This includes time meaningfully visible in the foreground, named control
activations (including Sources and carousel keys), and completed text-highlighting gestures.
Highlight records contain only a character count: no selected text, voice input, URLs, or pointer
coordinates. Cross-card selections and text editors are excluded. No third-party analytics service
receives this data.

Visible time is sampled in short intervals, flushed about every 15 seconds and when leaving a version,
and pauses in background tabs, unfocused windows, or after 60 seconds without user activity.
Expanded Sources count as part of the visible card. Page-close delivery and touch selection detection
are best effort. This is an exposure estimate, not eye tracking or proof that someone read a card;
opening Sources may mean interest, confusion, or skepticism. An activation is not proof that a rating
or action succeeded. **Only explicit ratings and feedback express taste.** These raw engagement events
are not automatically compounded into likes, dislikes, model quality scores, or feed policy.

Inspect local aggregates, optionally for one card:

```sh
tend cli reading:engagement --feed company-attention
tend cli reading:engagement --feed company-attention --card <card-id>
```

`GET /api/feeds/:feed/reading-engagement` (optional `?card=<card-id>`) returns exact-revision totals:
`dwellMs`, click counts by named target, selection counts, and `lastEngagedAt`. Character counts
remain in the individual selection events.

### A reader needs to sign in again

An expired subscription session shows **Sign-in needed**, not a content-quality failure. Sign in
locally with `claude auth login` or `codex login`, as indicated. Private CLI diagnostics remain in the
saved output; they are not copied into the public status or guidance. Tend never automatically
retries, switches models, or falls back to API billing. After explicit approval to retry, create a
new source run for only the failed reader, with the exact original packet and prompt hash. Leave
the successful reader and its receipts untouched.

### Keep an intentional retry in the comparison

Publish the retry's reviewed cards with their real `reading.runId`, `readerId`, and `draftId`.
For each genuinely equivalent observation, prepare a comparison file using the current card
revisions from `tend cli state --feed <feed-id>`:

```json
{
  "id": "planning-budget-observation",
  "topicKey": "planning-budget",
  "runIds": ["original-attempt", "retry-attempt"],
  "members": [
    { "cardId": "original-card", "contentRevision": "<exact-current-sha256>" },
    { "cardId": "retry-card", "contentRevision": "<exact-current-sha256>" }
  ]
}
```

```bash
tend cli readers:compare --feed <feed-id> --comparison-file <comparison.json>
```

The first run is the original attempt. Tend verifies the saved input bytes, identical packet and
prompt hashes, completed native receipts, and the full current membership of that explicit topic.
It rejects missing prompt hashes, changed inputs, other observations, stale revisions, cross-feed
cards, and overlapping comparison IDs. Linking never runs a provider or rewrites a card/receipt.
Unmatched observations remain independent cards.

To include another deliberate retry, extend the same comparison ID with its run and all current
members. Existing runs cannot be removed or reassigned. A new card in a linked run/topic joins
automatically, but a new run requires an explicit link. Any added version invalidates the previous
current preference; exact old votes and individual reactions remain in history. A stale retry of
an old preference cannot archive a newly arrived version. `card:prefer` requests for linked groups
include `comparisonId` and use the comparison's `anchorRunId` as `runId`; member snapshots still
retain each card's actual attempt. The UI supplies these fields automatically.

Use the existing Compound flow after meaningful feedback and the user's agreement. It receives exact
faces, writers, reactions, preferences and voice comments, including archived cards. Separate source
accuracy, interest and readability. Unrated/cleared feedback is not a dislike; a like does not validate
a factual error; a preferred version does not imply a universal model winner. Keep recent explicit
examples scoped and turn only supported recurring lessons into a compact editable policy proposal.
The user reviews and applies it.

Prove one manual run and one feedback-driven follow-up before proposing a cadence. Scheduling uses
the existing feed heartbeat, not a new reader daemon. If the user chooses a schedule, propose it,
install/update the host's same-task automation through its supported tool, and record the returned
automation ID:

```bash
tend cli feed:heartbeat:propose --feed <feed-id> --cadence "<user-chosen cadence and timezone>"
tend cli feed:heartbeat:installed --feed <feed-id> --automation <actual-automation-id>
```

The second command records an automation that already exists; it does not create one. Keep host/Mac
availability visible. Neither reader installation nor a completed run enables automatic collection,
sharing or policy changes.

## Image sharing and remaining gaps

An image share currently needs a coordinating task to capture the exact selected card revision,
generate a wide image, check its text, prepare a local preview with a separate editable note and
recipient, obtain exact approval, send, and read back the result. Do not upload to a recipient's DM
as a preview. Generated images can alter words. The current action digest binds the action and its
selected artifact block, not arbitrary referenced file bytes; independently verify the intended
image until immutable attachment verification is a product capability.

Follow-up improvements are a reusable packet builder from native snapshots, an inline immutable
image-attachment/preview contract, and a reliable trusted chat-to-exact-approval handoff. None is
silently provided by these docs. They do not require hosted multi-tenancy, shared credentials, a new
comparison database, or importing someone else's personal calibration.

A small second-user pilot succeeds when that person can review two useful sweeps using only their
accounts and sources, compare versions, leave feedback, find provenance, and review a Compound
proposal without access to anyone else's runtime. Add one verified exact-image share only if sharing
is part of the pilot. No public examples or tests establish that outcome on a new person's machine.
