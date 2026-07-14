import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { api, post } from "./app/api";
import { agentLabel, effectiveWorkLane } from "../shared/lanes";
import type { AttentionScreen, Inspector, Tab, WorkspaceTab } from "./app/types";
import { CardView } from "./feed/CardView";
import { RoutineActionGroupView } from "./feed/RoutineActionGroupView";
import { countFor, visibleCardActions, visibleCards, visibleFeedWork, visibleRoutineActions } from "./feed/selectors";
import { Dock } from "./shell/Dock";
import { InspectorPanel } from "./shell/InspectorPanel";
import { TopBar } from "./shell/TopBar";
import { useActiveCard } from "./state/activeCard";
import { RealtimeProvider } from "./state/realtime";
import { preferredTarget, sameTarget } from "./state/voiceTarget";
import type { Card, CardAction, FeedView, RevisionProposal, RoutineActionGroup, VoiceTarget, WorkItemView, WorkspaceRevision, WorkspaceView } from "./types";
import { FormattedText } from "./ui/FormattedText";
import { LearningReview, RevisionProposals } from "./workspace/LearningReview";
import { PromptWorkspace } from "./workspace/PromptWorkspace";

type VoiceInstructionResult =
  | { kind: "scoped_work"; work: WorkItemView }
  | { kind: "revision_proposal"; proposal: RevisionProposal };

type ParkedClaudeWork = { work: WorkItemView; label: string };

export function parkedClaudeWorkItems(feed: FeedView, claudeLiveness: string): ParkedClaudeWork[] {
  if (claudeLiveness !== "offline") return [];
  const cardsById = new Map(feed.cards.map((card) => [card.id, card.title]));
  return feed.work
    .filter((work) => work.status === "queued" && effectiveWorkLane(work, feed.thread) === "claude")
    .map((work) => ({
      work,
      label: work.cardId === "__feed__" ? "Feed instruction" : cardsById.get(work.cardId) ?? "Card instruction",
    }));
}

export function ParkedClaudeWorkNotice({ items, onReassign }: { items: ParkedClaudeWork[]; onReassign: (work: WorkItemView) => void }) {
  if (!items.length) return null;
  return (
    <div className="parked-work">
      <div>
        <span>Claude is offline, so {items.length === 1 ? "this instruction is" : "these instructions are"} parked.</span>
        <ul>
          {items.map(({ work, label }) => <li key={work.id}>{label}</li>)}
        </ul>
      </div>
      <div className="parked-work-actions">
        {items.map(({ work }) => (
          <button className="button ghost" key={work.id} onClick={() => onReassign(work)}>Reassign to Codex</button>
        ))}
      </div>
    </div>
  );
}

