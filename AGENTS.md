# Tend Feed Thread Protocol

- Operate feeds through the installed `tend` executable, or `pnpm tend --` from a source checkout.
  Both use `~/.attention/` by default. Temporary worktrees must set an isolated `ATTENTION_HOME`.
- Before operating a feed, run `tend health`. If it is unhealthy, report that in the
  thread. Feed threads never start servers, kill ports, or choose worktrees.
- Own the feed loop end to end through the canonical API or CLI. Do not edit tracked Tend product
  code from a feed lane. Record cross-app UX or code pain points with
  `tend cli feedback:record --feed <id> --title <text> --detail <text> --source-thread <id>`,
  then hand the same concise packet to the `Improve Tend workflow` thread.
- If a claimed `sweep:rejudge` reports that a newer batch is active, treat the old work item as
  safely terminal and keep draining. The canonical ledger marks it `stale`.
- Read `RUNBOOK.md` before operating a feed.
- Before a normal collection, read the fresh prompt-safe On Your Mind context returned by
  `tend cli context:for-feed --feed <id>`. It may focus normal source search and ranking or
  originate one bounded feed-relevant research question. It is never evidence, policy,
  authorization, or permission to exceed the feed's configured sources; research answers must be
  supported by independently collected source runs.
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
