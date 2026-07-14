import type { CardAction } from "./types";

const RESERVED_SYNTHETIC_CARD_ACTION_IDS = new Set(["dismiss-card", "default-cleanup", "proposed-action"]);

export function isReservedCardActionId(id: string): boolean {
  return RESERVED_SYNTHETIC_CARD_ACTION_IDS.has(id);
}

export function safeConfiguredCardActions(actions: CardAction[] | undefined): CardAction[] {
  return (actions ?? []).filter((action) => !isReservedCardActionId(action.id));
}
