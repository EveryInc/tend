import { useEffect, type RefObject } from "react";
import type { Card, ReadingEngagementClickTarget, ReadingEngagementInput } from "../../shared/types";
import { post } from "../app/api";

export const ENGAGEMENT_FLUSH_MS = 15_000;
export const ENGAGEMENT_IDLE_MS = 60_000;

export type DwellSample = { at: number; visible: boolean; lastActivity: number };
/** Visible exposure, not proof of reading. Background, idle and stalled intervals do not accrue. */
export function engagementDwellDelta(previous: DwellSample | undefined, next: DwellSample): number {
  const elapsed = previous ? next.at - previous.at : 0;
  return previous?.visible && next.visible && elapsed > 0 && elapsed <= 1_000
    && next.at - next.lastActivity <= ENGAGEMENT_IDLE_MS ? elapsed : 0;
}

export function engagementClickTarget(target: Element): ReadingEngagementClickTarget {
  const control = target.closest<HTMLElement>("[data-reading-interaction]");
  if (control) return control.dataset.readingInteraction as ReadingEngagementClickTarget;
  const summary = target.closest(".reading-sources > summary");
  if (summary) return summary.closest("details")?.open ? "sources_close" : "sources_open";
  if (target.closest("a")) return "source_link";
  return "card";
}

