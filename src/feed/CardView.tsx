import { useEffect, useState } from "react";
import { post } from "../app/api";
import type { Card, CardAction, CardBlock } from "../types";
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
        <textarea data-block-id={block.id} value={value} onChange={(event) => setValue(event.target.value)} onBlur={() => void save()} rows={Math.max(4, value.split("\n").length + 1)} />
      </section>
    );
  }
  if (block.type === "profile" && block.profile) {
    return (
      <section className="block block-profile">
        <a className="profile-portrait" href={block.profile.href} target="_blank" rel="noreferrer" aria-label={`Open ${block.profile.name} profile`}>
          <img
            src={block.profile.imageUrl}
            alt=""
            onError={(event) => {
              if (block.profile?.fallbackImageUrl && event.currentTarget.src !== block.profile.fallbackImageUrl) {
                event.currentTarget.src = block.profile.fallbackImageUrl;
              }
            }}
          />
        </a>
        <div className="profile-copy">
          <a className="profile-name" href={block.profile.href} target="_blank" rel="noreferrer">{block.profile.name}</a>
          {block.profile.subtitle && <span className="profile-subtitle">{block.profile.subtitle}</span>}
          {block.profile.links && (
            <div className="profile-links">
              {block.profile.links.map((link) => <a key={link.href} href={link.href} target="_blank" rel="noreferrer">{link.label}</a>)}
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
        <ul>{block.items?.map((item, index) => <li key={index}>{typeof item === "string" ? item : item.label}</li>)}</ul>
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
    return (
      <details className="block email-thread">
        <summary>Read full email <kbd>O</kbd></summary>
        <div className="email-thread-body"><FormattedText text={block.text} /></div>
      </details>
    );
  }
  return <section className={`block block-${block.type}`}>{block.label && <h3>{block.label}</h3>}<p><FormattedText text={block.text} /></p></section>;
}

export function CardView({
  card,
  active,
  onActivate,
  onChanged,
  onAction,
}: {
  card: Card;
  active: boolean;
  onActivate: () => void;
  onChanged: () => void;
  onAction: (action: CardAction) => void;
}) {
  const actions = visibleCardActions(card);
  const nextThing = card.proposedAction?.label === "Decide disposition"
    ? "Archive, or tell Codex what to do"
    : card.proposedAction?.label ?? actions.find((action) => action.variant === "primary")?.label ?? actions[0]?.label;
  return (
    <article className={`attention-card ${active ? "is-active" : ""}`} data-card-id={card.id} onClick={onActivate} onMouseEnter={onActivate}>
      <div className="card-rule" />
      <header className="card-head">
        <span className={`kind-dot ${card.kind === "feed_improvement" ? "proposal" : ""}`} />
        <div>
          <div className="eyebrow">{card.eyebrow}</div>
          <h2>{card.title}</h2>
        </div>
      </header>
      <p className="why"><FormattedText text={card.why} /></p>
      <div className="blocks">
        {card.blocks.map((block) => <Block key={block.id} feedId={card.feedId} cardId={card.id} block={block} onChanged={onChanged} />)}
      </div>
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
                className={`button ${action.variant === "primary" ? "primary" : "ghost"}`}
                key={action.id}
                onPointerDown={(event) => event.preventDefault()}
                onClick={(event) => { event.stopPropagation(); onAction(action); }}
              >
                {action.label}{action.shortcut && <kbd>{action.shortcut.toUpperCase()}</kbd>}
              </button>
            ))}
          </div>
        </footer>
      )}
    </article>
  );
}
