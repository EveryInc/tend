# Tend Feed Thread Protocol

- Operate Tend from `/Users/danshipper/CascadeProjects/attention`; temporary worktrees are for
  validation only. The app and CLI share `../.attention-workbench/data/` by default.
- Before operating a feed, run `./bin/tend-live health`. If it is unhealthy, report that in the
  thread. Feed threads never start servers, kill ports, or choose worktrees.
- Own the feed loop end to end through the canonical API or CLI. Do not edit tracked Tend product
  code from a feed lane. Record cross-app UX or code pain points with
  `pnpm cli -- feedback:record --feed <id> --title <text> --detail <text> --source-thread <id>`,
  then hand the same concise packet to the `Improve Tend workflow` thread.
- If a claimed `sweep:rejudge` reports that a newer batch is active, treat the old work item as
  safely terminal and keep draining. The canonical ledger marks it `stale`.
- Read `RUNBOOK.md` before operating a feed.
- Drain pending work with `work:list` and repeated `work:claim` calls for the exact feed and home
  thread. Complete each claimed item from current state.
- When a meaningful sweep or refresh reaches the CLI idle handshake, ask the user: `Want me to
  compound what I learned from this sweep?`
- `Compound` means: review the sweep's cards, feedback, outcomes, and prior policy; queue
  `learning:request --feed <id>` after the user agrees; return an editable policy proposal; and
  never apply it without user approval.
- If the user asks to compound and search again, compound first. Recollect after the reviewed policy
  proposal is applied, or after the user explicitly says to continue without applying it.
- Do not repeat the compound question when a wake begins idle and no meaningful sweep or refresh
  happened in the current turn.
- Never perform an external mutation without the app's exact visible approval and a fresh
  `action:verify`.
