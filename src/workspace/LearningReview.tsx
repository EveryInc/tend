import { useEffect, useState } from "react";
import type { FeedView, RevisionProposal } from "../types";

export function RevisionProposals({ proposals, onApply, onReject, onReviewLearning }: { proposals: RevisionProposal[]; onApply: (proposal: RevisionProposal) => void; onReject: (proposal: RevisionProposal) => void; onReviewLearning: () => void }) {
  if (!proposals.length) return null;
  return (
    <section className="proposal-stack">
      <div className="section-label">Waiting for approval <span>{proposals.length}</span></div>
      {proposals.map((proposal) => (
        <article className="revision-proposal" key={proposal.id}>
          <div className="panel-kicker">{proposal.label}</div>
          <h2>Proposed revision</h2>
          <p>{proposal.instruction}</p>
          <div className="proposal-diff">
            <div><span>Before</span><pre>{proposal.previous}</pre></div>
            <div><span>After</span><pre>{proposal.next}</pre></div>
          </div>
          <div className="proposal-actions">
            {proposal.source === "compound"
              ? <button className="button primary" onClick={onReviewLearning}>Review compounded learnings</button>
              : <button className="button primary" onClick={() => onApply(proposal)}>Apply revision</button>}
            <button className="button" onClick={() => onReject(proposal)}>Reject</button>
          </div>
        </article>
      ))}
    </section>
  );
}

export function LearningReview({ feed, proposals, onBack, onApply, onReject }: { feed: FeedView; proposals: RevisionProposal[]; onBack: () => void; onApply: (proposal: RevisionProposal, content: string) => void; onReject: (proposal: RevisionProposal) => void }) {
  const proposal = proposals.find((item) => item.source === "compound");
  const [value, setValue] = useState(proposal?.next ?? "");
  useEffect(() => setValue(proposal?.next ?? ""), [proposal?.id, proposal?.next]);
  if (!proposal) return (
    <main className="learning-page">
      <button className="workspace-back" onClick={onBack}>← Back to feed</button>
      <div className="learning-empty">
        <div className="panel-kicker">Learning pass</div>
        <h1>No learning proposal is waiting.</h1>
        <p>When you finish a sweep, Codex can ask whether you want to compound what it learned. If you say yes, the editable proposal will appear here before anything changes.</p>
      </div>
    </main>
  );
  return (
    <main className="learning-page">
      <button className="workspace-back" onClick={onBack}>← Back to feed</button>
      <div className="learning-title">
        <div className="panel-kicker">Learning pass · {feed.config.name}</div>
        <h1>Review what Codex learned.</h1>
        <p>Keep this compact. Edit the proposed feed policy directly, then apply it only when it captures the judgment you want to preserve.</p>
      </div>
      <section className="learning-review">
        <details>
          <summary>Current feed policy</summary>
          <pre>{proposal.previous}</pre>
        </details>
        <label htmlFor={`learning-${proposal.id}`}>Proposed feed policy</label>
        <textarea id={`learning-${proposal.id}`} value={value} onChange={(event) => setValue(event.target.value)} rows={Math.max(14, Math.min(30, value.split("\n").length + 3))} />
        <div className="learning-actions">
          <button className="button primary" disabled={!value.trim()} onClick={() => onApply(proposal, value)}>Apply learning</button>
          <button className="button ghost" onClick={() => onReject(proposal)}>Reject</button>
        </div>
      </section>
    </main>
  );
}
