import { useEffect, useState } from "react";
import { post } from "../app/api";
import type { Inspector } from "../app/types";
import type { WorkspaceView } from "../types";

export function InspectorPanel({ value, state, onClose, onChanged }: { value: Inspector; state: WorkspaceView; onClose: () => void; onChanged: (feed?: string) => void }) {
  const [text, setText] = useState("");
  const feedId = state.active.config.id;

  useEffect(() => {
    setText("");
  }, [value, feedId]);

  if (!value) return null;
  const create = value === "new-feed";
  const submit = async () => {
    if (!text.trim()) return;
    if (create) {
      const config = await post<any>("/api/feeds", { brief: text });
      onChanged(config.id);
    } else {
      await post(`/api/feeds/${feedId}/sources`, { brief: text });
      onChanged();
    }
    onClose();
  };
  return (
    <div className="overlay" onMouseDown={onClose}>
      <section className="inspector setup-panel" onMouseDown={(event) => event.stopPropagation()}>
        <button aria-label="Close setup panel" className="close" onClick={onClose}>×</button>
        <div className="panel-kicker">{create ? "New Tend feed" : "New source"}</div>
        <h2>{create ? "What should this feed notice?" : "What else should this feed pay attention to?"}</h2>
        <p>{create
          ? "Describe the outcome, sources, or decisions that matter. Tend will turn the brief into a local feed."
          : "Describe it naturally. Codex can refine the recipe with you in the feed thread."}</p>
        {create && <div className="setup-expectation">
          <strong>One feed, one Codex thread</strong>
          <span>Keep Tend open in Codex Desktop's in-app browser. After creation, connect one fresh Codex thread to operate this feed.</span>
        </div>}
        <textarea
          aria-label={create ? "Feed brief" : "Source brief"}
          autoFocus
          rows={8}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={create ? "Track the models I am actually using and show me meaningful changes in where each one is winning…" : "Also look at the product planning Slack channel and pull in decisions or unresolved questions that affect Q3…"}
        />
        <button className="button primary large" disabled={!text.trim()} onClick={() => void submit()}>{create ? "Create feed and continue" : "Add source"}</button>
      </section>
    </div>
  );
}