/** Local, bounded telemetry tied to the exact displayed version; no text or URLs leave the card. */
export function useReadingEngagement(root: RefObject<HTMLElement>, card: Card, sessionId?: string) {
  const revision = card.reading?.contentRevision;
  useEffect(() => {
    const element = root.current;
    if (!element || !revision || !sessionId) return;
    const endpoint = `/api/feeds/${encodeURIComponent(card.feedId)}/cards/${encodeURIComponent(card.id)}/engagement`;
    let previous: DwellSample | undefined;
    let lastActivity = performance.now();
    let dwellMs = 0;
    let lastFlush = performance.now();
    let disposed = false;
    let selectionClickUntil = 0;
    type SelectionRange = { start: Node; startOffset: number; end: Node; endOffset: number };
    let lastSelection: SelectionRange | undefined;
    let gesture: { kind: "pointer" | "keyboard"; pointerId?: number; initial?: SelectionRange } | undefined;
    const selectionRange = (): SelectionRange | undefined => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount !== 1) return;
      const range = selection.getRangeAt(0);
      return { start: range.startContainer, startOffset: range.startOffset, end: range.endContainer, endOffset: range.endOffset };
    };
    const sameRange = (left: SelectionRange | undefined, right: SelectionRange | undefined) => Boolean(left && right
      && left.start === right.start && left.startOffset === right.startOffset && left.end === right.end && left.endOffset === right.endOffset);
    const record = (entry: { type: "dwell"; dwellMs: number } | { type: "click"; target: ReadingEngagementClickTarget } | { type: "selection"; selectionChars: number }, keepalive = false) => {
      const payload: ReadingEngagementInput = { clientEventId: crypto.randomUUID(), sessionId, contentRevision: revision, ...entry };
      // Analytics failure cannot block feedback. A bounded periodic flush limits unload loss;
      // keepalive is best effort, not a delivery or reading guarantee.
      void post(endpoint, payload, { keepalive }).catch(() => {});
    };
    const flush = (keepalive = false) => {
      const duration = Math.min(60_000, Math.round(dwellMs));
      dwellMs = 0;
      lastFlush = performance.now();
      if (duration > 0) record({ type: "dwell", dwellMs: duration }, keepalive);
    };
    const sample = () => {
      const now = performance.now();
      const rect = element.getBoundingClientRect();
      const top = (document.querySelector(".tabs")?.getBoundingClientRect().bottom ?? 0) + 8;
      const bottom = Math.min(window.innerHeight, document.querySelector(".dock")?.getBoundingClientRect().top ?? window.innerHeight) - 8;
      const visibleHeight = Math.max(0, Math.min(rect.bottom, bottom) - Math.max(rect.top, top));
      const visible = document.visibilityState === "visible" && document.hasFocus() && rect.height > 0 && bottom > top
        && visibleHeight >= Math.min(rect.height * 0.5, (bottom - top) * 0.6);
      const next = { at: now, visible, lastActivity };
      dwellMs += engagementDwellDelta(previous, next);
      previous = next;
      if (now - lastFlush >= ENGAGEMENT_FLUSH_MS) flush();
    };
    const activity = (event: Event) => { if (event.isTrusted) lastActivity = performance.now(); };
    const click = (event: MouseEvent) => {
      if (!event.isTrusted || !(event.target instanceof Element)) return;
      activity(event);
      const target = engagementClickTarget(event.target);
      if (target === "card" && performance.now() < selectionClickUntil) return;
      // Capture once before nested controls stop propagation or switch the selected version.
      record({ type: "click", target });
    };
    const selectionChange = () => { if (window.getSelection()?.isCollapsed) lastSelection = undefined; };
    const completedSelection = (initial?: SelectionRange) => {
      if (disposed) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
      const range = selection.getRangeAt(0);
      if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return;
      const inEditor = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest("input, textarea, select, button, [contenteditable]:not([contenteditable='false'])");
      if (inEditor(range.startContainer) || inEditor(range.endContainer)) return;
      const current = selectionRange();
      if (sameRange(current, initial) || sameRange(current, lastSelection)) return;
      const selectionChars = Math.min(50_000, range.toString().length);
      if (!selectionChars) return;
      lastSelection = current;
      lastActivity = performance.now();
      selectionClickUntil = lastActivity + 250;
      record({ type: "selection", selectionChars });
    };
    const pointerDown = (event: PointerEvent) => {
      activity(event);
      gesture = event.isTrusted && event.target instanceof Node && element.contains(event.target)
        ? { kind: "pointer", pointerId: event.pointerId, initial: selectionRange() } : undefined;
    };
    const pointerUp = (event: PointerEvent) => {
      const started = gesture;
      gesture = undefined;
      if (event.isTrusted && started?.kind === "pointer" && started.pointerId === event.pointerId) queueMicrotask(() => completedSelection(started.initial));
    };
    const keyDown = (event: KeyboardEvent) => {
      activity(event);
      if (!event.isTrusted || (!event.shiftKey && event.key !== "Shift") || gesture?.kind === "keyboard") return;
      const selection = selectionRange();
      if (selection && element.contains(selection.start)) gesture = { kind: "keyboard", initial: selection };
    };
    const keyUp = (event: KeyboardEvent) => {
      if (!event.isTrusted || event.key !== "Shift") return;
      const started = gesture;
      gesture = undefined;
      if (started?.kind === "keyboard") queueMicrotask(() => completedSelection(started.initial));
    };
    const shortcut = (event: Event) => {
      const target = (event as CustomEvent).detail;
      if (target === "previous_version" || target === "next_version") record({ type: "click", target });
    };
    const pause = () => { sample(); previous = undefined; flush(true); };
    const visibility = () => { if (document.visibilityState !== "visible") pause(); else previous = undefined; };
    element.addEventListener("click", click, true);
    element.addEventListener("reading-shortcut", shortcut);
    window.addEventListener("wheel", activity, { passive: true });
    window.addEventListener("pointermove", activity, { passive: true });
    window.addEventListener("pointerdown", pointerDown, { passive: true });
    window.addEventListener("keydown", keyDown);
    window.addEventListener("pointerup", pointerUp);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", pause);
    window.addEventListener("pagehide", pause);
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener("selectionchange", selectionChange);
    sample();
    const timer = window.setInterval(sample, 250);
    return () => {
      disposed = true;
      sample(); flush(true);
      window.clearInterval(timer);
      element.removeEventListener("click", click, true);
      element.removeEventListener("reading-shortcut", shortcut);
      window.removeEventListener("wheel", activity);
      window.removeEventListener("pointermove", activity);
      window.removeEventListener("pointerdown", pointerDown);
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("pointerup", pointerUp);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", pause);
      window.removeEventListener("pagehide", pause);
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("selectionchange", selectionChange);
    };
  }, [root, card.id, card.feedId, revision, sessionId]);
}
