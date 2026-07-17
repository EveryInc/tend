const countFormat = new Intl.NumberFormat();

export function ReviewReadyControl({ count, pending, onActivate }: { count: number; pending: boolean; onActivate: () => void }) {
  if (count <= 0) return null;
  const formatted = countFormat.format(count);
  const announcement = pending
    ? `Opening ${formatted} ${count === 1 ? "card" : "cards"}…`
    : `${formatted} updated ${count === 1 ? "card is" : "cards are"} ready for the next review pass.`;
  return (
    <div className="review-ready-control">
      <button
        type="button"
        className="review-ready-button"
        onClick={onActivate}
        disabled={pending}
        aria-busy={pending ? "true" : undefined}
        aria-label={`Review ready cards, ${formatted} ready`}
      >
        <svg className="review-ready-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="m12 2 10 5-10 5L2 7l10-5Z" />
          <path d="m2 12 10 5 10-5" />
          <path d="m2 17 10 5 10-5" />
        </svg>
        <span className="review-ready-label">Review ready cards</span>
        <span className="review-ready-count" aria-hidden="true">{formatted}</span>
      </button>
      <span className="visually-hidden" aria-live="polite">{announcement}</span>
    </div>
  );
}
