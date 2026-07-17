import { useRef, useState, type ReactNode } from "react";
import { usePushToTalk } from "../state/pushToTalk";
import { sameTarget } from "../state/voiceTarget";
import type { FeedView, VoiceTarget, WorkspaceView } from "../types";

function targetLabel(target: VoiceTarget, state: WorkspaceView): string {
  if (target.kind === "attention") return "Tend";
  if (target.kind === "feed") return state.feeds.find((feed) => feed.id === target.feedId)?.name ?? target.feedId;
  if (target.kind === "sweep") return "This sweep";
  if (target.kind === "card") return state.active.cards.find((card) => card.id === target.cardId)?.title ?? "Active card";
  if (target.kind === "source_recipe") return state.active.sources.find((source) => source.id === target.sourceId)?.name ?? target.sourceId;
  if (target.kind === "prompt_layer") return `Prompt layer · ${target.promptId}`;
  return `Global prompt · ${target.promptId}`;
}

function targetScopeTone(target: VoiceTarget): string {
  if (target.kind === "card") return "card";
  if (target.kind === "sweep") return "sweep";
  if (target.kind === "feed" || target.kind === "source_recipe" || target.kind === "prompt_layer") return "feed";
  return "attention";
}

export function Dock({
  state,
  feed,
  target,
  ladder,
  targetVersion,
  routeToClaude,
  canRouteToClaude,
  floatingAction,
  onTarget,
  onRouteToClaude,
  onSubmit,
  onRecollect,
}: {
  state: WorkspaceView;
  feed: FeedView;
  target: VoiceTarget;
  ladder: VoiceTarget[];
  targetVersion: number;
  routeToClaude: boolean;
  canRouteToClaude: boolean;
  floatingAction?: ReactNode;
  onTarget: (target: VoiceTarget) => void;
  onRouteToClaude: (enabled: boolean) => void;
  onSubmit: (instruction: string) => void;
  onRecollect: () => void;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const targetIndex = Math.max(0, ladder.findIndex((item) => sameTarget(item, target)));
  const zoom = (offset: number) => {
    const next = ladder[Math.max(0, Math.min(ladder.length - 1, targetIndex + offset))];
    if (next && !sameTarget(next, target)) onTarget(next);
  };
  const submit = () => {
    const instruction = inputRef.current?.value.trim();
    if (!instruction) return;
    onSubmit(instruction);
    setValue("");
  };
  const { isPushingToTalk } = usePushToTalk(inputRef, submit, state.dictation.activationCode);
  const scopeTone = targetScopeTone(target);
  const routedAgent = routeToClaude ? "Claude" : "Codex";
  const onDockKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
      return;
    }
    const arrow = event.key === "ArrowUp" || event.key === "ArrowDown";
    const unmodified = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
    if (!arrow || !unmodified || value.trim() || event.nativeEvent.isComposing) return;
    event.preventDefault();
    zoom(event.key === "ArrowUp" ? 1 : -1);
  };
  return (
    <div className="dock">
      {floatingAction && <div className="dock-floating-action dock-floating-action-right">{floatingAction}</div>}
      <form className={`dock-inner scope-${scopeTone}`} onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <div className="dock-context">
          {isPushingToTalk && <span className="listening-dot" />}
          <span>Talking to:</span>
          <b className="dock-target" key={targetVersion}>{targetLabel(target, state)}</b>
          {canRouteToClaude && (
            <button
              type="button"
              className={`agent-toggle ${routeToClaude ? "active" : ""}`}
              aria-pressed={routeToClaude ? "true" : "false"}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => onRouteToClaude(!routeToClaude)}
            >
              Claude
            </button>
          )}
          <div className="scope-buttons" aria-label="Change scope">
            <button type="button" aria-label="Broader scope" title="Broader scope" disabled={targetIndex >= ladder.length - 1} onPointerDown={(event) => event.preventDefault()} onClick={() => zoom(1)}><b>↑</b><span>Broader</span></button>
            <button type="button" aria-label="Narrower scope" title="Narrower scope" disabled={targetIndex <= 0} onPointerDown={(event) => event.preventDefault()} onClick={() => zoom(-1)}><b>↓</b><span>Narrower</span></button>
          </div>
        </div>
        <div className="dock-row">
          <textarea aria-label={`Instruction for ${routedAgent}`} ref={inputRef} value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={onDockKeyDown} rows={1} placeholder={`Tell ${routedAgent} what to notice, change, or do…`} />
          <button className="button primary" type="submit" disabled={!value.trim()}>Send</button>
        </div>
        <div className="dock-footer">
          <div className="dock-hints"><kbd>↑</kbd>/<kbd>↓</kbd> change scope when empty · hold <kbd>{state.dictation.activationLabel}</kbd> to dictate · <kbd>Enter</kbd> send</div>
          {feed.sweep.recollectionOffered && <div className="recollection-status"><span>{feed.sweep.statusMessage}</span><button type="button" onClick={onRecollect}>Search sources again</button></div>}
        </div>
      </form>
    </div>
  );
}
