import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { Card, CardAction, CardBlock, FeedView, RevisionProposal, RoutineActionGroup, VoiceTarget, WorkspaceRevision, WorkspaceView } from "./types";
import { useActiveCard } from "./state/activeCard";
import { usePushToTalk } from "./state/pushToTalk";
import { useFeedRealtime, type ConnectionState } from "./state/realtime";
import { preferredTarget, sameTarget } from "./state/voiceTarget";

type Tab = "review" | "queued" | "working" | "done";
type Inspector = "new-feed" | "add-source" | null;
type WorkspaceTab = "feed" | "global";
export type AuthSession = { user: { id: string; email: string; name?: string | null }; session: unknown };
type OAuthConsentResponse = { redirect?: boolean; url?: string; redirect_uri?: string };
export type AttentionRouteScreen = "feed" | "workspace" | "agents" | "learnings";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init });
  const value = await response.json() as { error?: string };
  if (!response.ok) throw new Error(value.error ?? `Request failed: ${response.status}`);
  return value as T;
}

function post<T>(url: string, value: unknown = {}): Promise<T> {
  return api<T>(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
}

async function authRequest<T>(path: string, value?: unknown): Promise<T> {
  const response = await fetch(`/api/auth${path}`, {
    method: value === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: value === undefined ? undefined : { "content-type": "application/json" },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) as { message?: string; error?: { message?: string } } : null;
  if (!response.ok) throw new Error(body?.error?.message ?? body?.message ?? `Auth request failed: ${response.status}`);
  return body as T;
}

export function getAuthSession(): Promise<AuthSession | null> {
  return authRequest<AuthSession | null>("/get-session");
}

function isOAuthSignInPage() {
  const params = new URLSearchParams(location.search);
  return location.pathname === "/sign-in" && params.has("client_id") && params.has("response_type");
}

function resumeOAuthAuthorize() {
  location.assign(`/api/auth/oauth2/authorize${location.search}`);
}

function targetLabel(target: VoiceTarget, state: WorkspaceView): string {
  if (target.kind === "attention") return "Attention";
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

function decodeTextEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, "\u00a0")
    .replace(/&amp;/g, "&");
}

function FormattedText({ text = "" }: { text?: string }) {
  const decoded = decodeTextEntities(text);
  const parts = decoded.split(/(\[[^\]]+\]\((?:https?:\/\/|\/api\/artifacts\/)[^)]+\)|https?:\/\/[^\s<]+|`[^`]+`|\n)/g);
  return (
    <>
      {parts.map((part, index) => {
        const link = part.match(/^\[([^\]]+)\]\(((?:https?:\/\/|\/api\/artifacts\/)[^)]+)\)$/);
        if (link) return <a key={index} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>;
        if (part === "\n") return <br key={index} />;
        if (/^https?:\/\//.test(part)) return <a key={index} href={part} target="_blank" rel="noreferrer">{part}</a>;
        if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
        return part;
      })}
    </>
  );
}

function visibleCards(feed: FeedView, tab: Tab): Card[] {
  const pass = feed.config.currentPass;
  if (tab === "review") {
    return feed.cards
      .filter((card) => (card.status === "to_review_new" || card.status === "to_review_updated") && card.readyForPass <= pass && !card.sweep?.hidden && !card.routineActionGroupId)
      .sort((left, right) => {
        if (left.sweep?.rank !== undefined || right.sweep?.rank !== undefined) return (left.sweep?.rank ?? Number.MAX_SAFE_INTEGER) - (right.sweep?.rank ?? Number.MAX_SAFE_INTEGER);
        if (left.status !== right.status) return left.status === "to_review_updated" ? -1 : 1;
        return (right.completedAt ?? right.updatedAt).localeCompare(left.completedAt ?? left.updatedAt);
      });
  }
  if (tab === "queued") return feed.cards.filter((card) => (card.status === "queued" || card.status === "approved_blocked") && !card.routineActionGroupId);
  if (tab === "working") return feed.cards.filter((card) => card.status === "working" && !card.routineActionGroupId);
  return feed.cards.filter((card) => card.status === "done" && !card.routineActionGroupId);
}

function visibleRoutineActions(feed: FeedView, tab: Tab): RoutineActionGroup[] {
  const status = tab === "review" ? "proposed" : tab === "done" ? "completed" : tab;
  return feed.routineActions.filter((group) => group.status === status);
}

function countFor(feed: FeedView, tab: Tab): number {
  const feedWork = tab === "queued" || tab === "working"
    ? feed.work.filter((work) => work.cardId === "__feed__" && work.status === tab).length
    : 0;
  return visibleCards(feed, tab).length + visibleRoutineActions(feed, tab).length + feedWork;
}

function visibleCardActions(card: Card): CardAction[] {
  if (card.actions?.length) return card.actions;
  const archive: CardAction = { id: "default-cleanup", label: "Archive", behavior: "default_cleanup", variant: "secondary", shortcut: "x" };
  if (!card.proposedAction || card.proposedAction.label === "Decide disposition") return [archive];
  if (card.proposedAction.label === "Archive" || card.proposedAction.label === "Archive this thread") {
    return [{ ...archive, variant: "primary" }];
  }
  return [
    archive,
    {
      id: "proposed-action",
      label: card.proposedAction.label,
      behavior: "approve_action",
      instruction: card.proposedAction.instruction,
      artifactBlockId: card.proposedAction.artifactBlockId,
      externalMutation: card.proposedAction.externalMutation,
      mailboxPolicy: card.proposedAction.mailboxPolicy,
      variant: "primary",
      shortcut: "a",
    },
  ];
}

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

function CardView({
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
  const blocks = Array.isArray(card.blocks) ? card.blocks : [];
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
        {blocks.map((block) => <Block key={block.id} feedId={card.feedId} cardId={card.id} block={block} onChanged={onChanged} />)}
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

function RoutineActionGroupView({ group, onApprove }: { group: RoutineActionGroup; onApprove: () => void }) {
  return (
    <article className={`routine-group routine-${group.status}`}>
      <header className="routine-group-head">
        <div>
          <div className="panel-kicker">{group.status === "proposed" ? "Suggested routine action" : `Routine action · ${group.status}`}</div>
          <h2>{group.label}</h2>
          <p>{group.summary}</p>
        </div>
        {group.status === "proposed" && <button className="button primary" onClick={onApprove}>{group.proposedAction.label}</button>}
      </header>
      <details>
        <summary>{group.items.length} item{group.items.length === 1 ? "" : "s"} <span>{group.status === "proposed" ? "Review before approving" : "Show details"}</span></summary>
        <ul className="routine-items">
          {group.items.map((item) => (
            <li key={item.id}>
              <div>
                <b>{item.title}</b>
                {item.detail && <span>{item.detail}</span>}
                <small>{item.reason}</small>
              </div>
              {item.sourceRefs?.map((ref) => <a key={ref.href} href={ref.href} target="_blank" rel="noreferrer">{ref.label}</a>)}
            </li>
          ))}
        </ul>
      </details>
      {group.error && <p className="routine-error">{group.error}</p>}
    </article>
  );
}

function connectionLabel(state: ConnectionState) {
  if (state === "live") return "Live";
  if (state === "reconnecting") return "Reconnecting";
  if (state === "offline") return "Offline";
  return "Connecting";
}

function TopBar({
  state,
  user,
  onFeed,
  onInspector,
  onWorkspace,
  onAgents,
  onSignOut,
}: {
  state: WorkspaceView;
  user: AuthSession["user"];
  onFeed: (id: string) => void;
  onInspector: (value: Inspector) => void;
  onWorkspace: (tab?: WorkspaceTab) => void;
  onAgents: () => void;
  onSignOut: () => void;
}) {
  const { state: connectionState } = useFeedRealtime();
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
    <>
      <div className="feed-bar" ref={menuRef}>
        <button className="menu-trigger" onClick={() => setOpen(!open)} aria-label="Open feed navigation">☰</button>
        <div className="feed-title">
          <strong>{state.active.config.name}</strong>
          <span className={`connection-indicator ${connectionState}`} title={`Realtime connection: ${connectionLabel(connectionState)}`} aria-label={`Realtime connection: ${connectionLabel(connectionState)}`}>
            <span />
            {connectionLabel(connectionState)}
          </span>
        </div>
        <div className="feed-auth"><span>{user.email}</span><button onClick={onSignOut}>Sign out</button></div>
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
            <button onClick={() => { onAgents(); setOpen(false); }}>⌘ Connect your agent</button>
          </div>
        )}
      </div>
    </>
  );
}

function CopyButton({ value, onCopied }: { value: string; onCopied: () => void }) {
  const copy = async () => {
    await navigator.clipboard?.writeText(value);
    onCopied();
  };
  return <button className="button ghost" onClick={() => void copy()}>Copy</button>;
}

function AgentSetupPage({ state, onBack, onCopied }: { state: WorkspaceView; onBack: () => void; onCopied: () => void }) {
  const origin = location.origin;
  const mcpUrl = `${origin}/mcp`;
  const skillUrl = `${origin}/attention-agent/SKILL.md`;
  const setupPrompt = `Connect this Codex Desktop thread to Hosted Attention.

MCP server: ${mcpUrl}
Skill: ${skillUrl}
Feed: ${state.active.config.id}

After connecting, read the skill, inspect the feed, and bind this local thread as the feed home thread with bind_feed_thread.

Create or update one heartbeat automation on this same thread. On each wakeup it should inspect the feed, list queued work first, claim before using local connectors for queued instructions, execute and complete/fail each claim through Attention MCP, include done: true when closing/ignoring/already-handled cards, then refresh configured sources opportunistically only when no queued work is being handled. Use run_feed for the work-drain phase.`;

  return (
    <main className="workspace-page agents-page">
      <button className="workspace-back" onClick={onBack}>← Back to feed</button>
      <div className="workspace-title">
        <div>
          <div className="panel-kicker">Agents</div>
          <h1>Connect your agent</h1>
        </div>
        <a className="button ghost link-button" href={skillUrl} target="_blank" rel="noreferrer">Open SKILL.md</a>
      </div>
      <div className="agent-grid">
        <section className="agent-panel">
          <div className="workspace-editor-head">
            <h2>MCP server</h2>
            <CopyButton value={mcpUrl} onCopied={onCopied} />
          </div>
          <p>Use this endpoint when adding the hosted Attention MCP server to your local Codex Desktop thread.</p>
          <code className="copy-block">{mcpUrl}</code>
        </section>
        <section className="agent-panel">
          <div className="workspace-editor-head">
            <h2>Skill file</h2>
            <CopyButton value={skillUrl} onCopied={onCopied} />
          </div>
          <p>Install or reference this skill so the local thread knows feed ownership and work-drain rules.</p>
          <code className="copy-block">{skillUrl}</code>
        </section>
      </div>
      <section className="workspace-section">
        <div className="workspace-section-head">
          <h2>Setup prompt</h2>
          <CopyButton value={setupPrompt} onCopied={onCopied} />
        </div>
        <textarea className="setup-prompt" readOnly value={setupPrompt} rows={9} />
      </section>
    </main>
  );
}

function AuthScreen({ onAuthenticated }: { onAuthenticated: (session: AuthSession) => void }) {
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "sign-up") {
        await authRequest("/sign-up/email", { name: name.trim() || email, email, password });
      } else {
        await authRequest("/sign-in/email", { email, password });
      }
      const session = await getAuthSession();
      if (!session) throw new Error("Session was not created.");
      if (isOAuthSignInPage()) {
        resumeOAuthAuthorize();
        return;
      }
      onAuthenticated(session);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-page">
      <form className="auth-panel" onSubmit={submit}>
        <div className="panel-kicker">Hosted Attention</div>
        <h1>{mode === "sign-in" ? "Sign in" : "Create account"}</h1>
        {mode === "sign-up" && <label>Name<input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" /></label>}
        <label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></label>
        <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === "sign-in" ? "current-password" : "new-password"} required /></label>
        {error && <p className="auth-error">{error}</p>}
        <button className="button primary large" type="submit" disabled={busy}>{busy ? "Working..." : mode === "sign-in" ? "Sign in" : "Sign up"}</button>
        <button className="auth-switch" type="button" onClick={() => { setMode(mode === "sign-in" ? "sign-up" : "sign-in"); setError(""); }}>
          {mode === "sign-in" ? "Need an account? Sign up" : "Already have an account? Sign in"}
        </button>
      </form>
    </main>
  );
}

function OAuthConsentScreen({ user }: { user: AuthSession["user"] }) {
  const [busy, setBusy] = useState<"accept" | "deny" | null>(null);
  const [error, setError] = useState("");
  const params = new URLSearchParams(location.search);
  const scopes = (params.get("scope") ?? "").split(/\s+/).filter(Boolean);

  const submit = async (accept: boolean) => {
    setBusy(accept ? "accept" : "deny");
    setError("");
    try {
      const response = await authRequest<OAuthConsentResponse>("/oauth2/consent", {
        accept,
        oauth_query: location.search.slice(1),
      });
      const nextUrl = response.url ?? response.redirect_uri;
      if (!nextUrl) throw new Error("Consent did not return a redirect URL.");
      location.assign(nextUrl);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(null);
    }
  };

  return (
    <main className="auth-page">
      <section className="auth-panel">
        <div className="panel-kicker">Hosted Attention</div>
        <h1>Connect agent</h1>
        <p className="auth-note">{user.email} is granting Codex access to the Attention MCP server.</p>
        <div className="scope-list">
          {scopes.map((scope) => <span key={scope}>{scope}</span>)}
        </div>
        {error && <p className="auth-error">{error}</p>}
        <button className="button primary large" type="button" disabled={busy !== null} onClick={() => void submit(true)}>
          {busy === "accept" ? "Connecting..." : "Allow"}
        </button>
        <button className="auth-switch" type="button" disabled={busy !== null} onClick={() => void submit(false)}>
          Deny
        </button>
      </section>
    </main>
  );
}

export function SignInPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const authQuery = useQuery({ queryKey: ["auth-session"], queryFn: getAuthSession });
  useEffect(() => {
    if (authQuery.data && isOAuthSignInPage()) resumeOAuthAuthorize();
  }, [authQuery.data]);
  if (authQuery.isPending) return <main className="loading">Loading attention…</main>;
  if (authQuery.data && isOAuthSignInPage()) return <main className="loading">Continuing OAuth…</main>;
  if (authQuery.data) {
    void navigate({ to: "/feed/$feedId", params: { feedId: "inbox" } });
    return <main className="loading">Loading attention…</main>;
  }
  return (
    <AuthScreen
      onAuthenticated={(session) => {
        queryClient.setQueryData(["auth-session"], session);
        if (!isOAuthSignInPage()) void navigate({ to: "/feed/$feedId", params: { feedId: "inbox" } });
      }}
    />
  );
}

export function OAuthConsentPage() {
  const queryClient = useQueryClient();
  const authQuery = useQuery({ queryKey: ["auth-session"], queryFn: getAuthSession });
  const auth = authQuery.isPending ? undefined : authQuery.data ?? null;
  if (auth === undefined) return <main className="loading">Loading attention…</main>;
  if (auth === null) return <AuthScreen onAuthenticated={(session) => queryClient.setQueryData(["auth-session"], session)} />;
  return <OAuthConsentScreen user={auth.user} />;
}

function WorkspaceEditor({
  label,
  content,
  onFocus,
  onSave,
  onUndo,
}: {
  label: string;
  content: string;
  onFocus: () => void;
  onSave: (content: string) => Promise<WorkspaceRevision>;
  onUndo: (revisionId: string) => Promise<unknown>;
}) {
  const [value, setValue] = useState(content);
  const [saving, setSaving] = useState(false);
  const [undoRevision, setUndoRevision] = useState<string | null>(null);
  useEffect(() => setValue(content), [content]);
  const changed = value.trimEnd() !== content.trimEnd();
  return (
    <section className="workspace-editor">
      <div className="workspace-editor-head">
        <h3>{label}</h3>
        <div className="workspace-editor-actions">
          {undoRevision && <button className="button text" onClick={() => void (async () => {
            setSaving(true);
            try {
              await onUndo(undoRevision);
              setUndoRevision(null);
            } catch {
              // The workspace surfaces the API error in its toast.
            } finally {
              setSaving(false);
            }
          })()}>Undo last save</button>}
          <button className="button ghost" disabled={!changed || saving} onClick={() => void (async () => {
            setSaving(true);
            try {
              const revision = await onSave(value);
              setUndoRevision(revision.id);
            } catch {
              // The workspace surfaces the API error in its toast.
            } finally {
              setSaving(false);
            }
          })()}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
      <textarea value={value} onFocus={onFocus} onClick={onFocus} onChange={(event) => setValue(event.target.value)} rows={Math.max(7, Math.min(20, value.split("\n").length + 2))} />
    </section>
  );
}

function PromptWorkspace({ state, tab, onTab, onBack, onInspector, onSaved, onTargetFocus }: { state: WorkspaceView; tab: WorkspaceTab; onTab: (tab: WorkspaceTab) => void; onBack: () => void; onInspector: (value: Inspector) => void; onSaved: (message: string) => void; onTargetFocus: (target: VoiceTarget) => void }) {
  const [feedWorkspace, setFeedWorkspace] = useState<any>(null);
  const [globalWorkspace, setGlobalWorkspace] = useState<any>(null);
  const feedId = state.active.config.id;
  const reloadFeed = useCallback(async () => setFeedWorkspace(await api(`/api/feeds/${feedId}/how`)), [feedId]);
  const reloadGlobal = useCallback(async () => setGlobalWorkspace(await api("/api/global-prompts")), []);
  useEffect(() => { void reloadFeed(); }, [reloadFeed]);
  useEffect(() => { if (tab === "global") void reloadGlobal(); }, [reloadGlobal, tab]);
  const save = async <T,>(callback: () => Promise<T>, message: string, reload: () => Promise<void>): Promise<T> => {
    try {
      const result = await callback();
      await reload();
      onSaved(message);
      return result;
    } catch (error) {
      onSaved(error instanceof Error ? error.message : String(error));
      throw error;
    }
  };
  return (
    <main className="workspace-page">
      <button className="workspace-back" onClick={onBack}>← Back to feed</button>
      <div className="workspace-title">
        <div>
          <div className="panel-kicker">Prompts & sources</div>
          <h1>{tab === "feed" ? `${state.active.config.name} setup` : "Global prompts"}</h1>
        </div>
        {tab === "feed" && <button className="button ghost" onClick={() => onInspector("add-source")}>＋ Add a source</button>}
      </div>
      <nav className="workspace-tabs">
        <button className={tab === "feed" ? "active" : ""} onClick={() => onTab("feed")}>This feed</button>
        <button className={tab === "global" ? "active" : ""} onClick={() => onTab("global")}>Global prompts</button>
      </nav>
      {tab === "feed" ? !feedWorkspace ? <p>Loading feed setup…</p> : (
        <div className="workspace-stack">
          <WorkspaceEditor label="Feed policy" content={feedWorkspace.policy} onFocus={() => onTargetFocus({ kind: "feed", feedId })} onSave={(content) => save(() => post(`/api/feeds/${feedId}/policy`, { content }), "Feed policy saved", reloadFeed)} onUndo={(revisionId) => save(() => post(`/api/revisions/${revisionId}/revert`), "Feed policy restored", reloadFeed)} />
          <section className="workspace-section">
            <div className="workspace-section-head"><h2>Source recipes</h2><span>{feedWorkspace.sources.length}</span></div>
            {feedWorkspace.sources.map((source: any) => <WorkspaceEditor key={source.id} label={source.name} content={source.content} onFocus={() => onTargetFocus({ kind: "source_recipe", feedId, sourceId: source.id })} onSave={(content) => save(() => post(`/api/feeds/${feedId}/sources/${encodeURIComponent(source.id)}`, { content }), "Source recipe saved", reloadFeed)} onUndo={(revisionId) => save(() => post(`/api/revisions/${revisionId}/revert`), "Source recipe restored", reloadFeed)} />)}
          </section>
          <section className="workspace-section">
            <div className="workspace-section-head"><h2>Prompt layers</h2><span>{feedWorkspace.prompts.length}</span></div>
            {feedWorkspace.prompts.map((prompt: any) => <WorkspaceEditor key={prompt.name} label={prompt.name} content={prompt.content} onFocus={() => onTargetFocus({ kind: "prompt_layer", feedId, promptId: prompt.name })} onSave={(content) => save(() => post(`/api/feeds/${feedId}/prompts/${encodeURIComponent(prompt.name)}`, { content }), "Feed prompt saved", reloadFeed)} onUndo={(revisionId) => save(() => post(`/api/revisions/${revisionId}/revert`), "Feed prompt restored", reloadFeed)} />)}
          </section>
          <section className="workspace-section">
            <h2>Home thread</h2>
            <pre>{JSON.stringify(feedWorkspace.thread, null, 2)}</pre>
          </section>
        </div>
      ) : !globalWorkspace ? <p>Loading global prompts…</p> : (
        <div className="workspace-stack">
          <WorkspaceEditor label="Global policy" content={globalWorkspace.globalPolicy} onFocus={() => onTargetFocus({ kind: "attention" })} onSave={(content) => save(() => post("/api/global-policy", { feedId, content }), "Global policy saved", reloadGlobal)} onUndo={(revisionId) => save(() => post(`/api/revisions/${revisionId}/revert`), "Global policy restored", reloadGlobal)} />
          <section className="workspace-section">
            <div className="workspace-section-head"><h2>Prompt layers</h2><span>{globalWorkspace.prompts.length}</span></div>
            {globalWorkspace.prompts.map((prompt: any) => <WorkspaceEditor key={prompt.name} label={prompt.name} content={prompt.content} onFocus={() => onTargetFocus({ kind: "global_prompt", promptId: prompt.name })} onSave={(content) => save(() => post(`/api/global-prompts/${encodeURIComponent(prompt.name)}`, { feedId, content }), "Global prompt saved", reloadGlobal)} onUndo={(revisionId) => save(() => post(`/api/revisions/${revisionId}/revert`), "Global prompt restored", reloadGlobal)} />)}
          </section>
        </div>
      )}
    </main>
  );
}

function InspectorPanel({ value, state, onClose, onChanged }: { value: Inspector; state: WorkspaceView; onClose: () => void; onChanged: (feed?: string) => void }) {
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
        <button className="close" onClick={onClose}>×</button>
        <div className="panel-kicker">{create ? "New feed" : "New source"}</div>
        <h2>{create ? "What should this feed notice?" : "What else should this feed pay attention to?"}</h2>
        <p>Describe it naturally. Codex can refine the recipe with you in the feed thread.</p>
        <textarea autoFocus rows={8} value={text} onChange={(event) => setText(event.target.value)} placeholder={create ? "Track the models I am actually using and show me meaningful changes in where each one is winning…" : "Also look at the product planning Slack channel and pull in decisions or unresolved questions that affect Q3…"} />
        <button className="button primary large" onClick={() => void submit()}>{create ? "Create feed" : "Add source"}</button>
      </section>
    </div>
  );
}

function RevisionProposals({ proposals, onApply, onReject, onReviewLearning }: { proposals: RevisionProposal[]; onApply: (proposal: RevisionProposal) => void; onReject: (proposal: RevisionProposal) => void; onReviewLearning: () => void }) {
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

function LearningReview({ feed, proposals, onBack, onApply, onReject }: { feed: FeedView; proposals: RevisionProposal[]; onBack: () => void; onApply: (proposal: RevisionProposal, content: string) => void; onReject: (proposal: RevisionProposal) => void }) {
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

function Dock({
  state,
  feed,
  target,
  ladder,
  targetVersion,
  onTarget,
  onSubmit,
  onRecollect,
}: {
  state: WorkspaceView;
  feed: FeedView;
  target: VoiceTarget;
  ladder: VoiceTarget[];
  targetVersion: number;
  onTarget: (target: VoiceTarget) => void;
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
      <form className={`dock-inner scope-${scopeTone}`} onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <div className="dock-context">
          {isPushingToTalk && <span className="listening-dot" />}
          <span>Talking to:</span>
          <b className="dock-target" key={targetVersion}>{targetLabel(target, state)}</b>
          <div className="scope-buttons" aria-label="Change scope">
            <button type="button" aria-label="Broader scope" title="Broader scope" disabled={targetIndex >= ladder.length - 1} onPointerDown={(event) => event.preventDefault()} onClick={() => zoom(1)}><b>↑</b><span>Broader</span></button>
            <button type="button" aria-label="Narrower scope" title="Narrower scope" disabled={targetIndex <= 0} onPointerDown={(event) => event.preventDefault()} onClick={() => zoom(-1)}><b>↓</b><span>Narrower</span></button>
          </div>
        </div>
        <div className="dock-row">
          <textarea ref={inputRef} value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={onDockKeyDown} rows={1} placeholder="Tell Codex what to notice, change, or do…" />
          <button className="button primary" type="submit">Send</button>
        </div>
        <div className="dock-footer">
          <div className="dock-hints"><kbd>↑</kbd>/<kbd>↓</kbd> change scope when empty · hold <kbd>{state.dictation.activationLabel}</kbd> to dictate · <kbd>Enter</kbd> send</div>
          {feed.sweep.recollectionOffered && <div className="recollection-status"><span>{feed.sweep.statusMessage}</span><button type="button" onClick={onRecollect}>Search sources again</button></div>}
        </div>
      </form>
    </div>
  );
}

export default function App({ feedId, screen, workspaceTab = "feed" }: { feedId: string; screen: AttentionRouteScreen; workspaceTab?: WorkspaceTab }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const authQuery = useQuery({ queryKey: ["auth-session"], queryFn: getAuthSession });
  const auth = authQuery.isPending ? undefined : authQuery.data ?? null;
  const stateQuery = useQuery({
    queryKey: ["workspace", feedId],
    queryFn: () => api<WorkspaceView>(`/api/state?feed=${encodeURIComponent(feedId)}`),
    enabled: !!auth,
  });
  const state = stateQuery.data ?? null;
  const [tab, setTab] = useState<Tab>("review");
  const [inspector, setInspector] = useState<Inspector>(null);
  const [toast, setToast] = useState("");
  const [undoCleanup, setUndoCleanup] = useState<{ feedId: string; cardId: string } | null>(null);
  const [undoQueuedWork, setUndoQueuedWork] = useState<{ feedId: string; workId: string } | null>(null);
  const [undoRevision, setUndoRevision] = useState<string | null>(null);
  const [workspaceFocus, setWorkspaceFocus] = useState<VoiceTarget | null>(null);
  const [dockTarget, setDockTarget] = useState<VoiceTarget | null>(() => {
    try {
      return JSON.parse(sessionStorage.getItem("attention.voiceTarget") ?? "null") as VoiceTarget | null;
    } catch {
      return null;
    }
  });
  const [targetVersion, setTargetVersion] = useState(0);
  const pageRef = useRef<HTMLElement>(null);
  const dockTargetRef = useRef<VoiceTarget | null>(dockTarget);
  const dockContextRef = useRef("");
  const dockScopeExplicitlyChangedRef = useRef(false);
  const toastTimerRef = useRef<number | null>(null);
  const knownCompoundProposalIdsRef = useRef(new Map<string, Set<string>>());

  const refresh = useCallback(async (nextFeed = feedId) => {
    await queryClient.invalidateQueries({ queryKey: ["workspace", nextFeed] });
  }, [feedId, queryClient]);

  useEffect(() => {
    if (!auth || !state) return;
    for (const feed of state.feeds) {
      if (feed.id === feedId) continue;
      void queryClient.prefetchQuery({
        queryKey: ["workspace", feed.id],
        queryFn: () => api<WorkspaceView>(`/api/state?feed=${encodeURIComponent(feed.id)}`),
      });
    }
  }, [auth, feedId, queryClient, state]);

  const feed = state?.active;
  const cards = useMemo(() => feed ? visibleCards(feed, tab) : [], [feed, tab]);
  const routineActions = useMemo(() => feed ? visibleRoutineActions(feed, tab) : [], [feed, tab]);
  const cardIds = useMemo(() => cards.map((card) => card.id), [cards]);
  const { activeCardId, setActiveCardId, navTo } = useActiveCard(pageRef, cardIds);
  const activeCard = cards.find((card) => card.id === activeCardId) ?? cards[0];
  const ladder = useMemo<VoiceTarget[]>(() => {
    if (!feed) return [{ kind: "attention" }];
    if (screen === "feed") return [
      ...(activeCard ? [{ kind: "card" as const, feedId: feed.config.id, cardId: activeCard.id }] : []),
      { kind: "sweep", feedId: feed.config.id, ...(feed.sweep.currentBatchId ? { batchId: feed.sweep.currentBatchId } : {}) },
      { kind: "feed", feedId: feed.config.id },
      { kind: "attention" },
    ];
    if (workspaceTab === "global") return workspaceFocus?.kind === "global_prompt"
      ? [workspaceFocus, { kind: "attention" }]
      : [{ kind: "attention" }];
    const focus = workspaceFocus && "feedId" in workspaceFocus && workspaceFocus.feedId === feed.config.id
      ? workspaceFocus
      : { kind: "feed" as const, feedId: feed.config.id };
    return focus.kind === "feed" ? [focus, { kind: "attention" }] : [focus, { kind: "feed", feedId: feed.config.id }, { kind: "attention" }];
  }, [activeCard, feed, screen, workspaceFocus, workspaceTab]);

  const changeFeed = (id: string) => {
    setTab("review");
    setWorkspaceFocus(null);
    void navigate({ to: "/feed/$feedId", params: { feedId: id } });
  };

  const openWorkspace = (nextTab: WorkspaceTab = "feed") => {
    setWorkspaceFocus(null);
    void navigate({ to: "/workspace/$feedId", params: { feedId }, search: { tab: nextTab } });
  };

  const closeWorkspace = () => {
    setWorkspaceFocus(null);
    void navigate({ to: "/feed/$feedId", params: { feedId } });
  };

  const openLearningReview = useCallback(() => {
    setWorkspaceFocus(null);
    void navigate({ to: "/learnings/$feedId", params: { feedId } });
  }, [feedId, navigate]);

  const openAgents = () => {
    void navigate({ to: "/agents/$feedId", params: { feedId } });
  };

  const signOut = () => {
    void authRequest("/sign-out", {}).finally(() => {
      queryClient.setQueryData(["auth-session"], null);
      queryClient.removeQueries({ queryKey: ["workspace"] });
    });
  };

  const showToast = (message: string, duration = 2_400) => {
    setToast(message);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => {
      setToast("");
      toastTimerRef.current = null;
    }, duration);
  };

  const changeDockTarget = useCallback((next: VoiceTarget) => {
    if (sameTarget(dockTargetRef.current, next)) return;
    dockTargetRef.current = next;
    setDockTarget(next);
    sessionStorage.setItem("attention.voiceTarget", JSON.stringify(next));
    setTargetVersion((current) => current + 1);
    void post<VoiceTarget>("/api/voice/target-change", { feedId: feed?.config.id ?? feedId, target: next }).then((validated) => {
      if (sameTarget(validated, next) || !sameTarget(dockTargetRef.current, next)) return;
      dockTargetRef.current = validated;
      setDockTarget(validated);
      sessionStorage.setItem("attention.voiceTarget", JSON.stringify(validated));
      setTargetVersion((current) => current + 1);
    }).catch((error) => showToast(error instanceof Error ? error.message : String(error)));
  }, [feed?.config.id, feedId]);

  const selectDockTarget = useCallback((next: VoiceTarget) => {
    dockScopeExplicitlyChangedRef.current = true;
    changeDockTarget(next);
  }, [changeDockTarget]);

  useEffect(() => {
    if (!feed) return;
    const context = `${screen}:${feed.config.id}:${screen === "workspace" ? workspaceTab : ""}`;
    if (dockContextRef.current !== context) {
      dockContextRef.current = context;
      dockScopeExplicitlyChangedRef.current = false;
    }
    if (screen === "feed" && dockTarget?.kind === "card" && !activeCard) {
      dockScopeExplicitlyChangedRef.current = false;
    }
    const candidate = screen === "feed" && dockScopeExplicitlyChangedRef.current && dockTarget?.kind === "card" && activeCard
      ? { kind: "card" as const, feedId: feed.config.id, cardId: activeCard.id }
      : dockTarget;
    const next = preferredTarget(candidate, ladder, dockScopeExplicitlyChangedRef.current);
    if (!sameTarget(next, dockTarget)) changeDockTarget(next);
  }, [activeCard, changeDockTarget, dockTarget, feed, ladder, screen, workspaceTab]);

  const withRefresh = async (callback: () => Promise<unknown>, message: string) => {
    try {
      await callback();
      showToast(message);
      await refresh();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    }
  };

  const instruct = (instruction: string) => {
    if (!feed || !dockTarget) return;
    void (async () => {
      try {
        const result = await post<any>("/api/voice/instructions", { feedId: feed.config.id, target: dockTarget, instruction });
        if (result.kind === "scoped_work") {
          const queued = { feedId: feed.config.id, workId: result.work.id };
          setUndoQueuedWork(queued);
          window.setTimeout(() => setUndoQueuedWork((current) => current?.workId === queued.workId ? null : current), 5_000);
          showToast(result.work.intent === "sweep_rejudge" ? "Feedback queued for Codex" : "Queued for Codex");
        } else {
          showToast("Revision proposal ready for approval");
        }
        await refresh();
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error));
      }
    })();
  };
  const applyProposal = (proposal: RevisionProposal) => void (async () => {
    try {
      const revision = await post<WorkspaceRevision>(`/api/revision-proposals/${proposal.id}/apply`);
      setUndoRevision(revision.id);
      showToast("Revision applied", 8_000);
      await refresh();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    }
  })();
  const rejectProposal = (proposal: RevisionProposal) => void withRefresh(() => post(`/api/revision-proposals/${proposal.id}/reject`), "Revision rejected");
  const applyLearningProposal = (proposal: RevisionProposal, content: string) => void (async () => {
    try {
      if (content.trimEnd() !== proposal.next.trimEnd()) await post(`/api/revision-proposals/${proposal.id}`, { content });
      const revision = await post<WorkspaceRevision>(`/api/revision-proposals/${proposal.id}/apply`);
      setUndoRevision(revision.id);
      showToast("Learning applied", 8_000);
      closeWorkspace();
      await refresh();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    }
  })();
  const rejectLearningProposal = (proposal: RevisionProposal) => void (async () => {
    await withRefresh(() => post(`/api/revision-proposals/${proposal.id}/reject`), "Learning proposal rejected");
    closeWorkspace();
  })();
  useEffect(() => {
    if (!state || !feed) return;
    const ids = state.proposals
      .filter((proposal) => proposal.anchorFeedId === feed.config.id && proposal.source === "compound")
      .map((proposal) => proposal.id);
    const known = knownCompoundProposalIdsRef.current.get(feed.config.id);
    if (!known) {
      knownCompoundProposalIdsRef.current.set(feed.config.id, new Set(ids));
      return;
    }
    const unseen = ids.find((id) => !known.has(id));
    ids.forEach((id) => known.add(id));
    if (unseen && screen === "feed") openLearningReview();
  }, [feed, openLearningReview, screen, state]);
  const recollect = () => void withRefresh(() => post(`/api/feeds/${feed?.config.id}/recollect`), "Source search queued");
  const flushVisibleCardEdits = async (card: Card) => {
    const textareas = document.querySelectorAll<HTMLTextAreaElement>(`[data-card-id="${CSS.escape(card.id)}"] textarea[data-block-id]`);
    await Promise.all(Array.from(textareas).map(async (textarea) => {
      const blockId = textarea.dataset.blockId;
      const block = card.blocks.find((item) => item.id === blockId);
      if (!blockId || block?.type !== "editable_text" || textarea.value === (block.value ?? "")) return;
      await post(`/api/feeds/${card.feedId}/cards/${card.id}/blocks/${blockId}`, { value: textarea.value });
    }));
  };
  const runCardAction = (card: Card, action: CardAction) => {
    if (!feed) return;
    void (async () => {
      try {
        await flushVisibleCardEdits(card);
        const work = await post<{ id: string }>(`/api/feeds/${feed.config.id}/cards/${card.id}/actions/${encodeURIComponent(action.id)}`);
        if (action.behavior === "default_cleanup") {
          const cleanup = { feedId: feed.config.id, cardId: card.id };
          setUndoCleanup(cleanup);
          window.setTimeout(() => setUndoCleanup((current) => current?.cardId === cleanup.cardId ? null : current), 5_000);
        } else {
          const queued = { feedId: feed.config.id, workId: work.id };
          setUndoQueuedWork(queued);
          window.setTimeout(() => setUndoQueuedWork((current) => current?.workId === queued.workId ? null : current), 5_000);
        }
        showToast(`${action.label} queued for Codex`);
        await refresh();
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error));
      }
    })();
  };
  const approveRoutineAction = (group: RoutineActionGroup) => {
    if (!feed) return;
    void (async () => {
      try {
        const work = await post<{ id: string }>(`/api/feeds/${feed.config.id}/routine-actions/${group.id}/approve`);
        const queued = { feedId: feed.config.id, workId: work.id };
        setUndoQueuedWork(queued);
        window.setTimeout(() => setUndoQueuedWork((current) => current?.workId === queued.workId ? null : current), 5_000);
        showToast(`${group.proposedAction.label} queued for Codex`);
        await refresh();
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error));
      }
    })();
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (screen !== "feed") return;
      if (event.key.toLowerCase() === "j") navTo(1);
      if (event.key.toLowerCase() === "k") navTo(-1);
      if (event.key.toLowerCase() === "o" && activeCard) {
        const details = pageRef.current?.querySelector<HTMLDetailsElement>(`[data-card-id="${CSS.escape(activeCard.id)}"] details.email-thread`);
        if (details) {
          event.preventDefault();
          details.open = !details.open;
        }
      }
      const action = tab === "review" && activeCard && (activeCard.status === "to_review_new" || activeCard.status === "to_review_updated")
        ? visibleCardActions(activeCard).find((item) => item.shortcut?.toLowerCase() === event.key.toLowerCase())
        : undefined;
      if (action) {
        event.preventDefault();
        runCardAction(activeCard!, action);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (auth === undefined) return <main className="loading">Loading attention…</main>;
  if (auth === null) return <AuthScreen onAuthenticated={(session) => queryClient.setQueryData(["auth-session"], session)} />;
  if (!state || !feed) return <main className="loading">Loading attention…</main>;

  const resolvedDockTarget = dockTarget ?? ladder[0];
  const compoundProposals = state.proposals.filter((proposal) => proposal.anchorFeedId === feed.config.id && proposal.source === "compound");

  if (screen === "workspace") return (
    <>
      <TopBar state={state} user={auth.user} onFeed={changeFeed} onInspector={setInspector} onWorkspace={openWorkspace} onAgents={openAgents} onSignOut={signOut} />
      <div className="workspace-proposals"><RevisionProposals proposals={state.proposals} onApply={applyProposal} onReject={rejectProposal} onReviewLearning={openLearningReview} /></div>
      <PromptWorkspace state={state} tab={workspaceTab} onTab={(nextTab) => openWorkspace(nextTab)} onBack={closeWorkspace} onInspector={setInspector} onSaved={showToast} onTargetFocus={(target) => { setWorkspaceFocus(target); selectDockTarget(target); }} />
      <Dock state={state} feed={feed} target={resolvedDockTarget} ladder={ladder} targetVersion={targetVersion} onTarget={selectDockTarget} onSubmit={instruct} onRecollect={recollect} />
      <InspectorPanel value={inspector} state={state} onClose={() => setInspector(null)} onChanged={(next) => { if (next) changeFeed(next); void refresh(next); }} />
      {toast && <div className="toast">{toast}{undoRevision && <button onClick={() => void withRefresh(() => post(`/api/revisions/${undoRevision}/revert`), "Revision restored").then(() => setUndoRevision(null))}>Undo</button>}</div>}
    </>
  );

  if (screen === "learnings") return (
    <>
      <TopBar state={state} user={auth.user} onFeed={changeFeed} onInspector={setInspector} onWorkspace={openWorkspace} onAgents={openAgents} onSignOut={signOut} />
      <LearningReview feed={feed} proposals={compoundProposals} onBack={closeWorkspace} onApply={applyLearningProposal} onReject={rejectLearningProposal} />
      <Dock state={state} feed={feed} target={resolvedDockTarget} ladder={ladder} targetVersion={targetVersion} onTarget={selectDockTarget} onSubmit={instruct} onRecollect={recollect} />
      <InspectorPanel value={inspector} state={state} onClose={() => setInspector(null)} onChanged={(next) => { if (next) changeFeed(next); void refresh(next); }} />
      {toast && <div className="toast">{toast}{undoRevision && <button onClick={() => void withRefresh(() => post(`/api/revisions/${undoRevision}/revert`), "Revision restored").then(() => setUndoRevision(null))}>Undo</button>}</div>}
    </>
  );

  if (screen === "agents") return (
    <>
      <TopBar state={state} user={auth.user} onFeed={changeFeed} onInspector={setInspector} onWorkspace={openWorkspace} onAgents={openAgents} onSignOut={signOut} />
      <AgentSetupPage state={state} onBack={closeWorkspace} onCopied={() => showToast("Copied")} />
      {toast && <div className="toast">{toast}</div>}
    </>
  );

  const updated = cards.filter((card) => card.status === "to_review_updated");
  const fresh = cards.filter((card) => card.status !== "to_review_updated");
  const feedWork = feed.work.filter((work) => work.cardId === "__feed__" && work.status === tab);
  return (
    <>
      <TopBar state={state} user={auth.user} onFeed={changeFeed} onInspector={setInspector} onWorkspace={openWorkspace} onAgents={openAgents} onSignOut={signOut} />
      <nav className="tabs">
        {(["review", "queued", "working", "done"] as Tab[]).map((item) => (
          <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>
            {item === "review" ? "To review" : item === "queued" ? "Queued for Codex" : item === "working" ? "Working" : "Done"}
            <span>{countFor(feed, item)}</span>
          </button>
        ))}
        <button className="tab-quiet tab-spacer" onClick={() => openWorkspace("feed")}>Prompts & sources</button>
        <button className="tab-quiet" onClick={openAgents}>Agents</button>
      </nav>
      <main className="page" ref={pageRef}>
        <RevisionProposals proposals={state.proposals} onApply={applyProposal} onReject={rejectProposal} onReviewLearning={openLearningReview} />
        {routineActions.map((group) => <RoutineActionGroupView key={group.id} group={group} onApprove={() => approveRoutineAction(group)} />)}
        {tab === "review" && updated.length > 0 && <div className="section-label">Back for review <span>{updated.length}</span></div>}
        {cards.map((card, index) => (
          <Fragment key={card.id}>
            {tab === "review" && index === updated.length && fresh.length > 0 && <div className="section-label" key={`${card.id}-label`}>New <span>{fresh.length}</span></div>}
            <CardView key={card.id} card={card} active={card.id === activeCard?.id} onActivate={() => setActiveCardId(card.id)} onChanged={() => void refresh()} onAction={(action) => runCardAction(card, action)} />
            <CardView card={card} active={card.id === activeCard?.id} onActivate={() => setActiveCardId(card.id)} onChanged={() => void refresh()} onAction={(action) => runCardAction(card, action)} />
          </Fragment>
        ))}
        {feedWork.map((work) => (
          <article className="attention-card feed-work-card" key={work.id}>
            <div className="card-rule" />
            <header className="card-head">
              <span className="kind-dot proposal" />
              <div><div className="eyebrow">Feed instruction · {work.status}</div><h2>{work.instruction}</h2></div>
            </header>
            <p className="why">{work.status === "queued" ? "Ready for the home Codex thread to drain." : "The home Codex thread is working through this feed-level instruction."}</p>
          </article>
        ))}
        {!cards.length && !routineActions.length && !feedWork.length && <div className="empty"><h2>Nothing here right now.</h2><p>{tab === "review" ? "A quiet feed is allowed. Wake the feed thread when you want Codex to collect or drain pending work." : "Move back to To review when you are ready for the next pass."}</p></div>}
        {(feed.readyNextPass > 0 || compoundProposals.length > 0) && <section className={`end-cap ${feed.readyNextPass ? "" : "actions-only"}`}>
          {feed.readyNextPass > 0 && <div>
            <span>End of this pass</span>
            <h2>{`${feed.readyNextPass} updated card${feed.readyNextPass === 1 ? "" : "s"} ready when you are.`}</h2>
          </div>}
          <div className="end-actions">
            {feed.readyNextPass > 0 && <button className="button primary" onClick={() => void withRefresh(() => post(`/api/feeds/${feed.config.id}/next-pass`), "Started the next pass")}>Review ready cards</button>}
            {compoundProposals.length > 0 && <button className="button ghost" onClick={openLearningReview}>Review learning proposal</button>}
          </div>
        </section>}
      </main>
      <Dock state={state} feed={feed} target={resolvedDockTarget} ladder={ladder} targetVersion={targetVersion} onTarget={selectDockTarget} onSubmit={instruct} onRecollect={recollect} />
      <InspectorPanel value={inspector} state={state} onClose={() => setInspector(null)} onChanged={(next) => { if (next) changeFeed(next); void refresh(next); }} />
      {toast && <div className="toast">{toast}{undoCleanup && <button onClick={() => void withRefresh(() => post(`/api/feeds/${undoCleanup.feedId}/cards/${undoCleanup.cardId}/undo-dismiss`), "Cleanup undone").then(() => setUndoCleanup(null))}>Undo</button>}{undoQueuedWork && <button onClick={() => void withRefresh(() => post(`/api/feeds/${undoQueuedWork.feedId}/work/${undoQueuedWork.workId}/cancel`), "Instruction cancelled").then(() => setUndoQueuedWork(null))}>Undo</button>}{undoRevision && <button onClick={() => void withRefresh(() => post(`/api/revisions/${undoRevision}/revert`), "Revision restored").then(() => setUndoRevision(null))}>Undo</button>}</div>}
    </>
  );
}
