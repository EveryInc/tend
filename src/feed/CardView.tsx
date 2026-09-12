import { useEffect, useRef, useState } from "react";
import { containsFullEmail } from "../../shared/emailThread";
import type { ReadingCardGroup } from "../../shared/readingGroups";
import type { ReadingPreferenceState } from "../../shared/types";
import { ApiError, post } from "../app/api";
import type { Card, CardAction, CardBlock, FeedView, WorkItemView } from "../types";
import { DetachedLink } from "../ui/DetachedLink";
import { FormattedText } from "../ui/FormattedText";
import { ReadingIdentity } from "./ReadingIdentity";
import { ReadingPreferenceFooter } from "./ReadingPreferenceFooter";
import { visibleCardActions } from "./selectors";

function readableHistory(card: Card): Array<{ at: string; label: string; detail: string; tone?: "attention" }> {
  return card.history.flatMap((entry) => {
    if (entry.type === "user.scoped_instruction" || entry.type === "user.instruction") {
      return [{ at: entry.at, label: "You asked", detail: entry.detail ?? "Handle this card." }];
    }
    if (entry.type === "user.approved_action") {
      return [{ at: entry.at, label: "You approved", detail: "The previous next step." }];
    }
    if (entry.type === "user.default_cleanup_approved") {
      return [{ at: entry.at, label: "You approved", detail: "Archive this thread." }];
    }
    if (entry.type === "user.default_cleanup_undone") {
      return [{ at: entry.at, label: "You undid", detail: "The archive instruction." }];
    }
    if (entry.type === "user.edited_artifact") {
      return [{ at: entry.at, label: "You edited", detail: "The proposed artifact." }];
    }
    if (entry.type === "user.cancelled_queued_work") {
      return [{ at: entry.at, label: "You cancelled", detail: "The queued instruction." }];
    }
    if (entry.type === "user.edited_queued_instruction") {
      return [{ at: entry.at, label: "You corrected", detail: entry.detail ?? "The queued note." }];
    }
    if (entry.type === "user.card_dismissed") {
      return [{ at: entry.at, label: "You dismissed", detail: "Removed this card from review. The source was not changed." }];
    }
    if (entry.type === "user.returned_to_review") {
      return [{ at: entry.at, label: "Back for review", detail: "You moved this card back into the sweep." }];
    }
    if (entry.type === "codex.completed") {
      return [{ at: entry.at, label: "Codex did", detail: entry.detail ?? "Finished the requested work." }];
    }
    if (entry.type === "codex.stale_approval") {
      return [{ at: entry.at, label: "Needs review", detail: "The previous approval expired because the card changed. Review the current next step.", tone: "attention" as const }];
    }
    if (entry.type === "codex.failed") {
      return [{ at: entry.at, label: "Codex could not finish", detail: entry.detail ?? "The attempted work needs another look.", tone: "attention" as const }];
    }
    if (entry.type === "codex.approved_action_blocked") {
      return [{ at: entry.at, label: "Still approved", detail: entry.detail ?? "Codex needs to retry the approved action.", tone: "attention" as const }];
    }
    if (entry.type === "codex.approved_action_retry_queued") {
      return [{ at: entry.at, label: "Codex retrying", detail: "Your existing approval is still bound to the unchanged artifact." }];
    }
    if (entry.type === "codex.approved_action_reconciled") {
      return [{ at: entry.at, label: "Codex did", detail: entry.detail ?? "Recorded the approved action as completed after the connector succeeded." }];
    }
    if (entry.type === "routine_action.completed") {
      return [{ at: entry.at, label: "Codex did", detail: "Completed the approved routine cleanup." }];
    }
    return [];
  });
}

