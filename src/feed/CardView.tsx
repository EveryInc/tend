import { useEffect, useRef, useState } from "react";
import { containsFullEmail } from "../../shared/emailThread";
import { api, post } from "../app/api";
import type { Card, CardAction, CardBlock, WorkItemView } from "../types";
import { DetachedLink } from "../ui/DetachedLink";
import { FormattedText } from "../ui/FormattedText";
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

function Block({ feedId, cardId, block, onChanged }: { feedId: string; cardId: string; block: CardBlock; onChanged: () => void }) {
  const sourceSnapshotKey = block.sourceSnapshot
    ? `${block.sourceSnapshot.runId}:${block.sourceSnapshot.sourceId}:${block.sourceSnapshot.snapshotId}`
    : "";
  const [value, setValue] = useState(block.value ?? "");
  const [threadText, setThreadText] = useState(block.text ?? "");
  const [loadedSourceKey, setLoadedSourceKey] = useState("");
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState("");
  const currentSourceKey = useRef(sourceSnapshotKey);
  const threadRequest = useRef<AbortController | null>(null);
  useEffect(() => setValue(block.value ?? ""), [block.value]);
  useEffect(() => {
    currentSourceKey.current = sourceSnapshotKey;
    threadRequest.current?.abort();
    threadRequest.current = null;
    setThreadText(block.text ?? "");
    setLoadedSourceKey("");
    setThreadLoading(false);
    setThreadError("");
    return () => {
      currentSourceKey.current = "";
      threadRequest.current?.abort();
      threadRequest.current = null;
    };
  }, [block.text, sourceSnapshotKey]);

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
    const fullEmail = Boolean(block.sourceSnapshot) || containsFullEmail(threadText);
    const loadThread = async (open: boolean) => {
      const source = block.sourceSnapshot;
      if (!open || !source || loadedSourceKey === sourceSnapshotKey || threadLoading) return;
      setThreadLoading(true);
      setThreadError("");
      const requestedSourceKey = sourceSnapshotKey;
      const controller = new AbortController();
      threadRequest.current?.abort();
      threadRequest.current = controller;
      try {
        const result = await api<{ text: string }>(`/api/feeds/${encodeURIComponent(feedId)}/runs/${encodeURIComponent(source.runId)}/sources/${encodeURIComponent(source.sourceId)}/snapshots/${encodeURIComponent(source.snapshotId)}/thread`, { signal: controller.signal });
        if (currentSourceKey.current !== requestedSourceKey) return;
        setThreadText(result.text);
        setLoadedSourceKey(requestedSourceKey);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (currentSourceKey.current !== requestedSourceKey) return;
        setThreadError(error instanceof Error ? error.message : "Could not load the email thread.");
      } finally {
        if (threadRequest.current === controller) threadRequest.current = null;
        if (!controller.signal.aborted && currentSourceKey.current === requestedSourceKey) setThreadLoading(false);
      }
    };
    return (
      <details key={sourceSnapshotKey} className="block email-thread" onToggle={(event) => void loadThread(event.currentTarget.open)}>
        <summary>{fullEmail ? "Read full email" : "Email details"} <kbd>O</kbd></summary>
        <div className="email-thread-body">
          {threadLoading ? "Loading email thread…" : threadError || <FormattedText text={threadText} />}
        </div>
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

export function CardView({
  card,
  queuedNote,
  active,
  onActivate,
  onChanged,
  onAction,
  onReturnToReview,
  queuedFor,
}: {
  card: Card;
  queuedNote?: WorkItemView;
  active: boolean;
  onActivate: () => void;
  onChanged: () => void;
  onAction: (action: CardAction) => void;
  onReturnToReview: () => void;
  queuedFor?: string;
}) {
  const actions = visibleCardActions(card);
  const nextThing = card.proposedAction?.label === "Decide disposition"
    ? "Archive, or tell Codex what to do"
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
            <b>{card.status === "queued" ? `Waiting for ${queuedFor ?? "the feed thread"}` : "Completed"}</b>
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
