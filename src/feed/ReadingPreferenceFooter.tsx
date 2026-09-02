import { useEffect, useRef, useState } from "react";
import type { ReadingCardGroup } from "../../shared/readingGroups";
import type { ReadingPreferenceInput, ReadingPreferenceState } from "../../shared/types";
import { ApiError, post } from "../app/api";
import type { Card, FeedView } from "../types";
import { readingMembers } from "./selectors";

export function ReadingPreferenceFooter({ group, card, preference, reaction, onChanged, onFeedback, onRecorded, onBusy }: {
  group: ReadingCardGroup;
  card: Card;
  preference?: ReadingPreferenceState;
  reaction?: NonNullable<FeedView["readingReactions"]>[string];
  onChanged: () => void;
  onFeedback?: () => void;
  onRecorded?: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const members = readingMembers(group);
  const key = JSON.stringify([group.id, members, card.id]);
  const currentKey = useRef(key);
  currentKey.current = key;
  const requestRef = useRef<ReadingPreferenceInput | null>(null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState("");
  const [posted, setPosted] = useState<{ key: string; cardId: string | null } | null>(null);
  const preferredId = posted?.key === key ? posted.cardId : preference?.preferredCardId;
  const preferred = preferredId === card.id;
  const preferredIndex = group.cards.findIndex((version) => version.id === preferredId);
  const workActive = group.cards.some((version) => ["queued", "working", "approved_blocked"].includes(version.status));
  const previousReaction = reaction && reaction.contentRevision === card.reading?.contentRevision ? reaction.reaction : null;

  useEffect(() => {
    requestRef.current = null;
    setError("");
    setStale(false);
    setPosted(null);
  }, [key]);
  useEffect(() => setPosted(null), [preference?.eventId]);

  const send = async (preferredCardId: string | null) => {
    if (inFlight.current || stale || workActive) return;
    const request = requestRef.current?.preferredCardId === preferredCardId ? requestRef.current : {
      clientEventId: crypto.randomUUID(), runId: group.runId!, topicKey: group.topicKey!, members, preferredCardId,
      ...(group.comparisonId ? { comparisonId: group.comparisonId } : {}),
    };
    requestRef.current = request;
    inFlight.current = true;
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      await post(`/api/feeds/${encodeURIComponent(card.feedId)}/reading-preferences`, request);
      if (currentKey.current !== key) return;
      requestRef.current = null;
      setPosted({ key, cardId: preferredCardId });
      onRecorded?.();
      onChanged();
    } catch (caught) {
      if (currentKey.current !== key) return;
      if (caught instanceof ApiError && caught.status === 409) {
        requestRef.current = null;
        const changed = caught.code === "stale_members" || caught.code === "stale_content";
        setStale(changed);
        setError(changed ? "These versions changed. Refresh before choosing a version." : caught.message);
        onChanged();
      } else setError(caught instanceof Error ? caught.message : "Your preference could not be saved. Try again.");
    } finally {
      inFlight.current = false;
      setBusy(false);
      onBusy(false);
    }
  };

  return <footer className="card-action reading-footer" aria-busy={busy}>
    <div className="reading-reaction-row">
      <div className="reading-reaction-state" role="status" aria-live="polite">
        {busy ? "Saving…" : preferred ? "Your preferred version" : preferredIndex >= 0 ? `Version ${preferredIndex + 1} preferred` : workActive ? "A version has active work" : "Which version works better?"}
        {previousReaction && <small className="reading-prior-reaction">This version: {previousReaction === "like" ? "Liked" : "Not for me"}</small>}
      </div>
      <div className="action-buttons">
        <button type="button" className={`button ghost reading-reaction ${preferred ? "selected" : ""}`} aria-pressed={preferred} disabled={busy || stale || workActive} onClick={(event) => { event.stopPropagation(); void send(preferred ? null : card.id); }}>Prefer this version</button>
        {onFeedback && <button type="button" className="button text" onClick={(event) => { event.stopPropagation(); onFeedback(); }}>Feedback</button>}
      </div>
    </div>
    <small className="reading-local-note">{preferred ? "Click again to clear the preference. Archived versions stay in Done." : `Moves all ${group.cards.length} versions to Done without changing their ratings.`}</small>
    {error && <div className="reading-error" role="alert"><span>{error}</span>
      {!stale && requestRef.current && <button type="button" className="button text" disabled={busy} onClick={(event) => { event.stopPropagation(); if (requestRef.current) void send(requestRef.current.preferredCardId); }}>Retry</button>}
      {stale && <button type="button" className="button text" onClick={(event) => { event.stopPropagation(); onChanged(); }}>Refresh versions</button>}
    </div>}
  </footer>;
}
