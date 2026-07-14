export interface CardReference {
  feedId: string;
  cardId: string;
}

export interface CardDispositionUndo extends CardReference {
  operationId: string;
}

export function sameCardReference(current: CardReference | null, expected: CardReference): boolean {
  return current?.feedId === expected.feedId && current.cardId === expected.cardId;
}

export function sameUndoRegistration(current: CardDispositionUndo | null, expected: CardDispositionUndo): boolean {
  return sameCardReference(current, expected) && current?.operationId === expected.operationId;
}

export function cardDispositionUndoPath(kind: "dismiss" | "cleanup", card: CardReference): string {
  const operation = kind === "dismiss" ? "return-to-review" : "undo-cleanup-source";
  return `/api/feeds/${card.feedId}/cards/${card.cardId}/${operation}`;
}
