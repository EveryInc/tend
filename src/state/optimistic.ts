import type { WorkItemView, WorkspaceView } from "../types";

export function projectQueuedCardAction(state: WorkspaceView, cardId: string, work: WorkItemView): WorkspaceView {
  if (state.active.config.id !== work.feedId) return state;
  return {
    ...state,
    active: {
      ...state.active,
      cards: state.active.cards.map((card) => card.id === cardId ? { ...card, status: "queued" } : card),
      work: [...state.active.work.filter((item) => item.id !== work.id), work],
    },
  };
}
