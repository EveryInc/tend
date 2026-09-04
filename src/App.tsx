import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { api, post } from "./app/api";
import { agentLabel, effectiveWorkLane } from "../shared/lanes";
import type { AttentionScreen, Inspector, Tab, WorkspaceTab } from "./app/types";
import { CardView } from "./feed/CardView";
import { RoutineActionGroupView } from "./feed/RoutineActionGroupView";
import { NativeApprovals } from "./feed/NativeApprovals";
import { countFor, currentReadingPreference, currentReadingProgress, retainReadingSessionGroups, selectedGroupCard, visibleCardActions, visibleCardGroups, visibleFeedWork, visibleRoutineActions } from "./feed/selectors";
import { ReadingStreamCard, ReadingStreamControls, ReadingStreamViewport, type ReadingUndo } from "./feed/ReadingStream";
import { isPassiveReadingCard } from "../shared/readingGroups";
import { Dock } from "./shell/Dock";
import { InspectorPanel } from "./shell/InspectorPanel";
import { TopBar } from "./shell/TopBar";
import { useActiveCard } from "./state/activeCard";
import { cardDispositionUndoPath, sameUndoRegistration, type CardDispositionUndo } from "./state/cardDispositionUndo";
import { RealtimeProvider } from "./state/realtime";
import { preferredTarget, sameTarget } from "./state/voiceTarget";
import type { Card, CardAction, FeedView, RevisionProposal, RoutineActionGroup, VoiceTarget, WorkItemView, WorkspaceRevision, WorkspaceView } from "./types";
import { FormattedText } from "./ui/FormattedText";
import { LearningReview, RevisionProposals } from "./workspace/LearningReview";
import { PromptWorkspace } from "./workspace/PromptWorkspace";

