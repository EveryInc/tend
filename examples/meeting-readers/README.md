# Meeting-reader examples

These files contain only fictional data and placeholder model selectors. They are not a private feed export, actual model output, or anyone's feedback history.

- `reader-prompt.md`: portable reading instructions, keeping full-source understanding, specific lenses, a self-contained face, and separate evidence/readability checks.
- `readers.example.json`: explicit reader configurations. Replace both recognizable model placeholders with user-chosen accessible models before any provider call. Remove an entry if the user only wants one reader.
- `packet.example.json`: editable packet inputs—owner, current questions, known context, dates, calibration, references, complete source manifest and transcripts. The calibration arrays are deliberately empty.
- `output.schema.json`: the JSON draft contract. The coordinator additionally checks exact source membership, unique IDs, all-meeting coverage, quote spans and factual meaning.
- `output.example.json`: a hand-written example matching the schema and the fictional sources. It is not an actual reader run, measured confidence, or a vote.

See [Meeting readers](../../docs/MEETING_READERS.md) for the manual setup and host-access check. Copy the structure, not the fictional opinions, into a private working directory. Keep real packets, personal calibration, source URLs, credentials and receipts out of the repository.

The same frozen packet goes to every configured reader. `flags[].title` and `flags[].face` are the canonical visible draft, and `flags[].id` becomes `reading.draftId`. Do not substitute `context` for the face or claim a hand-written example came from a model.

When real feedback exists, populate `calibration.recent_examples` with its date, exact card ID and
content revision, title, face, explicit reaction or exact compared-version preference, and any
actual written reason. Leave an absent reason absent. Use `calibration.durable_lessons` for short
confirmed rules with their scope and supporting feedback references. These are packet inputs copied
from that user's native history, not another persistent memory store and not inferred preferences.
The example leaves both arrays empty rather than manufacturing a taste history.
