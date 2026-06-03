import { useEffect, useRef, useState } from "react";
import type { Inspector, WorkspaceTab } from "../app/types";
import type { WorkspaceView } from "../types";

export function TopBar({ state, onFeed, onInspector, onWorkspace }: { state: WorkspaceView; onFeed: (id: string) => void; onInspector: (value: Inspector) => void; onWorkspace: (tab?: WorkspaceTab) => void }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
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
      <strong>{state.active.config.name}</strong>
      {open && (
        <div className="feed-menu">
          <div className="menu-title">Feeds</div>
          {state.feeds.map((feed) => (
            <button key={feed.id} className={feed.id === state.active.config.id ? "selected" : ""} onClick={() => { onFeed(feed.id); setOpen(false); }}>
              <span>{feed.name}</span><small>{feed.purpose}</small>
            </button>
          ))}
          <div className="menu-rule" />
          <button onClick={() => { onInspector("new-feed"); setOpen(false); }}>＋ Create a feed</button>
          <button onClick={() => { onInspector("add-source"); setOpen(false); }}>＋ Add a source</button>
          <button onClick={() => { onWorkspace("feed"); setOpen(false); }}>⌘ Feed setup</button>
          <button onClick={() => { onWorkspace("global"); setOpen(false); }}>⌘ Global prompts</button>
        </div>
      )}
    </div>
  );
}