type ReadingFeedbackTarget = { feedId: string; cardId: string };
function readSession<T>(key: string, fallback: T): T {
  try { return JSON.parse(sessionStorage.getItem(key) ?? "null") ?? fallback; } catch { return fallback; }
}
function writeSession(key: string, value: unknown) {
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* A blocked storage area must not prevent reading. */ }
}

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
  const [undoCardDisposition, setUndoCardDisposition] = useState<CardDispositionUndo | null>(null);
  const [undoQueuedWork, setUndoQueuedWork] = useState<{ feedId: string; workId: string } | null>(null);
  const [undoRevision, setUndoRevision] = useState<string | null>(null);
  const [readingUndo, setReadingUndo] = useState<ReadingUndo | null>(null);
  const [readingUndoBusy, setReadingUndoBusy] = useState(false);
  const readingUndoInFlight = useRef(false);
  const [readingModeBusy, setReadingModeBusy] = useState(false);
  const engagementSessionId = useMemo(() => crypto.randomUUID(), [feedId]);
  const [readingSession, setReadingSession] = useState<{ feedId: string; ids: string[] }>({ feedId, ids: [] });
  const [workspaceFocus, setWorkspaceFocus] = useState<VoiceTarget | null>(null);
  const [readingFeedbackTarget, setReadingFeedbackTarget] = useState<ReadingFeedbackTarget | null>(() => {
    const saved = readSession<ReadingFeedbackTarget | null>("attention.readingFeedbackTarget", null);
    return saved?.feedId === feedId ? saved : null;
  });
  const readingFeedbackGenerationRef = useRef(0);
  const rememberReadingFeedback = useCallback((target: ReadingFeedbackTarget | null) => {
    readingFeedbackGenerationRef.current += 1;
    setReadingFeedbackTarget(target);
    writeSession("attention.readingFeedbackTarget", target);
  }, []);
  const [readingSelections, setReadingSelections] = useState<Record<string, Record<string, string>>>(() => readSession("attention.readingSelections", {}));
  // A reload restores the selected target, not textarea contents. An empty restored dock
  // must not make later Like/Prefer taps act as if an unfinished reason were still present.
  const readingDraftStartedRef = useRef(false);
  const [dockFocusRequest, setDockFocusRequest] = useState(0);
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
  const previousFeedRef = useRef(feedId);

  useEffect(() => {
    setTab("review");
    setWorkspaceFocus(null);
    setInspector(null);
    setRouteDockToClaude(false);
    if (previousFeedRef.current !== feedId) {
      rememberReadingFeedback(null);
      readingDraftStartedRef.current = false;
      setReadingUndo(null);
    }
    previousFeedRef.current = feedId;
  }, [feedId, rememberReadingFeedback]);

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
  const streamMode = feed?.config.readingMode === "stream";
  const streamGroups = useMemo(() => feed && streamMode
    ? retainReadingSessionGroups(feed, readingSession.feedId === feedId ? readingSession.ids : [])
    : [], [feed, feedId, readingSession, streamMode]);
  // Keep identities only, and only for groups actually shown. Tab roundtrips retain the visit;
  // a reload or feed switch starts with the latest unread selection.
  useEffect(() => {
    if (!feed) return;
    if ((!streamMode && readingSession.ids.length > 0) || readingSession.feedId !== feedId) {
      setReadingSession({ feedId, ids: streamMode && screen === "feed" && tab === "review" ? streamGroups.map((group) => group.id) : [] });
    } else if (streamMode && screen === "feed" && tab === "review") {
      const ids = streamGroups.map((group) => group.id);
      if (ids.join("\0") !== readingSession.ids.join("\0")) setReadingSession({ feedId, ids });
    }
  }, [feed, feedId, readingSession, screen, streamGroups, streamMode, tab]);
  const cardGroups = useMemo(() => feed ? streamMode && tab === "review" ? streamGroups : visibleCardGroups(feed, tab) : [], [feed, streamGroups, streamMode, tab]);
  const cards = useMemo(() => cardGroups.map((group) => selectedGroupCard(group, readingSelections[feedId]?.[group.id], feed?.readingPreferences)), [cardGroups, feed?.readingPreferences, feedId, readingSelections]);
  useEffect(() => {
    if (!streamMode || screen !== "feed" || tab !== "review") return;
    const missing = cardGroups.flatMap((group, index) => group.cards.some((card) => card.id === readingSelections[feedId]?.[group.id])
      ? [] : [[group.id, cards[index].id]]);
    if (!missing.length) return;
    setReadingSelections((current) => {
      const next = { ...current, [feedId]: { ...current[feedId], ...Object.fromEntries(missing) } };
      writeSession("attention.readingSelections", next);
      return next;
    });
  }, [cardGroups, cards, feedId, readingSelections, screen, streamMode, tab]);
  const routineActions = useMemo(() => feed ? visibleRoutineActions(feed, tab) : [], [feed, tab]);
  const cardIds = useMemo(() => cards.map((card) => card.id), [cards]);
  const { activeCardId, setActiveCardId, navTo } = useActiveCard(pageRef, cardIds);
  const activeCard = cards.find((card) => card.id === activeCardId) ?? cards[0];
  const selectReadingVersion = (groupId: string, cardId: string) => {
    setReadingSelections((current) => {
      const next = { ...current, [feedId]: { ...current[feedId], [groupId]: cardId } };
      writeSession("attention.readingSelections", next);
      return next;
    });
    setActiveCardId(cardId);
  };
  // A rating can move a reading card to Done before its spoken feedback is submitted. Keep that
  // explicitly targeted card in the dock's ladder instead of silently talking to the next card.
  const feedbackCard = readingFeedbackTarget && readingFeedbackTarget.feedId === feed?.config.id
    ? feed?.cards.find((card) => card.id === readingFeedbackTarget.cardId && card.reading)
    : undefined;
  const voiceCard = feedbackCard ?? activeCard;
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
      ...(voiceCard ? [{ kind: "card" as const, feedId: feed.config.id, cardId: voiceCard.id }] : []),
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
  }, [voiceCard, feed, screen, workspaceFocus, workspaceTab]);

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

  const changeReadingMode = async (mode: "review" | "stream") => {
    if (readingModeBusy) return;
    setReadingModeBusy(true);
    try {
      await post(`/api/feeds/${encodeURIComponent(feedId)}/reading-mode`, { mode });
      await refresh();
    } catch (error) { showToast(error instanceof Error ? error.message : String(error)); }
    finally { setReadingModeBusy(false); }
  };
  const undoReading = async () => {
    const undo = readingUndo;
    if (!undo || readingUndoInFlight.current) return;
    readingUndoInFlight.current = true;
    setReadingUndoBusy(true);
    try {
      await post(`/api/feeds/${encodeURIComponent(undo.feedId)}/reading-progress`, {
        clientEventId: crypto.randomUUID(), groupId: undo.progress.groupId,
        members: undo.progress.members, viewedMembers: undo.progress.viewedMembers,
        read: false, expectedEventId: undo.progress.eventId,
      });
      setReadingUndo((current) => current?.progress.eventId === undo.progress.eventId ? null : current);
      await refresh(undo.feedId);
      showToast("Marked unread. Your ratings are unchanged.");
    } catch (error) { showToast(error instanceof Error ? error.message : String(error)); }
    finally { readingUndoInFlight.current = false; setReadingUndoBusy(false); }
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
    rememberReadingFeedback(null);
    readingDraftStartedRef.current = false;
    dockScopeExplicitlyChangedRef.current = true;
    changeDockTarget(next);
  }, [changeDockTarget, rememberReadingFeedback]);

  const targetReadingFeedback = (card: Card, focus: boolean) => {
    setActiveCardId(card.id);
    rememberReadingFeedback({ feedId: card.feedId, cardId: card.id });
    dockScopeExplicitlyChangedRef.current = true;
    changeDockTarget({ kind: "card", feedId: card.feedId, cardId: card.id });
    if (focus) {
      readingDraftStartedRef.current = true;
      setDockFocusRequest((request) => request + 1);
    }
  };
  const startReadingFeedback = (target: VoiceTarget) => {
    if (target.kind !== "card" || !feed) return;
    const card = feed.cards.find((item) => item.id === target.cardId && item.reading);
    if (card) {
      readingDraftStartedRef.current = true;
      targetReadingFeedback(card, false);
    }
  };

  useEffect(() => {
    if (!feed) return;
    const context = `${screen}:${feed.config.id}:${screen === "workspace" ? workspaceTab : ""}`;
    if (dockContextRef.current !== context) {
      const initial = !dockContextRef.current;
      dockContextRef.current = context;
      dockScopeExplicitlyChangedRef.current = initial && Boolean(feedbackCard);
      if (!initial) {
        rememberReadingFeedback(null);
        readingDraftStartedRef.current = false;
      }
    }
    if (screen === "feed" && dockTarget?.kind === "card" && !voiceCard) {
      dockScopeExplicitlyChangedRef.current = false;
    }
    const candidate = screen === "feed" && dockScopeExplicitlyChangedRef.current && dockTarget?.kind === "card" && voiceCard
      ? { kind: "card" as const, feedId: feed.config.id, cardId: voiceCard.id }
      : dockTarget;
    const next = preferredTarget(candidate, ladder, dockScopeExplicitlyChangedRef.current);
    if (!sameTarget(next, dockTarget)) changeDockTarget(next);
  }, [voiceCard, changeDockTarget, dockTarget, feed, feedbackCard, ladder, rememberReadingFeedback, screen, workspaceTab]);

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
    const feedbackGeneration = readingFeedbackGenerationRef.current;
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
        if (sameTarget(dockTargetRef.current, dockTarget) && readingFeedbackGenerationRef.current === feedbackGeneration) {
          rememberReadingFeedback(null);
          readingDraftStartedRef.current = false;
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
          const dismissal: CardDispositionUndo = { kind: "dismiss", feedId: feed.config.id, cardId: card.id, operationId: crypto.randomUUID() };
          setUndoCardDisposition(dismissal);
          window.setTimeout(() => setUndoCardDisposition((current) => sameUndoRegistration(current, dismissal) ? null : current), 5_000);
          showToast("Card dismissed");
        } else if (action.behavior === "default_cleanup") {
          const cleanup: CardDispositionUndo = { kind: "cleanup", feedId: feed.config.id, cardId: card.id, operationId: work.id };
          setUndoCardDisposition(cleanup);
          window.setTimeout(() => setUndoCardDisposition((current) => sameUndoRegistration(current, cleanup) ? null : current), 5_000);
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
  const undoCardDispositionAction = (target: CardDispositionUndo) => void (async () => {
    try {
      await post(cardDispositionUndoPath(target.kind, target));
      setUndoCardDisposition((current) => sameUndoRegistration(current, target) ? null : current);
      showToast(target.kind === "cleanup" ? "Cleanup undone" : "Dismissal undone");
      await refresh();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    }
  })();
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

  const updated = cardGroups.filter((group) => group.visibleCards.some((card) => card.status === "to_review_updated"));
  const fresh = cardGroups.filter((group) => !group.visibleCards.some((card) => card.status === "to_review_updated") && group.visibleCards.some((card) => card.status === "to_review_new"));
  const feedWork = visibleFeedWork(feed, tab);
  const parkedClaudeWork = tab === "queued" ? parkedClaudeWorkItems(feed, claudeLiveness) : [];
  const readingMode = feed.config.readingMode ?? "review";
  const hasReading = feed.cards.some((card) => card.reading);
  const hasReadHistory = hasReading && (readingMode === "stream" || Object.keys(feed.readingProgress ?? {}).length > 0);
  return withRealtime(
    <>
      <TopBar state={state} onMind={openMind} onFeed={changeFeed} onInspector={setInspector} onWorkspace={openWorkspace} />
      <nav className="tabs">
        {(["review", ...(hasReadHistory ? ["read"] : []), "queued", "working", "done"] as Tab[]).map((item) => (
          <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>
            {item === "review" ? readingMode === "stream" ? "Feed" : "To review" : item === "read" ? "Read history" : item === "queued" ? queuedTabLabel : item === "working" ? "Working" : "Done"}
            <span>{countFor(feed, item)}{item === "review" && readingMode === "stream" ? " unread" : ""}</span>
          </button>
        ))}
        <button className="tab-quiet" onClick={() => openWorkspace("feed")}>Prompts & sources</button>
      </nav>
      <main className="page" ref={pageRef}>
        {hasReading && <ReadingStreamControls mode={readingMode} busy={readingModeBusy} onChange={(mode) => void changeReadingMode(mode)} />}
        {readingUndo?.feedId === feedId && <div className="reading-undo" role="status">
          <span>Marked read · no rating recorded</span>
          <button type="button" className="button text" disabled={readingUndoBusy} onClick={() => void undoReading()} title={readingUndo.title}>{readingUndoBusy ? "Restoring…" : "Undo"}</button>
          <button type="button" className="button text" onClick={() => setTab("read")}>Read history</button>
          <button type="button" className="reading-undo-close" aria-label="Dismiss read notification" onClick={() => setReadingUndo(null)}>×</button>
        </div>}
        <NativeApprovals feedId={feedId} />
        <RevisionProposals proposals={state.proposals} onApply={applyProposal} onReject={rejectProposal} onReviewLearning={openLearningReview} />
        {routineActions.map((group) => <RoutineActionGroupView key={group.id} group={group} onApprove={() => approveRoutineAction(group)} />)}
        <ParkedClaudeWorkNotice items={parkedClaudeWork} onReassign={reassignQueuedWork} />
        {tab === "review" && !streamMode && updated.length > 0 && <div className="section-label">Back for review <span>{updated.length}</span></div>}
        <ReadingStreamViewport enabled={readingMode === "stream" && tab === "review"} sessionKey={`${feedId}:${tab}`} ids={cardGroups.map((group) => group.id)}>
        {cards.map((card, index) => (
          <Fragment key={cardGroups[index].id}>
            {tab === "review" && !streamMode && index === updated.length && fresh.length > 0 && <div className="section-label" key={`${card.id}-label`}>New <span>{fresh.length}</span></div>}
            <ReadingStreamCard group={cardGroups[index]} card={card}
              engagementSessionId={engagementSessionId}
              enabled={readingMode === "stream" && tab === "review" && cardGroups[index].cards.every(isPassiveReadingCard)}
              history={tab === "read"} progress={currentReadingProgress(cardGroups[index], feed.readingProgress)}
              busy={cardGroups[index].cards.some((member) => feed.work.some((work) => work.cardId === member.id && ["queued", "working", "approved_blocked"].includes(work.status)))}
              onChanged={() => void refresh()} onUnread={(previous) => setReadingUndo((current) =>
                current?.feedId === feedId && current.progress.groupId === previous.groupId && current.progress.eventId === previous.eventId ? null : current
              )} onRead={setReadingUndo}>
            <CardView
              card={card} queuedFor={cardQueuedFor(card.id)} queuedNote={editableQueuedNote(card)}
              active={card.id === activeCard?.id} onActivate={() => setActiveCardId(card.id)} onChanged={() => void refresh()}
              onAction={(action) => runCardAction(card, action)} onReturnToReview={() => returnToReview(card)}
              readingReaction={feed.readingReactions?.[card.id]} onReadingFeedback={() => targetReadingFeedback(card, true)}
              onReadingReaction={() => { if (!readingDraftStartedRef.current) targetReadingFeedback(card, false); }}
              readingGroup={cardGroups[index]} readingPreference={currentReadingPreference(cardGroups[index], feed.readingPreferences)}
              readingSession={streamMode && tab === "review"}
              onReadingVersion={(cardId) => selectReadingVersion(cardGroups[index].id, cardId)}
            />
            </ReadingStreamCard>
          </Fragment>
        ))}
        </ReadingStreamViewport>
        {readingMode === "stream" && tab === "review" && cards.some((card) => card.reading) && <section className="reading-stream-end" aria-label="End of reading feed">
          <h2>That’s everything for now.</h2>
          <p>You can scroll back to read cards and add feedback. Next visit starts with unread cards; everything stays in Read history.</p>
        </section>}
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
        {!cards.length && !routineActions.length && !feedWork.length && <div className="empty"><h2>{tab === "review" && readingMode === "stream" ? "You’re caught up." : "Nothing here right now."}</h2><p>{tab === "read" ? "Cards you read or rate stay here. Reading never counts as a rating." : tab === "review" && readingMode === "stream" ? "Your read cards and ratings are still in Read history. There’s no need to rate everything." : tab === "review" ? "A quiet feed is allowed. Wake the feed thread when you want Codex to collect or drain pending work." : "Move back to To review when you are ready for the next pass."}</p></div>}
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
      <Dock state={state} feed={feed} target={resolvedDockTarget} ladder={ladder} targetVersion={targetVersion} canRouteToClaude={canRouteDockToClaude} routeToClaude={routeDockToClaude} onRouteToClaude={setRouteDockToClaude} focusRequest={dockFocusRequest} onTarget={selectDockTarget} onDraftStart={startReadingFeedback} onSubmit={instruct} onRecollect={recollect} />
      <InspectorPanel value={inspector} state={state} onClose={() => setInspector(null)} onChanged={(next) => { if (next) changeFeed(next); void refresh(next); }} />
      {toast && <div className="toast">{toast}{undoCardDisposition && <button onClick={() => undoCardDispositionAction(undoCardDisposition)}>Undo</button>}{undoQueuedWork && <button onClick={() => void withRefresh(() => post(`/api/feeds/${undoQueuedWork.feedId}/work/${undoQueuedWork.workId}/cancel`), "Instruction cancelled").then(() => setUndoQueuedWork(null))}>Undo</button>}{undoRevision && <button onClick={() => void withRefresh(() => post(`/api/revisions/${undoRevision}/revert`), "Revision restored").then(() => setUndoRevision(null))}>Undo</button>}</div>}
    </>
  );
}
