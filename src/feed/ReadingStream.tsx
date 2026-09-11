import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import type { ReadingCardGroup } from "../../shared/readingGroups";
import type { Card, ReadingGroupMember, ReadingProgressState } from "../../shared/types";
import { ApiError, post } from "../app/api";
import { emptyReadingExposure, READING_INPUT_WINDOW_MS, sampleReadingExposure } from "../state/readingExposure";
import { readingMembers } from "./selectors";
import { useReadingEngagement } from "../state/readingEngagement";

type ProgressRequest = {
  clientEventId: string;
  groupId: string;
  members: ReadingGroupMember[];
  viewedMembers: ReadingGroupMember[];
  read: boolean;
  expectedEventId?: string;
  expectedCardUpdatedAt?: Record<string, string>;
};

export type ReadingProgressReceipt = { progress: ReadingProgressState };
export type ReadingUndo = { feedId: string; progress: ReadingProgressState; title: string };
let suppressScrollUntil = 0;

export function ReadingStreamControls({ mode, onChange, busy }: {
  mode: "review" | "stream";
  onChange: (mode: "review" | "stream") => void;
  busy: boolean;
}) {
  return <section className="reading-stream-controls" aria-label="Reading behavior">
    <div>
      <label htmlFor="reading-mode">Reading cards</label>
      <p>{mode === "stream" ? "Read as you scroll. Cards stay here so you can go back and add feedback. Next visit starts with unread cards." : "Cards stay until you review them. Or mark them read as you scroll, with ratings optional."}</p>
    </div>
    <select id="reading-mode" value={mode} disabled={busy} onChange={(event) => {
      onChange(event.target.value as "review" | "stream");
      event.currentTarget.blur();
    }}>
      <option value="review">Keep until reviewed</option>
      <option value="stream">Mark read as I scroll</option>
    </select>
  </section>;
}

type Anchor = { id: string; top: number; focus: boolean };
type ViewportProps = { enabled: boolean; sessionKey: string; ids: string[]; children: ReactNode };

/** Capture before React removes an offscreen card; keep the next card at the same visual position. */
export class ReadingStreamViewport extends Component<ViewportProps> {
  private root: HTMLDivElement | null = null;

  getSnapshotBeforeUpdate(previous: ViewportProps): Anchor | null {
    if (!this.props.enabled || !previous.enabled || previous.sessionKey !== this.props.sessionKey || !this.root) return null;
    const retained = new Set(this.props.ids);
    const removed = [...this.root.querySelectorAll<HTMLElement>("[data-reading-slot]")]
      .filter((element) => !retained.has(element.dataset.readingSlot!));
    const focus = removed.some((element) => element.contains(document.activeElement));
    if (!removed.some((element) => element.getBoundingClientRect().bottom <= 110) && !focus) return null;
    const anchor = [...this.root.querySelectorAll<HTMLElement>("[data-reading-slot]")].find((element) => {
      const rect = element.getBoundingClientRect();
      return retained.has(element.dataset.readingSlot!) && rect.bottom > 110 && (focus || rect.top < window.innerHeight);
    });
    return anchor ? { id: anchor.dataset.readingSlot!, top: anchor.getBoundingClientRect().top, focus } : null;
  }

  componentDidUpdate(_previous: ViewportProps, _state: unknown, anchor: Anchor | null) {
    if (!anchor || !this.root) return;
    const element = [...this.root.querySelectorAll<HTMLElement>("[data-reading-slot]")].find((item) => item.dataset.readingSlot === anchor.id);
    if (!element) return;
    if (anchor.focus) element.focus({ preventScroll: true });
    const delta = element.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) > 1) {
      suppressScrollUntil = performance.now() + READING_INPUT_WINDOW_MS;
      window.scrollBy({ top: delta, behavior: "instant" });
    }
  }

  render() {
    return <div className="reading-stream-list" ref={(element) => { this.root = element; }}>{this.props.children}</div>;
  }
}

