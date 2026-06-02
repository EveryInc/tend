# Capability Map

| User outcome | Browser path | Codex path |
| --- | --- | --- |
| Review a feed | Scroll the active feed | `pnpm cli -- state --feed <id>` |
| Configure local dictation | Hold the detected Monologue shortcut and speak | `setup:detect-monologue` discovers the installed app and records its local shortcut without a setup form |
| Submit scoped intent | Use the persistent dock and its target controls | `work:list`, `work:claim`, interpret the attached `target`, then `work:complete` |
| Cancel accidental dictated text | Use the brief Undo toast or ask Codex before work starts | `work:cancel --feed ... --work ...` restores the card without executing the queued instruction |
| Approve a proposed action | Press `A` or Approve | Executor receives exact approved digest and current state is revalidated |
| Dismiss and run default cleanup | Press `X` or Dismiss, with brief Undo | Queue one digest-bound `default_cleanup`, call `action:verify`, drain it through Codex, and record the verified outcome |
| Create a feed | Describe it in one text field | `feed:create --brief ... --thread ...` |
| Archive an extra feed | Ask Codex to archive it | `feed:archive --feed ...` preserves its ignored state outside the active workspace |
| Add a source | Describe it in one text field | `source:add --feed ... --brief ...` |
| Tune a feed | Open `Prompts & sources` → `This feed` | Edit feed policy and source recipes directly; `inspect --feed ...` remains available to Codex |
| Edit shared judgment | Open `Prompts & sources` → `Global prompts` | Edit `global-policy.md` and the allowlisted prompt files directly |
| Bind a home thread | Guided Codex setup | `feed:bind --feed ... --thread ...` |
| Schedule refresh and drain | Approve proposed cadence | `feed:heartbeat:propose`, then host `automation_update`, then `feed:heartbeat:installed` |
| Verify an approved external action or cleanup | Approve the exact visible artifact or dismiss cleanup | `action:verify` rereads the current artifact or cleanup digest immediately before mutation; connector invocation remains a procedural boundary |
| Collect evidence | Render the resulting cards | `source:record-run` or `source:import-json-file` writes immutable snapshots and checkpoints; `sweep:record-batch` records the judged batch separately |
| Rejudge sweep feedback | Submit dock feedback to `This sweep` | `sweep:rejudge` writes an explicit kept order and removed-card set before recollection is offered |
| Render a judged item | Review its structured blocks | `card:upsert --feed ... --card ...` |
| Compound learning | End-of-pass button | Claim `compound_learnings`, revise policy, create structural proposals |
| Revert micro-learning | Review policy history | `policy:revert --feed ... --revision ...` |

The app deliberately exposes atomic primitives. A new feed should usually require new recipe prose,
not new server code.