export default function App({ feedId, screen, workspaceTab }: { feedId: string; screen: AttentionScreen; workspaceTab: WorkspaceTab }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("review");
  const [inspector, setInspector] = useState<Inspector>(null);
  const [toast, setToast] = useState("");
  const [undoCleanup, setUndoCleanup] = useState<{ feedId: string; cardId: string } | null>(null);
  const [undoDismissal, setUndoDismissal] = useState<{ feedId: string; cardId: string } | null>(null);
  const [undoQueuedWork, setUndoQueuedWork] = useState<{ feedId: string; workId: string } | null>(null);
  const [undoRevision, setUndoRevision] = useState<string | null>(null);
  const [workspaceFocus, setWorkspaceFocus] = useState<VoiceTarget | null>(null);
  const [routeDockToClaude, setRouteDockToClaude] = useState(false);
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

  useEffect(() => {
    setTab("review");
    setWorkspaceFocus(null);
    setInspector(null);
    setRouteDockToClaude(false);
  }, [feedId]);

  const workspaceQuery = useQuery({
    queryKey: ["workspace", feedId],
    queryFn: () => api<WorkspaceView>(`/api/state?feed=${encodeURIComponent(feedId)}`),
  });
  const state = workspaceQuery.data ?? null;
  const refresh = useCallback(async (nextFeed = feedId) => {
    await queryClient.invalidateQueries({ queryKey: ["workspace", nextFeed] });
  }, [feedId, queryClient]);
  const withRealtime = (children: ReactNode) => (
    <RealtimeProvider enabled onChange={() => void refresh()}>
      {children}
    </RealtimeProvider>
  );

  const feed = state?.active;
  const canRouteDockToClaude = Boolean(feed?.thread.agents?.claude);
  const claudeLiveness = state?.agents?.claude.liveness ?? "offline";
  useEffect(() => {
    if (!canRouteDockToClaude) setRouteDockToClaude(false);
  }, [canRouteDockToClaude]);
  const cards = useMemo(() => feed ? visibleCards(feed, tab) : [], [feed, tab]);
  const routineActions = useMemo(() => feed ? visibleRoutineActions(feed, tab) : [], [feed, tab]);
  const cardIds = useMemo(() => cards.map((card) => card.id), [cards]);
  const { activeCardId, setActiveCardId, navTo } = useActiveCard(pageRef, cardIds);
  const activeCard = cards.find((card) => card.id === activeCardId) ?? cards[0];
  const editableQueuedNote = useCallback((card: Card): WorkItemView | undefined => {
    if (!feed) return undefined;
    return [...feed.work].reverse().find((work) =>
      work.cardId === card.id &&
      work.status === "queued" &&
      (work.kind === "instruction" || work.kind === "scoped_instruction") &&
      (!work.intent || work.intent === "voice_instruction")
    );
  }, [feed]);
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
    if (screen === "workspace" && workspaceTab === "global") {
      void navigate({ to: "/feed/$feedId/prompts/global", params: { feedId: id } });
    } else if (screen === "workspace") {
      void navigate({ to: "/feed/$feedId/prompts", params: { feedId: id } });
    } else if (screen === "learnings") {
      void navigate({ to: "/feed/$feedId/learnings", params: { feedId: id } });
    } else {
      void navigate({ to: "/feed/$feedId", params: { feedId: id } });
    }
  };
  const openMind = () => {
    void navigate({ to: "/mind" });
  };

  const openWorkspace = (nextTab: WorkspaceTab = "feed") => {
    setWorkspaceFocus(null);
    void navigate({ to: nextTab === "global" ? "/feed/$feedId/prompts/global" : "/feed/$feedId/prompts", params: { feedId } });
  };

  const closeWorkspace = () => {
    setWorkspaceFocus(null);
    void navigate({ to: "/feed/$feedId", params: { feedId } });
  };

  const openLearningReview = useCallback(() => {
    setWorkspaceFocus(null);
    void navigate({ to: "/feed/$feedId/learnings", params: { feedId } });
  }, [feedId, navigate]);

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
        const assignee = canRouteDockToClaude && routeDockToClaude ? "claude" : undefined;
        const result = await post<VoiceInstructionResult>("/api/voice/instructions", { feedId: feed.config.id, target: dockTarget, instruction, assignee });
        if (result.kind === "scoped_work") {
          const queued = { feedId: feed.config.id, workId: result.work.id };
          setUndoQueuedWork(queued);
          window.setTimeout(() => setUndoQueuedWork((current) => current?.workId === queued.workId ? null : current), 5_000);
          const agentName = agentLabel(effectiveWorkLane(result.work, feed.thread));
          showToast(result.work.intent === "sweep_rejudge" ? `Feedback queued for ${agentName}` : `Queued for ${agentName}`);
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
  const reassignQueuedWork = (work: WorkItemView) => void withRefresh(
    () => post(`/api/feeds/${work.feedId}/work/${work.id}/assignee`, { agent: "codex" }),
    "Reassigned to Codex",
  );
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
        if (action.behavior === "dismiss_card") {
          const dismissal = { feedId: feed.config.id, cardId: card.id };
          setUndoDismissal(dismissal);
          window.setTimeout(() => setUndoDismissal((current) => current?.cardId === dismissal.cardId ? null : current), 5_000);
          showToast("Card dismissed");
        } else if (action.behavior === "default_cleanup") {
          const cleanup = { feedId: feed.config.id, cardId: card.id };
          setUndoCleanup(cleanup);
          window.setTimeout(() => setUndoCleanup((current) => current?.cardId === cleanup.cardId ? null : current), 5_000);
          showToast(`${action.label} queued for Codex`);
        } else {
          const queued = { feedId: feed.config.id, workId: work.id };
          setUndoQueuedWork(queued);
          window.setTimeout(() => setUndoQueuedWork((current) => current?.workId === queued.workId ? null : current), 5_000);
          showToast(`${action.label} queued for Codex`);
        }
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
  const returnToReview = (card: Card) => void withRefresh(
    () => post(`/api/feeds/${card.feedId}/cards/${card.id}/return-to-review`),
    card.status === "queued" ? "Moved back to review" : "Ready for review again",
  );
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

  if (!state || !feed) return withRealtime(<main className="loading">Loading attention…</main>);
  const resolvedDockTarget = dockTarget ?? ladder[0];
  const compoundProposals = state.proposals.filter((proposal) => proposal.anchorFeedId === feed.config.id && proposal.source === "compound");
  const workAgent = (work: WorkItemView) => effectiveWorkLane(work, feed.thread);
  const workAgentLabel = (work: WorkItemView) => agentLabel(workAgent(work));
  const cardQueuedFor = (cardId: string) => {
    const queued = feed.work.find((work) => work.cardId === cardId && work.status === "queued");
    return queued ? workAgentLabel(queued) : undefined;
  };
  const queuedLanes = new Set(feed.work.filter((work) => work.status === "queued").map(workAgent));
  const queuedTabLabel = queuedLanes.size > 1 ? "Queued" : queuedLanes.has("claude") ? "Queued for Claude" : "Queued for Codex";

  if (screen === "workspace") return withRealtime(
    <>
      <TopBar state={state} onMind={openMind} onFeed={changeFeed} onInspector={setInspector} onWorkspace={openWorkspace} />
      <div className="workspace-proposals"><RevisionProposals proposals={state.proposals} onApply={applyProposal} onReject={rejectProposal} onReviewLearning={openLearningReview} /></div>
      <PromptWorkspace state={state} refreshVersion={workspaceQuery.dataUpdatedAt} tab={workspaceTab} onTab={openWorkspace} onBack={closeWorkspace} onInspector={setInspector} onSaved={showToast} onTargetFocus={(target) => { setWorkspaceFocus(target); selectDockTarget(target); }} />
      <Dock state={state} feed={feed} target={resolvedDockTarget} ladder={ladder} targetVersion={targetVersion} canRouteToClaude={canRouteDockToClaude} routeToClaude={routeDockToClaude} onRouteToClaude={setRouteDockToClaude} onTarget={selectDockTarget} onSubmit={instruct} onRecollect={recollect} />
      <InspectorPanel value={inspector} state={state} onClose={() => setInspector(null)} onChanged={(next) => { if (next) changeFeed(next); void refresh(next); }} />
      {toast && <div className="toast">{toast}{undoRevision && <button onClick={() => void withRefresh(() => post(`/api/revisions/${undoRevision}/revert`), "Revision restored").then(() => setUndoRevision(null))}>Undo</button>}</div>}
    </>
  );

  if (screen === "learnings") return withRealtime(
    <>
      <TopBar state={state} onMind={openMind} onFeed={changeFeed} onInspector={setInspector} onWorkspace={openWorkspace} />
      <LearningReview feed={feed} proposals={compoundProposals} onBack={closeWorkspace} onApply={applyLearningProposal} onReject={rejectLearningProposal} />
      <Dock state={state} feed={feed} target={resolvedDockTarget} ladder={ladder} targetVersion={targetVersion} canRouteToClaude={canRouteDockToClaude} routeToClaude={routeDockToClaude} onRouteToClaude={setRouteDockToClaude} onTarget={selectDockTarget} onSubmit={instruct} onRecollect={recollect} />
      <InspectorPanel value={inspector} state={state} onClose={() => setInspector(null)} onChanged={(next) => { if (next) changeFeed(next); void refresh(next); }} />
      {toast && <div className="toast">{toast}{undoRevision && <button onClick={() => void withRefresh(() => post(`/api/revisions/${undoRevision}/revert`), "Revision restored").then(() => setUndoRevision(null))}>Undo</button>}</div>}
    </>
  );

  const updated = cards.filter((card) => card.status === "to_review_updated");
  const fresh = cards.filter((card) => card.status !== "to_review_updated");
  const feedWork = visibleFeedWork(feed, tab);
  const parkedClaudeWork = tab === "queued" ? parkedClaudeWorkItems(feed, claudeLiveness) : [];
  return withRealtime(
    <>
      <TopBar state={state} onMind={openMind} onFeed={changeFeed} onInspector={setInspector} onWorkspace={openWorkspace} />
      <nav className="tabs">
        {(["review", "queued", "working", "done"] as Tab[]).map((item) => (
          <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>
            {item === "review" ? "To review" : item === "queued" ? queuedTabLabel : item === "working" ? "Working" : "Done"}
            <span>{countFor(feed, item)}</span>
          </button>
        ))}
        <button className="tab-quiet" onClick={() => openWorkspace("feed")}>Prompts & sources</button>
      </nav>
      <main className="page" ref={pageRef}>
        <RevisionProposals proposals={state.proposals} onApply={applyProposal} onReject={rejectProposal} onReviewLearning={openLearningReview} />
        {routineActions.map((group) => <RoutineActionGroupView key={group.id} group={group} onApprove={() => approveRoutineAction(group)} />)}
        <ParkedClaudeWorkNotice items={parkedClaudeWork} onReassign={reassignQueuedWork} />
        {tab === "review" && updated.length > 0 && <div className="section-label">Back for review <span>{updated.length}</span></div>}
        {cards.map((card, index) => (
          <Fragment key={card.id}>
            {tab === "review" && index === updated.length && fresh.length > 0 && <div className="section-label" key={`${card.id}-label`}>New <span>{fresh.length}</span></div>}
            <CardView key={card.id} card={card} queuedFor={cardQueuedFor(card.id)} queuedNote={editableQueuedNote(card)} active={card.id === activeCard?.id} onActivate={() => setActiveCardId(card.id)} onChanged={() => void refresh()} onAction={(action) => runCardAction(card, action)} onReturnToReview={() => returnToReview(card)} />
          </Fragment>
        ))}
        {feedWork.map((work) => (
          <article className="attention-card feed-work-card" key={work.id}>
            <div className="card-rule" />
            <header className="card-head">
              <span className="kind-dot proposal" />
              <div><div className="eyebrow">Feed instruction · {work.status}</div><h2>{work.instruction}</h2></div>
            </header>
            <p className="why">
              {work.status === "queued"
                ? `Ready for ${workAgentLabel(work)} to drain.`
                : work.status === "working"
                  ? `${workAgentLabel(work)} is working through this feed-level instruction.`
                  : `${workAgentLabel(work)} completed this feed-level instruction.`}
            </p>
            {work.status === "queued" && workAgent(work) === "claude" && claudeLiveness === "offline" && (
              <div className="parked-work">
                <span>Claude is offline, so this instruction is parked.</span>
                <button className="button ghost" onClick={() => reassignQueuedWork(work)}>Reassign to Codex</button>
              </div>
            )}
            {work.status === "completed" && work.response && (
              <div className="blocks">
                <section className="block block-rich_text">
                  <h3>{workAgentLabel(work)} response</h3>
                  <p><FormattedText text={work.response} /></p>
                </section>
              </div>
            )}
            {work.status === "queued" && (
              <footer className="card-action">
                <div>
                  <span className="action-label">Queued for {workAgentLabel(work)}</span>
                  <b>Waiting for the feed thread</b>
                </div>
                <div className="action-buttons">
                  <button className="button ghost" onClick={() => void withRefresh(
                    () => post(`/api/feeds/${work.feedId}/work/${work.id}/cancel`),
                    "Instruction cancelled",
                  )}>Cancel instruction</button>
                </div>
              </footer>
            )}
            {work.status === "completed" && (
              <footer className="card-action">
                <div>
                  <span className="action-label">Done</span>
                  <b>Completed</b>
                </div>
              </footer>
            )}
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
      <Dock state={state} feed={feed} target={resolvedDockTarget} ladder={ladder} targetVersion={targetVersion} canRouteToClaude={canRouteDockToClaude} routeToClaude={routeDockToClaude} onRouteToClaude={setRouteDockToClaude} onTarget={selectDockTarget} onSubmit={instruct} onRecollect={recollect} />
      <InspectorPanel value={inspector} state={state} onClose={() => setInspector(null)} onChanged={(next) => { if (next) changeFeed(next); void refresh(next); }} />
      {toast && <div className="toast">{toast}{undoCleanup && <button onClick={() => void withRefresh(() => post(`/api/feeds/${undoCleanup.feedId}/cards/${undoCleanup.cardId}/undo-cleanup-source`), "Cleanup undone").then(() => setUndoCleanup(null))}>Undo</button>}{undoDismissal && <button onClick={() => void withRefresh(() => post(`/api/feeds/${undoDismissal.feedId}/cards/${undoDismissal.cardId}/return-to-review`), "Dismissal undone").then(() => setUndoDismissal(null))}>Undo</button>}{undoQueuedWork && <button onClick={() => void withRefresh(() => post(`/api/feeds/${undoQueuedWork.feedId}/work/${undoQueuedWork.workId}/cancel`), "Instruction cancelled").then(() => setUndoQueuedWork(null))}>Undo</button>}{undoRevision && <button onClick={() => void withRefresh(() => post(`/api/revisions/${undoRevision}/revert`), "Revision restored").then(() => setUndoRevision(null))}>Undo</button>}</div>}
    </>
  );
}
