import type { Card } from "./types";

export function isEmailTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function sourceEmailDates(card: Card, snapshots: unknown[]): NonNullable<Card["emailDates"]> {
  const references = JSON.stringify([card.id, card.blocks]);
  const emails = new Map<string, NonNullable<Card["emailDates"]>[number]>();
  for (const snapshot of snapshots) {
    const source = record(snapshot);
    if (!source) continue;
    const threadId = source.threadId ?? (Array.isArray(source.messages) ? source.id : undefined);
    if (typeof threadId !== "string" || !threadId) continue;
    if (card.sourceMailbox && source.sourceMailbox && source.sourceMailbox !== card.sourceMailbox) continue;
    const escapedId = threadId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`(?<![a-zA-Z0-9])${escapedId}(?![a-zA-Z0-9_-])`).test(references)) continue;
    const dates = isEmailTimestamp(source.receivedAt) ? [source.receivedAt] : [];
    for (const value of Array.isArray(source.messages) ? source.messages : []) {
      const message = record(value);
      const timestamp = message?.internalDate ?? message?.internal_date;
      if ((typeof timestamp !== "string" && typeof timestamp !== "number") || !/^\d+$/.test(String(timestamp))) continue;
      const date = new Date(Number(timestamp));
      if (Number.isFinite(date.getTime())) dates.push(date.toISOString());
    }
    for (const receivedAt of dates) {
      const previous = emails.get(threadId);
      if (previous && Date.parse(previous.receivedAt) >= Date.parse(receivedAt)) continue;
      emails.set(threadId, {
        threadId, receivedAt,
        ...(typeof source.subject === "string" ? { subject: source.subject } : {}),
      });
    }
  }
  return [...emails.values()].sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
}
