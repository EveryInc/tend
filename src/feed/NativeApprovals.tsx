import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { NativeApprovalSubmission, NativeApprovalView } from "../../shared/nativeApproval";
import { api, post } from "../app/api";

export function NativeApprovals({ feedId }: { feedId: string }) {
  const path = `/api/feeds/${encodeURIComponent(feedId)}/native-approvals`;
  const query = useQuery({
    queryKey: ["native-approvals", feedId],
    queryFn: () => api<NativeApprovalView[]>(path),
    refetchInterval: 1_000,
    retry: false,
  });
  return <>
    {(query.data ?? []).map((view) => <NativeApprovalPrompt
      key={`${view.id}:${view.requestDigest}`}
      view={view}
      unavailable={query.isError}
      onRespond={async (input) => {
        try { await post(`${path}/${encodeURIComponent(view.id)}/respond`, input); }
        finally { await query.refetch(); }
      }}
    />)}
  </>;
}

export function NativeApprovalPrompt({ view, unavailable = false, onRespond }: {
  view: NativeApprovalView;
  unavailable?: boolean;
  onRespond: (input: NativeApprovalSubmission) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState("");
  const expired = Date.parse(view.expiresAt) <= Date.now();
  const disabled = pending || expired || unavailable;
  const complete = view.questions.every((question) => Object.hasOwn(answers, question.id));
  const respond = async (decision: NativeApprovalSubmission["decision"]) => {
    if (disabled) return;
    setPending(true);
    setError("");
    try {
      await onRespond({ requestDigest: view.requestDigest, decision, ...(decision === "respond" ? { answers } : {}) });
      setFinished(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The response could not be sent. Check the request before trying again.");
    } finally { setPending(false); }
  };
  if (finished) return <p role="status">Response recorded. Waiting for Codex to continue.</p>;
  return <section className="native-approval" aria-labelledby={`native-${view.id}`} onKeyDown={(event) => event.stopPropagation()}>
    <header>
      <div className="panel-kicker">Confirmation needed</div>
      <h2 id={`native-${view.id}`}>{view.actionLabel}</h2>
      <p>{view.cardTitle}</p>
    </header>
    <p>Codex is waiting for your answer before continuing this action. This answers the host's request, not a new Tend task.</p>
    <details className="native-approval-payload">
      <summary>Inspect exact request <code>{view.server} / {view.tool}</code></summary>
      <pre>{JSON.stringify(view.arguments, null, 2)}</pre>
    </details>
    <form onSubmit={(event) => { event.preventDefault(); if (complete) void respond("respond"); }}>
      {view.questions.map((question) => <fieldset key={question.id} disabled={disabled}>
        <legend>{question.question}</legend>
        {question.options.map((option) => <label className="native-approval-option" key={option.label}>
          <input type="radio" name={`${view.id}:${question.id}`} checked={answers[question.id] === option.label}
            onChange={() => setAnswers((current) => ({ ...current, [question.id]: option.label }))} />
          <span><strong>{option.label}</strong><small>{option.description}</small></span>
        </label>)}
      </fieldset>)}
      {(error || unavailable || expired) && <p className="native-approval-error" role="alert">
        {expired ? "This request expired. Codex needs a fresh confirmation before continuing."
          : unavailable ? "Connection lost. Responses are paused until Tend reconnects." : error}
      </p>}
      <footer>
        <span>Expires at <time dateTime={view.expiresAt}>{new Date(view.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time></span>
        <div className="action-buttons">
          <button className="button ghost large" type="button" disabled={disabled} onClick={() => void respond("cancel")}>Cancel request</button>
          <button className="button primary large" type="submit" disabled={disabled || !complete}>{pending ? "Sending..." : "Send confirmation"}</button>
        </div>
      </footer>
    </form>
  </section>;
}
