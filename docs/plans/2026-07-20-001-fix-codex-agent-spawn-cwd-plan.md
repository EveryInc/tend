---
title: "fix: Use a real working directory for Codex launches"
type: fix
status: completed
date: 2026-07-20
---

# fix: Use a real working directory for Codex launches

## Summary

Make packaged Tend launch Codex from a validated on-disk working directory instead of Bun's virtual module directory, covering both email-card Agent conversations and automatic drain turns while preserving the existing app-server protocol and safety boundaries.

## Problem Frame

The Agent button repeatedly fails with `posix_spawn ... ENOENT` even though each reported executable exists and runs directly. In a compiled Bun executable, `import.meta.url` resolves beneath `/$bunfs/`; Tend currently derives its server root from that virtual location and passes it as the child process `cwd`. An invalid `cwd` makes `posix_spawn` report ENOENT against the valid executable, which caused earlier executable-resolution changes to address the wrong layer.

## Assumptions

*This plan was authored within the non-interactive LFG pipeline. These are explicit implementation bets for downstream review.*

- The service's real startup directory is the intended default workspace for newly spawned email tasks; callers may still supply another verified on-disk workspace explicitly.
- A shared working-directory resolver should protect every Codex app-server launch rather than special-casing only the Inbox route.
- Existing executable discovery remains in scope only where needed to keep minimal-PATH packaged launches working; broader launcher redesign is deferred.

## Requirements

- R1. Clicking **Start in Codex** from an email card must start a new Codex task when Tend is running from `dist-bin/tend`.
- R2. Tend must never pass a virtual, missing, or non-directory path as a child process working directory.
- R3. The Agent task must retain the complete email context and the user's additional instructions.
- R4. Existing explicit-confirmation and approval semantics for external actions must remain unchanged.
- R5. The automatic Codex drain path must use the same valid working-directory invariant.
- R6. Launch failures must identify the invalid launch context accurately instead of misleadingly presenting a valid executable as missing.

## Scope Boundaries

- Do not change Inbox card ranking, queue projection, Gmail mutation behavior, or approval verification.
- Do not create a real user-owned Codex task during automated tests.
- Do not redesign the app-server JSON-RPC lifecycle or Codex task deep-link format.

### Deferred to Follow-Up Work

- General multi-candidate retry and executable health probing beyond the confirmed invalid-`cwd` defect.
- Broader lifecycle supervision after the initial app-server turn is accepted.

## Context & Research

### Relevant Code and Patterns

- `server.ts` derives `root` from `import.meta.url` and supplies it to both API context and `DrainDispatcher`.
- `server/routes/api.ts` forwards that root to `startCodexThread` after assembling the authoritative email prompt.
- `server/codexAppServer.ts` uses the supplied value as `cwd` for both conversation and drain subprocesses.
- `server/cli/start.ts` starts the packaged server from a real operating-system working directory.
- `test/codex-app-server.test.ts` covers launcher argument resolution; `test/api-routes.test.ts` covers successful task receipts through dependency injection.

### Institutional Learnings

- `docs/plans/2026-07-04-001-feat-claude-wake-lane-plan.md` treats Codex app-server execution and approval semantics as an established boundary; this fix must not alter that protocol.
- No existing `docs/solutions/` entry covers compiled Bun virtual paths or child-process working directories.

### External References

- External research is unnecessary: the failure was reproduced locally with the exact packaged binary, and the native Codex executable succeeds under the same minimal environment when given a valid `cwd`.

## Key Technical Decisions

- Resolve the task workspace from an explicit real filesystem directory rather than a module URL, because packaged module URLs are implementation details of the bundler.
- Validate the working directory before process creation and surface a context-specific error, because `posix_spawn` otherwise misattributes missing `cwd` failures to the executable.
- Apply the invariant at the shared app-server boundary so the Agent and dispatcher paths cannot diverge.

## Open Questions

### Resolved During Planning

- **Is the Codex executable actually absent?** No. The ChatGPT-bundled arm64 executable runs directly, under a minimal PATH, and through Bun when the working directory exists.
- **Is the live service stale?** No. The live compiled process contains and selects the latest native Codex resolver.
- **Why did three different executable paths all report ENOENT?** They shared the same invalid `/$bunfs/...` working directory.

### Deferred to Implementation

- Whether the cleanest shared seam is a dedicated resolver in `server/codexAppServer.ts` or an on-disk application-root resolver used by `server.ts`; implementation should choose the smallest boundary that makes both callers explicit and testable.

## Implementation Units

- U1. **Establish and enforce the launch working-directory invariant**

