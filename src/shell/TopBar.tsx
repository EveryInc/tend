import { useEffect, useRef, useState } from "react";
import type { Inspector, WorkspaceTab } from "../app/types";
import type { WorkspaceView } from "../types";

export function TopBar({
  state,
  title = state.active.config.name,
  destination = "feed",
  onMind,
  onFeed,
  onInspector,
  onWorkspace,
}: {
  state: WorkspaceView;
  title?: string;
  destination?: "feed" | "mind";
  onMind: () => void;
  onFeed: (id: string) => void;
  onInspector?: (value: Inspector) => void;
  onWorkspace?: (tab?: WorkspaceTab) => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const claude = state.agents?.claude ?? { liveness: "offline" as const, lastSeenAt: null };
  const showClaudeChip = Boolean(state.agents?.claude?.lastSeenAt || state.agents?.claude?.sessionId || state.active.thread.agents?.claude);
  const claudeLabel = claude.label ? `Claude ${claude.liveness} · ${claude.label}` : `Claude ${claude.liveness}`;
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);
  return (
    <div className="feed-bar" ref={menuRef}>
      <button className="menu-trigger" onClick={() => setOpen(!open)} aria-label="Open feed navigation">☰</button>
      <strong>{title}</strong>
      {showClaudeChip && (
        <span className={`tend-agent-chip tend-agent-${claude.liveness}`} title={claude.lastSeenAt ? `Last seen ${claude.lastSeenAt}` : "No Claude presence yet"}>
          {claudeLabel}
        </span>
      )}
      {open && (
        <div className="feed-menu">
          <button className={destination === "mind" ? "selected" : ""} onClick={() => { onMind(); setOpen(false); }}>
            <span>On Your Mind</span><small>Current signals and their source observations</small>
          </button>
          <div className="menu-rule" />
          <div className="menu-title">Feeds</div>
          {state.feeds.map((feed) => (
            <button key={feed.id} className={destination === "feed" && feed.id === state.active.config.id ? "selected" : ""} onClick={() => { onFeed(feed.id); setOpen(false); }}>
              <span>{feed.name}</span><small>{feed.purpose}</small>
            </button>
          ))}
          {onInspector && onWorkspace && <>
            <div className="menu-rule" />
            <button onClick={() => { onInspector("new-feed"); setOpen(false); }}>＋ Create a feed</button>
            <button onClick={() => { onInspector("add-source"); setOpen(false); }}>＋ Add a source</button>
            <button onClick={() => { onWorkspace("feed"); setOpen(false); }}>⌘ Feed setup</button>
            <button onClick={() => { onWorkspace("global"); setOpen(false); }}>⌘ Global prompts</button>
          </>}
        </div>
      )}
    </div>
  );
}
