import { useId, useState } from "react";
import type { ReaderReceipt } from "../../shared/readers";
import type { Card } from "../types";

export function ReaderDetails({ reader }: { reader: ReaderReceipt }) {
  return (
    <dl className="reader-details">
      <dt>Reader</dt><dd>{reader.label}</dd>
      <dt>{reader.actualModel ? "Model used" : "Requested model"}</dt><dd>{reader.actualModel ?? reader.requestedModel}</dd>
      {reader.actualModel && reader.actualModel !== reader.requestedModel && <><dt>Requested model</dt><dd>{reader.requestedModel}</dd></>}
      <dt>{reader.actualEffort ? "Effort used" : "Requested effort"}</dt><dd>{reader.actualEffort ?? reader.requestedEffort}</dd>
      {reader.authentication && <><dt>Access</dt><dd>{reader.authentication === "claude_subscription" ? "Claude subscription" : "Codex login"}</dd></>}
    </dl>
  );
}

export function ReadingIdentity({ reader, reviewEdit }: {
  reader: ReaderReceipt;
  reviewEdit?: NonNullable<Card["reading"]>["reviewEdit"];
}) {
  const id = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const open = !dismissed && (hovered || focused || pinned);

  return (
    <div className="reading-identity"
      onMouseEnter={() => { setHovered(true); setDismissed(false); }}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => { setFocused(true); setDismissed(false); }}
      onBlurCapture={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setFocused(false); setPinned(false); setDismissed(false);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation(); setPinned(false); setDismissed(true);
      }}
    >
      <button type="button" data-reading-interaction="author_info" className="reading-info-button" aria-label="Author information" aria-expanded={open} aria-controls={id}
        onClick={(event) => { event.stopPropagation(); setPinned(!pinned); setDismissed(pinned); }}
      >
        <svg aria-hidden="true" viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.4" /><path d="M10 8.8v5M10 5.8v.3" /></svg>
      </button>
      {open && <div className="reading-identity-popover" role="group" aria-label="Author details" id={id}>
        <ReaderDetails reader={reader} />
        {reviewEdit && <p className="reading-review-edit">Edited by {reviewEdit.by}: {reviewEdit.note}</p>}
      </div>}
    </div>
  );
}