**Goal:** Ensure all Codex subprocesses receive a verified, real on-disk directory and never a compiled Bun virtual module path.

**Requirements:** R1, R2, R5, R6

**Dependencies:** None

**Files:**
- Modify: `server.ts`
- Modify: `server/codexAppServer.ts`
- Modify if required by the selected boundary: `server/dispatcher.ts`
- Test: `test/codex-app-server.test.ts`

**Approach:**
- Separate source-module location from the workspace supplied to child processes.
- Validate that the effective directory exists and is a directory before spawning.
- Use the same validated path for direct Agent launches and dispatcher drains.
- Preserve explicit caller-provided real workspaces.

**Execution note:** Start with a failing regression that reproduces the misleading ENOENT from an existing executable plus a nonexistent Bun virtual `cwd`.

**Patterns to follow:**
- Keep launch construction centralized beside `appServerArgv` in `server/codexAppServer.ts`.
- Preserve dependency injection used by `test/api-routes.test.ts`.

**Test scenarios:**
- Regression: existing executable plus `/$bunfs/root` as requested workspace is rejected or resolved before spawn, never emitted as an executable ENOENT.
- Happy path: a valid explicitly supplied workspace is preserved.
- Packaged fallback: virtual module root plus a valid service startup directory resolves to the real directory.
- Error path: no valid requested or fallback directory produces an actionable working-directory error before spawn.
- Integration: direct Agent and dispatcher launch construction receive the same valid `cwd`.

**Verification:**
- No app-server spawn call can receive `/$bunfs/...` or another missing directory.
- Failures name the working-directory problem and candidate paths.

- U2. **Preserve the Agent task contract across the corrected launch boundary**

**Goal:** Prove that correcting `cwd` does not alter email context, instructions, persistence, deep links, or safety behavior.

**Requirements:** R1, R3, R4, R6

**Dependencies:** U1

**Files:**
- Modify only if necessary: `server/routes/api.ts`
- Test: `test/api-routes.test.ts`
- Test: `test/codex-app-server.test.ts`

**Approach:**
- Keep prompt construction and receipt persistence unchanged.
- Exercise the launcher through a real harmless app-server handshake or controlled fixture without creating a user task.
- Confirm persistence happens only after Codex accepts task creation.

**Execution note:** Extend characterization coverage before changing route behavior; avoid route changes unless the shared invariant requires a caller contract adjustment.

**Patterns to follow:**
- Existing injected `startCodexThread` API-route test double.
- Existing `approvalPolicy: "never"` and explicit external-action confirmation language.

**Test scenarios:**
- Happy path: additional instructions and authoritative email context reach the launcher unchanged.
- Safety: the external-mutation confirmation instruction remains in the prompt.
- Failure path: launch failure creates no `agentThreads` receipt or `codex.thread_started` event.
- Success path: accepted task returns the same deep-link shape and persists exactly one receipt.

**Verification:**
- Route contract tests pass without weakening safety assertions.
- A packaged-runtime smoke test reaches app-server initialization from a valid directory without creating a real task.

## System-Wide Impact

- **Interaction graph:** Browser Agent action → API prompt assembly → shared Codex launcher → app-server; dispatcher → the same launcher invariant.
- **Error propagation:** Invalid working directories fail before spawn with contextual diagnostics; protocol errors continue through existing rejection handling.
- **State lifecycle risks:** Card task receipts and events must remain absent on launch failure and written exactly once after acceptance.
- **API surface parity:** No external API shape change is intended.
- **Observability:** Errors should distinguish invalid `cwd` from executable discovery and app-server protocol failures.

## Risks & Mitigations

- Choosing `process.cwd()` blindly could still fail when Tend is started elsewhere; validate it and allow an explicit real workspace.
- Fixing only the Inbox route would leave auto-drain broken; enforce the invariant at the shared launcher boundary.
- A smoke test that creates a real task would pollute user state; stop at harmless executable/app-server initialization or use a controlled fixture.

## Verification Strategy

- Run focused launcher and API route regressions first.
- Run the complete Bun test suite, type-check, lint, and production build.
- Compile `dist-bin/tend` and verify its embedded module root does not become the child `cwd`.
- Exercise the Agent control in the local in-app browser using an isolated fixture/card when practical, confirming the UI receives a deep link and no ENOENT.

## Sources & References

- `AGENTS.md`
- `server.ts`
- `server/codexAppServer.ts`
- `server/dispatcher.ts`
- `server/routes/api.ts`
- `test/codex-app-server.test.ts`
- `test/api-routes.test.ts`
- `docs/plans/2026-07-04-001-feat-claude-wake-lane-plan.md`
