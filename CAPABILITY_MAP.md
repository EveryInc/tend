# Capability Map

| User outcome | Browser path | Codex path |
| --- | --- | --- |
| Review a feed | Scroll the active feed | `tend cli state --feed <id>` |
| Configure local dictation | Hold the detected Monologue shortcut and speak | `setup:detect-monologue` discovers the installed app and records its local shortcut without a setup form |
| Submit scoped intent | Use the persistent dock and its labeled `Broader` / `Narrower` controls, or press plain arrows while its empty input is focused | `work:list`, `work:claim`, interpret the attached `target`, then `work:complete` |
| Correct or cancel accidental dictated text | Edit `Your note to Codex` on the queued card, use its persistent `Move back to review` control, or use the brief Undo toast | `work:edit --feed ... --work ...` corrects unclaimed text; `card:return-to-review --feed ... --card ...` cancels unstarted local work and restores the card |
| Choose a card-specific next move | Press the concrete action button or its shortcut, such as `Send reply`, `Draft a pass`, `Research`, or `Archive` | Card `actions[]` route preparation through `queue_instruction`, exact visible actions through digest-bound `approve_action`, and dismissal through `default_cleanup` |
| Dismiss and run default cleanup | Press the card's cleanup action, often `Archive`, with brief Undo | Queue one digest-bound `default_cleanup`, call `action:verify`, drain it through Codex, and record the verified outcome |
| Approve a conservative routine batch | Expand a collapsed group if useful, then press its one-click action | `routine:upsert` proposes the exact visible items; approval queues one digest-bound `routine_action_batch`; Codex rereads every authoritative source before acting and returns the batch to individual review if anything changed or needs judgment |
| Create a feed | Describe it in one text field | `feed:create --brief ... --thread ...` |
| Archive an extra feed | Ask Codex to archive it | `feed:archive --feed ...` preserves its ignored state outside the active workspace |
| Add a source | Describe it in one text field | `source:add --feed ... --brief ...` |
| Tune a feed | Open `Prompts & sources` → `This feed` | Edit feed policy and source recipes directly; `inspect --feed ...` remains available to Codex |
| Edit shared judgment | Open `Prompts & sources` → `Global prompts` | Edit `global-policy.md` and the allowlisted prompt files directly |
| Bind a home thread | Guided Codex setup | `feed:bind --feed ... --thread ...` |
| Bind the Claude lane | `/tend` skill in a Claude Code session | `feed:bind --feed ... --agent claude` mints the lane id; `--replace` rotates it |
| Route one instruction to Claude | Dock route-to-Claude toggle (visible when the feed has a Claude binding) | Instruction endpoints accept `assignee: claude`; work is lane-scoped at claim time |
| Route a whole feed to Claude | — | `feed:drain-agent --feed ... --agent claude` |
| See whether Claude is listening | TopBar liveness chip (live / stale / offline) | `agent:presence --agent claude --session ...` heartbeats; presence is informational only |
| Recover parked or stuck Claude work | Parked notice → `Reassign to Codex` | Queued/parked items use `work:assign --feed ... --work ... --agent codex`; claimed/stuck items use claim replay by the Claude lane or `work:release --feed ... --work ... --token ...` to re-queue and rotate the token |
| Schedule refresh and drain | Approve proposed cadence | `feed:heartbeat:propose`, then host `automation_update`, then `feed:heartbeat:installed` |
| Verify an approved external action or cleanup | Choose the exact visible mutation, cleanup, or routine group | `action:verify` rereads the selected card-action ID, current artifact, cleanup, or batch digest immediately before mutation and records verification durably; Inbox replies additionally require `--mailbox <authenticated-gmail-email>` to match the source message's received-at mailbox |
| Collect evidence | Render the resulting cards | `source:record-run` or `source:import-json-file` writes immutable snapshots and checkpoints; `sweep:record-batch` records the judged batch separately |
| Rejudge sweep feedback | Submit dock feedback to `This sweep` | `sweep:rejudge` writes an explicit kept order and removed-card set before recollection is offered |
| Render a judged item | Review its validated structured blocks, including compact two-series charts for comparative metrics | `card:upsert --feed ... --card-file ...` |
| Compound learning | Answer yes when the feed thread offers its end-of-sweep learning pass; review and edit the resulting full-screen policy proposal before applying it | An idle `work:list` or `work:claim` reminds Codex to offer the pass after meaningful sweep work; `learning:request --feed ...` queues one `compound_learnings` job; Codex reviews durable evidence and uses `revision:propose --source compound`; the browser applies only the user-reviewed Markdown |
| Revert micro-learning | Review policy history | `policy:revert --feed ... --revision ...` |

The app deliberately exposes atomic primitives. A new feed should usually require new recipe prose,
not new server code.