export function ReadingStreamCard({ group, card, enabled, history, progress, busy: workBusy, onChanged, onRead, onUnread, children, engagementSessionId }: {
  group: ReadingCardGroup;
  card: Card;
  enabled: boolean;
  history: boolean;
  progress?: ReadingProgressState;
  busy: boolean;
  onChanged: () => void;
  onRead: (undo: ReadingUndo) => void;
  onUnread?: (previous: ReadingProgressState) => void;
  children: ReactNode;
  engagementSessionId?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  useReadingEngagement(root, card, engagementSessionId);
  const viewed = useRef(new Map<string, ReadingGroupMember>());
  const inFlight = useRef(false);
  const retryRequest = useRef<ProgressRequest | null>(null);
  const savedReadKey = useRef<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [paused, setPaused] = useState(false);
  const membersKey = JSON.stringify(readingMembers(group));
  const attentionKey = JSON.stringify(group.cards.map((member) => [member.id, member.updatedAt, member.status, member.history]));
  const currentKey = `${membersKey}\0${attentionKey}`;
  const read = progress?.read === true;
  const reviewed = group.cards.every((member) => member.status === "done");
  const canRead = enabled && !workBusy && !read && !reviewed;
  const enabledRef = useRef(canRead);
  enabledRef.current = canRead;
  const latest = useRef({ group, card, progress, onChanged, onRead, onUnread });
  latest.current = { group, card, progress, onChanged, onRead, onUnread };

  useEffect(() => { viewed.current.clear(); retryRequest.current = null; setPaused(false); setError(""); }, [membersKey, attentionKey, progress?.eventId, history]);
  useEffect(() => { if (progress?.read === false) savedReadKey.current = null; }, [progress?.eventId, progress?.read]);

  const send = async (read: boolean, explicit = false) => {
    if (inFlight.current || workBusy) return;
    if (read && (!enabledRef.current || savedReadKey.current === currentKey)) return;
    const current = latest.current;
    if (!current.card.reading) return;
    if (explicit && read) viewed.current.set(current.card.id, { cardId: current.card.id, contentRevision: current.card.reading.contentRevision });
    const request = (retryRequest.current?.read === read ? retryRequest.current : null) ?? {
      clientEventId: crypto.randomUUID(), groupId: current.group.id, members: readingMembers(current.group),
      viewedMembers: read ? [...viewed.current.values()] : current.progress?.viewedMembers ?? [], read,
      expectedCardUpdatedAt: Object.fromEntries(current.group.cards.map((member) => [member.id, member.updatedAt])),
      ...(current.progress ? { expectedEventId: current.progress.eventId } : {}),
    };
    if (request.read && !request.viewedMembers.length) return;
    retryRequest.current = request;
    inFlight.current = true;
    setSaving(true);
    setError("");
    try {
      const receipt = await post<ReadingProgressReceipt>(`/api/feeds/${encodeURIComponent(current.card.feedId)}/reading-progress`, request);
      retryRequest.current = null;
      savedReadKey.current = receipt.progress?.read ? currentKey : null;
      if (request.read && receipt.progress?.read) current.onRead({ feedId: current.card.feedId, progress: receipt.progress, title: current.card.title });
      if (!request.read && !receipt.progress?.read && current.progress) current.onUnread?.(current.progress);
      current.onChanged();
    } catch (caught) {
      setPaused(true); // Never loop automatic retries or drop a card whose save failed.
      if (caught instanceof ApiError && caught.status === 409) retryRequest.current = null;
      setError(caught instanceof Error ? caught.message : "Could not save reading progress.");
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  const sendRef = useRef(send);
  sendRef.current = send;

  useEffect(() => {
    if (!canRead || paused || !card.reading || history) return;
    let exposure = emptyReadingExposure();
    let lastForwardInput = -Infinity;
    let previousY = window.scrollY;
    let touchY: number | undefined;
    let disposed = false;
    const sample = (scrolled = false) => {
      const element = root.current;
      if (!element || disposed || inFlight.current) return;
      const face = element.querySelector<HTMLElement>(".reading-face");
      const head = element.querySelector<HTMLElement>(".card-head");
      if (!face || !head) return;
      const now = performance.now();
      const rect = element.getBoundingClientRect();
      const start = head.getBoundingClientRect().top;
      const end = face.getBoundingClientRect().bottom;
      const top = (document.querySelector(".tabs")?.getBoundingClientRect().bottom ?? 102) + 8;
      const dockTop = document.querySelector(".dock")?.getBoundingClientRect().top ?? window.innerHeight - 100;
      const noticeTop = document.querySelector(".reading-undo")?.getBoundingClientRect().top ?? window.innerHeight;
      const bottom = Math.max(top + 80, Math.min(dockTop, noticeTop) - 8);
      const visible = Math.max(0, Math.min(end, bottom) - Math.max(start, top));
      const meaningful = visible >= Math.min((end - start) * 0.65, (bottom - top) * 0.6);
      const currentY = window.scrollY;
      const forwardScroll = scrolled && now > suppressScrollUntil && currentY > previousY + 1 && now - lastForwardInput <= READING_INPUT_WINDOW_MS;
      if (scrolled) previousY = currentY;
      // Clicking a version button leaves it focused; subsequent deliberate scrolling must still
      // work. Editors, selected text, open author popovers and pending mutations remain protected.
      const editing = document.activeElement?.matches("input, textarea, select, [contenteditable='true']");
      const interacting = Boolean(element.querySelector("[aria-busy='true'], .reading-identity-popover"));
      const result = sampleReadingExposure(exposure, {
        now, foreground: document.visibilityState === "visible" && document.hasFocus() && !editing && !interacting && window.getSelection()?.isCollapsed !== false, meaningful,
        sawStart: start >= top - 8 && start < bottom,
        sawEnd: end <= bottom + 8 && end > top,
        passed: rect.bottom <= top,
        forwardScroll,
      });
      exposure = result.state;
      if (exposure.qualified) viewed.current.set(card.id, { cardId: card.id, contentRevision: card.reading!.contentRevision });
      if (result.markRead) void sendRef.current(true);
    };
    const onWheel = (event: WheelEvent) => { if (event.isTrusted && event.deltaY > 0) lastForwardInput = performance.now(); };
    const onKey = (event: KeyboardEvent) => {
      if (!event.isTrusted || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
      if (["ArrowDown", "PageDown", " "].includes(event.key)) lastForwardInput = performance.now();
    };
    const onTouchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY; };
    const onTouchMove = (event: TouchEvent) => {
      const next = event.touches[0]?.clientY;
      if (event.isTrusted && next !== undefined && touchY !== undefined && next < touchY) lastForwardInput = performance.now();
      touchY = next;
    };
    const onScroll = () => sample(true);
    const reset = () => { exposure = emptyReadingExposure(); lastForwardInput = -Infinity; };
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("keydown", onKey);
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("blur", reset);
    document.addEventListener("visibilitychange", reset);
    const timer = window.setInterval(sample, 250);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("blur", reset);
      document.removeEventListener("visibilitychange", reset);
    };
  }, [canRead, paused, card.id, card.reading?.contentRevision, history, membersKey, attentionKey, progress?.eventId]);

  const readingState = (enabled || history) && !workBusy ? read ? "read" : reviewed ? "reviewed" : "unread" : "unread";
  return <div ref={root} data-reading-slot={group.id} data-reading-state={readingState} tabIndex={-1} className={`reading-stream-slot${readingState !== "unread" ? " is-complete" : ""}`}>
    {children}
    {(enabled || (history && read)) && <div className="reading-progress-control">
      <span>{read ? `Read · ${progress?.viewedMembers.length ?? 0} of ${group.cards.length} version${group.cards.length === 1 ? "" : "s"} viewed · no rating implied` : reviewed ? "Reviewed · you can still compare and add feedback" : "No opinion needed"}</span>
      {(read || !reviewed) && <button type="button" className="button text" data-reading-interaction={read ? "mark_unread" : "mark_read"} disabled={saving || workBusy} onClick={() => void send(!read, true)}>
        {saving ? "Saving…" : read ? "Mark unread" : "Mark read"}
      </button>}
    </div>}
    {error && <div className="reading-progress-error" role="alert">{error} <button type="button" className="button text" disabled={saving} onClick={() => retryRequest.current ? void send(retryRequest.current.read) : onChanged()}>{retryRequest.current ? "Retry" : "Refresh"}</button></div>}
  </div>;
}