function CardHistory({ card }: { card: Card }) {
  const [expanded, setExpanded] = useState(false);
  const entries = readableHistory(card);
  if (!entries.length) return null;
  const visible = expanded ? entries : entries.slice(-3);
  return (
    <section className="card-history">
      <header>
        <span className="action-label">History</span>
        {entries.length > 3 && <button className="history-toggle" onClick={(event) => { event.stopPropagation(); setExpanded((value) => !value); }}>{expanded ? "Show less" : `Show all ${entries.length}`}</button>}
      </header>
      <ol>
        {visible.map((entry, index) => (
          <li className={entry.tone === "attention" ? "needs-attention" : ""} key={`${entry.at}-${index}`}>
            <b>{entry.label}</b>
            <span>{entry.detail}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function safeVideoHref(href: string): string | null {
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" ? href : null;
  } catch {
    return null;
  }
}

function videoEmbedUrl(href: string): string | null {
  try {
    const url = new URL(href);
    if (url.protocol !== "https:") return null;
    if (url.hostname === "www.loom.com" && url.pathname.startsWith("/share/")) {
      const id = url.pathname.slice("/share/".length).split("/")[0];
      return id && /^[a-zA-Z0-9_-]+$/.test(id) ? `https://www.loom.com/embed/${id}` : null;
    }
    if (url.hostname === "youtu.be") {
      const id = url.pathname.slice(1);
      return id && /^[a-zA-Z0-9_-]+$/.test(id) ? `https://www.youtube.com/embed/${id}` : null;
    }
    if ((url.hostname === "www.youtube.com" || url.hostname === "youtube.com") && url.pathname === "/watch") {
      const id = url.searchParams.get("v");
      return id && /^[a-zA-Z0-9_-]+$/.test(id) ? `https://www.youtube.com/embed/${id}` : null;
    }
    if (url.hostname === "drive.google.com") {
      const match = url.pathname.match(/^\/file\/d\/([a-zA-Z0-9_-]+)(?:\/|$)/);
      return match ? `https://drive.google.com/file/d/${match[1]}/preview` : null;
    }
  } catch {
    return null;
  }
  return null;
}

function Block({ feedId, cardId, block, onChanged }: { feedId: string; cardId: string; block: CardBlock; onChanged: () => void }) {
  const [value, setValue] = useState(block.value ?? "");
  useEffect(() => setValue(block.value ?? ""), [block.value]);

  const save = async () => {
    if (value === (block.value ?? "")) return;
    await post(`/api/feeds/${feedId}/cards/${cardId}/blocks/${block.id}`, { value });
    onChanged();
  };

  if (block.type === "editable_text") {
    return (
      <section className="block block-editor">
        {block.label && <h3>{block.label}</h3>}
        <textarea
          aria-label={block.label ?? "Editable card content"}
          data-block-id={block.id}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onBlur={() => void save()}
          rows={Math.max(4, value.split("\n").length + 1)}
        />
      </section>
    );
  }
  if (block.type === "image" && block.image) {
    return (
      <figure className="block block-image">
        {block.label && <figcaption>{block.label}</figcaption>}
        <DetachedLink href={`/api/artifacts/${block.image.name}`} aria-label={`Open card image: ${block.image.alt}`}>
          <img src={`/api/artifacts/${block.image.name}`} alt={block.image.alt} width={block.image.width} height={block.image.height} />
        </DetachedLink>
      </figure>
    );
  }
  if (block.type === "profile" && block.profile) {
    return (
      <section className="block block-profile">
        <DetachedLink className="profile-portrait" href={block.profile.href} aria-label={`Open ${block.profile.name} profile`}>
          <img
            src={block.profile.imageUrl}
            alt=""
            onError={(event) => {
              if (block.profile?.fallbackImageUrl && event.currentTarget.src !== block.profile.fallbackImageUrl) {
                event.currentTarget.src = block.profile.fallbackImageUrl;
              }
            }}
          />
        </DetachedLink>
        <div className="profile-copy">
          <DetachedLink className="profile-name" href={block.profile.href}>{block.profile.name}</DetachedLink>
          {block.profile.subtitle && <span className="profile-subtitle">{block.profile.subtitle}</span>}
          {block.profile.links && (
            <div className="profile-links">
              {block.profile.links.map((link) => <DetachedLink key={link.href} href={link.href}>{link.label}</DetachedLink>)}
            </div>
          )}
        </div>
      </section>
    );
  }
  if (block.type === "video" && block.video) {
    const href = safeVideoHref(block.video.href);
    const embedUrl = href ? videoEmbedUrl(href) : null;
    return (
      <section className="block block-video">
        {block.label && <h3>{block.label}</h3>}
        {embedUrl && (
          <div className="video-frame">
            <iframe
              src={embedUrl}
              title={block.video.title}
              loading="lazy"
              allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; fullscreen"
              allowFullScreen
            />
          </div>
        )}
        {href
          ? <DetachedLink className="video-link" href={href}>Open video: {block.video.title}</DetachedLink>
          : <span className="video-link">Video link unavailable</span>}
      </section>
    );
  }
  if (block.type === "evidence") {
    return (
      <section className="block block-evidence">
        {block.label && <h3>{block.label}</h3>}
        <ul>{block.items?.map((item, index) => (
          <li key={index}>
            {typeof item === "string"
              ? <FormattedText text={item} />
              : item.href
                ? <DetachedLink href={item.href}>{item.label}</DetachedLink>
                : <FormattedText text={item.label} />}
          </li>
        ))}</ul>
      </section>
    );
  }
  if (block.type === "checklist") {
    return (
      <section className="block block-checklist">
        {block.label && <h3>{block.label}</h3>}
        <ul>{block.items?.map((item, index) => <li key={index}><span className="checkmark">○</span>{typeof item === "string" ? item : item.label}</li>)}</ul>
      </section>
    );
  }
  if (block.type === "options") {
    return (
      <section className="block block-options">
        {block.label && <h3>{block.label}</h3>}
        {block.items?.map((item, index) => typeof item === "string"
          ? <div className="option" key={index}>{item}</div>
          : <div className="option" key={index}><b>{item.label}</b>{item.detail && <span>{item.detail}</span>}</div>)}
      </section>
    );
  }
  if (block.type === "chart" && block.chart) {
    const unit = block.chart.unit ?? "";
    return (
      <section className="block block-chart">
        {block.label && <h3>{block.label}</h3>}
        <div className="chart-legend">
          {block.chart.series.map((series, index) => <span key={series.label}><i className={`chart-swatch chart-series-${index + 1}`} />{series.label}</span>)}
        </div>
        <div className="chart-rows">
          {block.chart.rows.map((row) => (
            <div className="chart-row" key={row.label}>
              <div className="chart-row-label"><b>{row.label}</b>{row.detail && <span>{row.detail}</span>}</div>
              {row.values.map((value, index) => (
                <div className="chart-metric" key={`${row.label}-${index}`} aria-label={`${row.label}: ${block.chart?.series[index].label} ${value}${unit}`}>
                  <span className="chart-value">{value}{unit}</span>
                  <span className="chart-track"><i className={`chart-bar chart-series-${index + 1}`} style={{ width: `${value / block.chart!.max * 100}%` }} /></span>
                </div>
              ))}
            </div>
          ))}
        </div>
        {block.chart.note && <p className="chart-note">{block.chart.note}</p>}
      </section>
    );
  }
  if (block.type === "diff") {
    return (
      <section className="block block-diff">
        {block.label && <h3>{block.label}</h3>}
        <div className="diff-before">{block.before}</div>
        <div className="diff-after">{block.after}</div>
      </section>
    );
  }
  if (block.type === "clarification") {
    return <section className="block block-clarification"><h3>{block.label ?? "Needs your input"}</h3><p><FormattedText text={block.text} /></p></section>;
  }
  if (block.type === "receipt") {
    return <section className="block block-receipt"><h3>{block.label ?? "Done"}</h3><p><FormattedText text={block.text} /></p></section>;
  }
  if (block.type === "email_thread") {
    const fullEmail = containsFullEmail(block.text);
    return (
      <details className="block email-thread">
        <summary>{fullEmail ? "Read full email" : "Email details"} <kbd>O</kbd></summary>
        <div className="email-thread-body"><FormattedText text={block.text} /></div>
      </details>
    );
  }
  return <section className={`block block-${block.type}`}>{block.label && <h3>{block.label}</h3>}<p><FormattedText text={block.text} /></p></section>;
}

function QueuedNoteEditor({ work, onChanged }: { work: WorkItemView; onChanged: () => void }) {
  const [value, setValue] = useState(work.instruction);
  const [saving, setSaving] = useState(false);
  useEffect(() => setValue(work.instruction), [work.instruction]);
  const save = async () => {
    const next = value.trim();
    if (!next || next === work.instruction) return;
    setSaving(true);
    try {
      await post(`/api/feeds/${work.feedId}/work/${work.id}/instruction`, { instruction: next });
      onChanged();
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="queued-note">
      <span className="action-label">Queued note</span>
      <textarea aria-label="Queued note" value={value} onChange={(event) => setValue(event.target.value)} onBlur={() => void save()} rows={Math.max(2, value.split("\n").length)} />
      <small>{saving ? "Saving..." : "Edit before Codex claims it."}</small>
    </section>
  );
}

function ContextInfluenceReceipt({ card }: { card: Card }) {
  const influence = card.contextInfluence;
  if (!influence) return null;
  const sourceCount = influence.sourceCount ?? 0;
  const signalId = influence.signalIds[0];
  return (
    <section className={`context-influence context-influence-${influence.mode}`}>
      <div className="context-influence-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></svg>
      </div>
      <div>
        <span className="context-influence-label">{influence.mode === "research" ? "Prompted by On Your Mind" : "On your mind"}</span>
        <p>{influence.summary}</p>
        {influence.researchQuestion && <small>{influence.researchQuestion}</small>}
        <a href={`/mind/${encodeURIComponent(influence.updateId)}#signal-${encodeURIComponent(signalId)}`} onClick={(event) => event.stopPropagation()}>
          View context and {sourceCount} {sourceCount === 1 ? "source" : "sources"} <span aria-hidden="true">→</span>
        </a>
      </div>
    </section>
  );
}

type ReadingReaction = NonNullable<FeedView["readingReactions"]>[string];
type ReactionValue = ReadingReaction["reaction"];
type ReactionRequest = { clientEventId: string; contentRevision: string; reaction: ReactionValue };

function ReadingCardView({ card, active, reaction, group, preference, onVersion, onActivate, onChanged, onFeedback, onReactionRecorded, readingSession = false }: {
  card: Card;
  active: boolean;
  reaction?: ReadingReaction;
  group?: ReadingCardGroup;
  preference?: ReadingPreferenceState;
  onVersion?: (cardId: string) => void;
  onActivate: () => void;
  onChanged: () => void;
  onFeedback?: () => void;
  onReactionRecorded?: () => void;
  readingSession?: boolean;
}) {
  const reading = card.reading!;
  const article = useRef<HTMLElement>(null);
  const key = `${card.id}:${reading.contentRevision}`;
  const currentKey = useRef(key);
  currentKey.current = key;
  const requestRef = useRef<ReactionRequest | null>(null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [preferenceBusy, setPreferenceBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState("");
  const [posted, setPosted] = useState<{ key: string; value: ReactionValue } | null>(null);
  const recorded = reaction?.contentRevision === reading.contentRevision ? reaction.reaction : null;
  const selected = posted?.key === key ? posted.value : recorded;
  const workActive = card.status === "queued" || card.status === "working" || card.status === "approved_blocked";
  const comparison = group && group.cards.length > 1 && group.runId && group.topicKey ? group : undefined;
  const versionIndex = comparison?.cards.findIndex((version) => version.id === card.id) ?? 0;
  const disposition = card.status === "queued" ? "feedback queued" : card.status === "working" ? "feedback being reviewed" : readingSession ? "saved" : "archived in Tend";

  useEffect(() => {
    requestRef.current = null;
    setError("");
    setStale(false);
    setPosted(null);
  }, [key]);
  useEffect(() => setPosted(null), [reaction?.eventId]);

  const switchVersion = (direction: number, fromKeyboard = false) => {
    if (!comparison || preferenceBusy || busy || !onVersion) return;
    const index = (versionIndex + direction + comparison.cards.length) % comparison.cards.length;
    if (fromKeyboard) article.current?.dispatchEvent(new CustomEvent("reading-shortcut", { bubbles: true, detail: direction < 0 ? "previous_version" : "next_version" }));
    onVersion(comparison.cards[index].id);
  };
  useEffect(() => {
    if (!active || !comparison || !onVersion) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']")) return;
      event.preventDefault();
      switchVersion(event.key === "ArrowLeft" ? -1 : 1, event.isTrusted);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [active, comparison, versionIndex, preferenceBusy, busy, onVersion]);

  const send = async (value: ReactionValue) => {
    if (inFlight.current || stale || workActive) return;
    // An uncertain response can be retried with the same event ID, never recorded twice.
    const previous = requestRef.current;
    const request = previous?.contentRevision === reading.contentRevision && previous.reaction === value
      ? previous
      : { clientEventId: crypto.randomUUID(), contentRevision: reading.contentRevision, reaction: value };
    requestRef.current = request;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await post(`/api/feeds/${encodeURIComponent(card.feedId)}/cards/${encodeURIComponent(card.id)}/reaction`, request);
      if (currentKey.current !== key) return;
      requestRef.current = null;
      setPosted({ key, value });
      onReactionRecorded?.();
      onChanged();
    } catch (caught) {
      if (currentKey.current !== key) return;
      if (caught instanceof ApiError && caught.status === 409) {
        requestRef.current = null;
        const changed = caught.code === "stale_content" || caught.message === "stale_content";
        setStale(changed);
        setError(changed ? "This card changed. Refresh it before recording a reaction." : caught.message);
        onChanged();
      } else {
        setError(caught instanceof Error ? caught.message : "Your reaction could not be saved. Try again.");
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <article ref={article} className={`attention-card reading-card ${active ? "is-active" : ""}`} data-card-id={card.id} data-reading-group={comparison?.id} onClick={onActivate} onMouseEnter={onActivate} onFocusCapture={onActivate}>
      <div className="card-rule" />
      <header className="card-head">
        <span className="kind-dot" />
        <div>
          <div className="reading-card-meta">
            <div className="eyebrow">{card.eyebrow}</div>
            <div className="reading-meta-controls">
              {reading.reviewEdit && <span className="reading-edit-marker">Edited</span>}
              {comparison && <div className="reading-versions" role="group" aria-label="Compare versions">
                <button type="button" data-reading-interaction="previous_version" aria-label="Previous version" title="Previous version · ←" disabled={preferenceBusy || busy} onClick={(event) => { event.stopPropagation(); switchVersion(-1); }}>←</button>
                <span aria-live="polite" aria-atomic="true">Version {versionIndex + 1} of {comparison.cards.length}</span>
                <button type="button" data-reading-interaction="next_version" aria-label="Next version" title="Next version · →" disabled={preferenceBusy || busy} onClick={(event) => { event.stopPropagation(); switchVersion(1); }}>→</button>
              </div>}
              <ReadingIdentity key={key} reader={reading.writer} reviewEdit={reading.reviewEdit} />
            </div>
          </div>
          <h2>{card.title}</h2>
        </div>
      </header>
      <p className="why reading-face">{card.why}</p>
      <details className="reading-sources" key={key}>
        <summary>Sources</summary>
        <div className="blocks">
          {card.blocks.map((block) => block.type === "quote"
            ? <blockquote className="block block-quote" key={block.id}><p>{block.text}</p>{block.attribution && <cite>{block.attribution}</cite>}</blockquote>
            : <Block key={block.id} feedId={card.feedId} cardId={card.id} block={block.type === "editable_text" ? { ...block, type: "memo", text: block.value ?? block.text } : block} onChanged={onChanged} />)}
        </div>
        <a className="reading-run-link" href={`/feed/${encodeURIComponent(card.feedId)}/prompts#source-run-${encodeURIComponent(reading.runId)}`}>View this source run</a>
        <CardHistory card={card} />
      </details>
      <footer className="card-action reading-footer" aria-busy={busy}>
        <div className="reading-reaction-row">
          <div className="reading-reaction-state" role="status" aria-live="polite">
            {busy ? "Saving…" : selected === "like" ? `Liked · ${disposition}` : selected === "not_for_me" ? `Not for me · ${disposition}` : card.status === "done" ? readingSession ? "Reviewed · feedback welcome" : "Archived in Tend" : card.status === "queued" ? "Feedback queued" : card.status === "working" ? "Feedback being reviewed" : "What did you think?"}
          </div>
          <div className="action-buttons">
            {(["like", "not_for_me"] as const).map((value) => <button
              type="button"
              key={value}
              data-reading-interaction={value}
              className={`button ghost reading-reaction ${selected === value ? "selected" : ""}`}
              aria-pressed={selected === value}
              disabled={busy || preferenceBusy || stale || workActive}
              onClick={(event) => { event.stopPropagation(); void send(selected === value ? null : value); }}
            >{value === "like" ? "Like" : "Not for me"}</button>)}
            {onFeedback && !comparison && <button type="button" data-reading-interaction="feedback" className="button text" onClick={(event) => { event.stopPropagation(); onFeedback(); }}>Feedback</button>}
          </div>
        </div>
        {!selected && card.status !== "done" && <small className="reading-local-note">{comparison ? "Rates only this version. Other versions keep their own ratings." : readingSession ? "Ratings are optional. The card stays here so you can add feedback." : "Reactions move this card to Done in Tend. The source is unchanged."}</small>}
        {error && <div className="reading-error" role="alert"><span>{error}</span>{!stale && requestRef.current && <button type="button" className="button text" disabled={busy} onClick={(event) => { event.stopPropagation(); if (requestRef.current) void send(requestRef.current.reaction); }}>Retry</button>}{stale && <button type="button" className="button text" onClick={(event) => { event.stopPropagation(); onChanged(); }}>Refresh card</button>}</div>}
      </footer>
      {comparison && <ReadingPreferenceFooter group={comparison} card={card} preference={preference} reaction={reaction} onChanged={onChanged} onFeedback={onFeedback} onRecorded={onReactionRecorded} onBusy={setPreferenceBusy} disabled={busy} readingSession={readingSession} />}
    </article>
  );
}

export function CardView({
  card,
  queuedNote,
  active,
  onActivate,
  onChanged,
  onAction,
  onReturnToReview,
  queuedFor,
  readingReaction,
  onReadingFeedback,
  onReadingReaction,
  readingGroup,
  readingPreference,
  onReadingVersion,
  readingSession,
}: {
  card: Card;
  queuedNote?: WorkItemView;
  active: boolean;
  onActivate: () => void;
  onChanged: () => void;
  onAction: (action: CardAction) => void;
  onReturnToReview: () => void;
  queuedFor?: string;
  readingReaction?: ReadingReaction;
  onReadingFeedback?: () => void;
  onReadingReaction?: () => void;
  readingGroup?: ReadingCardGroup;
  readingPreference?: ReadingPreferenceState;
  onReadingVersion?: (cardId: string) => void;
  readingSession?: boolean;
}) {
  if (card.reading) return <ReadingCardView card={card} active={active} reaction={readingReaction} group={readingGroup} preference={readingPreference} onVersion={onReadingVersion} onActivate={onActivate} onChanged={onChanged} onFeedback={onReadingFeedback} onReactionRecorded={onReadingReaction} readingSession={readingSession} />;
  const actions = visibleCardActions(card);
  const nextThing = card.proposedAction?.label === "Decide disposition"
    ? "Dismiss, or tell Codex what to do"
    : card.proposedAction?.label ?? actions.find((action) => action.variant === "primary")?.label ?? actions[0]?.label;
  return (
    <article className={`attention-card ${card.contextInfluence ? "has-context-influence" : ""} ${active ? "is-active" : ""}`} data-card-id={card.id} onClick={onActivate} onMouseEnter={onActivate}>
      <div className="card-rule" />
      <header className="card-head">
        <span className={`kind-dot ${card.kind === "feed_improvement" ? "proposal" : ""}`} />
        <div>
          <div className="eyebrow">{card.eyebrow}</div>
          <h2>{card.title}</h2>
        </div>
      </header>
      <p className="why"><FormattedText text={card.why} /></p>
      <ContextInfluenceReceipt card={card} />
      <div className="blocks">
        {card.blocks.map((block) => <Block key={block.id} feedId={card.feedId} cardId={card.id} block={block} onChanged={onChanged} />)}
      </div>
      {queuedNote && <QueuedNoteEditor work={queuedNote} onChanged={onChanged} />}
      <CardHistory card={card} />
      {card.status === "approved_blocked" && (
        <footer className="card-action">
          <div>
            <span className="action-label">Already approved</span>
            <b>Waiting for Codex to retry</b>
            {card.sourceMailbox && <small className="reply-mailbox">Reply from {card.sourceMailbox}</small>}
          </div>
        </footer>
      )}
      {actions.length > 0 && (card.status === "to_review_new" || card.status === "to_review_updated") && (
        <footer className="card-action">
          <div>
            <span className="action-label">Next thing</span>
            {nextThing && <b>{nextThing}</b>}
            {card.sourceMailbox && <small className="reply-mailbox">Reply from {card.sourceMailbox}</small>}
          </div>
          <div className="action-buttons">
            {actions.map((action) => (
              <button
                aria-keyshortcuts={action.shortcut}
                aria-label={action.label}
                className={`button ${action.variant === "primary" ? "primary" : "ghost"}`}
                key={action.id}
                onPointerDown={(event) => event.preventDefault()}
                onClick={(event) => { event.stopPropagation(); onAction(action); }}
              >
                {action.label}{action.shortcut && <kbd aria-hidden="true">{action.shortcut.toUpperCase()}</kbd>}
              </button>
            ))}
          </div>
        </footer>
      )}
      {(card.status === "queued" || card.status === "done") && (
        <footer className="card-action">
          <div>
            <span className="action-label">{card.status === "queued" ? `Queued for ${queuedFor ?? "Codex"}` : "Done"}</span>
            <b>{card.status === "queued" ? `Waiting for ${queuedFor ?? "the feed thread"}` : card.completionDisposition === "dismissed" ? "Dismissed" : "Completed"}</b>
          </div>
          <div className="action-buttons">
            <button className="button ghost" onClick={(event) => { event.stopPropagation(); onReturnToReview(); }}>
              {card.status === "queued" ? "Move back to review" : "Review again"}
            </button>
          </div>
        </footer>
      )}
    </article>
  );
}
