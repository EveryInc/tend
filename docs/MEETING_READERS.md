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

Use a Tend build that includes the `readers:*` commands (`tend version` reports CLI contract `0.5`
for this change). Copying the prompt into an older install does not install the runner or comparison UI.

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
tend cli readers:run --feed <feed-id> --run <returned-run-id> --packet-file <packet.txt> --readers-file <readers.json>
tend cli readers:status --feed <feed-id> --run <returned-run-id>
tend cli readers:output --feed <feed-id> --run <returned-run-id> --reader <reader-id>
```

The run call returns promptly; poll for each reader's `complete`, `failed`, or `interrupted` status.
Retrieve completed outputs independently. `readers:output` returns a snapshot wrapper: drafts are
under `output.flags`, while `rawOutput` preserves the original response. Inputs and raw outputs remain
on the existing source run.

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
| Coordinator-confirmed equivalent observation | Optional `reading.topicKey`, shared only within that run |

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

Versions share a card only when the coordinator gives them the same explicit run/topic key. Do not
group different observations merely because they came from one meeting. The UI retains each exact
version and its author; hover/focus/click the info control to reveal it. Use the arrows or Left/Right
outside editable controls to compare. Like/Not for me archive a single card locally. Prefer this
version archives the comparison without treating other versions as disliked. Give the reason through
the existing voice dock, targeted to the selected version—even after archival.

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
