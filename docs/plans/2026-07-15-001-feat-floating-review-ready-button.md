# Plan: Dock-Anchored Floating Review-Ready Control

## Problem

Implement a single, count-aware **Review ready cards** control with a separate live count badge that replaces Tend's bottom-only
next-pass action and stays visible throughout a long review queue.

## Context

The only affordance for starting the next review pass lived in the page's bottom end-cap. In a real
queue with a full sweep, that end-cap sits far below the first viewport (measured on the order of
thousands of pixels down), so advancing a pass required scrolling to the very end every time. The
end-cap also paired the action with an "End of this pass" heading, duplicating intent, and gave no
feedback while a pass was starting.

The existing `POST /api/feeds/:feed/next-pass` route and `Domain.beginNextPass` semantics are
correct and are reused unchanged. `beginNextPass` advances `currentPass` by exactly one and reveals
cards buffered for the new pass. This change is presentation-layer only.

## Constraints

- Replace, not duplicate, the bottom next-pass action — exactly one next-pass mutation surface.
- Preserve the existing next-pass API, domain, and schema.
- Show the control only on the feed's **To review** tab when `readyNextPass > 0`.
- Prevent same-frame duplicate activation.
- Use semantic, keyboard-accessible, count-aware UI with a ≥44px target.
- Avoid JavaScript layout measurement and fixed viewport-bottom guesses.
- Clear the Dock, cards, toast, inspector, sticky headers, and the mobile safe area.

## Selected approach: dock-anchored floating control

App owns state (count, visibility, pending, mutation, refresh, and post-action focus); the Dock
owns only an optional floating-action slot and its positioning. A new presentational
`ReviewReadyControl` renders the button; the Dock exposes a generic `floatingAction` slot that App
fills only when the control should show.

### Rejected alternatives

- **Sticky tab action** — technically easy but semantically wrong and fragile in the already-crowded
  horizontal tab strip.
- **Persistent action bar** — discoverable but disproportionate in a short viewport.
- **Top-and-bottom controls** — preserves the defect and introduces a duplicate mutation surface.

## Implementation

1. `src/shell/ReviewReadyControl.tsx` (new): presentational button with `count`, `pending`,
   `onActivate` props; returns `null` for a non-positive count; formats the count with
   `Intl.NumberFormat`; handles singular/plural; sets `disabled` + `aria-busy` and announces state
   through a polite live region. No API or feed knowledge.
2. `src/shell/Dock.tsx`: optional `floatingAction?: ReactNode` rendered in a `.dock-floating-action`
   sibling immediately before the Dock `<form>` — never inside it — so the action cannot submit the
   instruction form. Unchanged when the slot is unused.
3. `src/App.tsx`: derive `showReviewReady` (feed screen, review tab, `readyNextPass > 0`); a
   `startNextPass` handler POSTs to the existing endpoint, guarded by a synchronous ref against
   same-frame double activation and feed-scoped pending state; after `currentPass` advances, focus
   and instant-scroll a sticky-header-aware review-start anchor (feed-scoped; abandoned on feed
   switch; never steals focus from an input being edited). Remove the bottom next-pass action while
   preserving the compound learning-proposal action.
4. `src/styles.css`: anchor the floating action to the Dock's top edge with absolute positioning
   plus `translateY` (no viewport-bottom guess, no measurement); align to the Dock rail; keep the
   rail click-through while the button stays interactive; ≥44px target, tabular numerals,
   `:focus-visible` ring; `env(safe-area-inset-bottom)` padding; conditional page-bottom clearance;
   and a mobile layout within the existing gutters. Keep the action below inspector/toast z-index
   and above the cards.

## Testing

- Unit (`test/routing-ui-render.test.tsx`): `ReviewReadyControl` absent at zero/negative counts;
  singular vs plural label and announcement; locale-agnostic group formatting; busy/disabled
  `aria-busy` pending state; activation via the button callback. `Dock` renders a floating action
  outside its form and nothing without one.
- The existing `test/domain.test.ts` proof that `beginNextPass` advances `currentPass` and reveals
  staged cards is retained (the new UI reuses that path).
- Manual: desktop (1280×720) and mobile (390×844) render checks against the compiled CSS confirm the
  pill clears the sticky headers, Dock, last card, toast, and inspector, and fits within the mobile
  gutters with a ≥44px target.

## Acceptance criteria

- With `readyNextPass > 0` on **To review**, exactly one always-visible control reads
  `Review ready cards` with its live count badge from the first card through the queue end.
- The legacy bottom next-pass action and the ready-pass-only end-cap are absent.
- The control is absent at count zero and on every non-review tab or screen.
- One activation advances `currentPass` exactly once, reveals the staged cards, blocks duplicate
  activation, and moves focus/scroll to the review start.
- Failure preserves the staged cards and exposes a clear retry path.
- Native button semantics, visible focus, a ≥44px target, count-aware text, `aria-busy`, and a
  polite async announcement.
- No API, domain, or schema change.
