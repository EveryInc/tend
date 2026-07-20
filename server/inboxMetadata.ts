export interface InboxSourceMetadata {
  sourceSender?: string;
  sourceLatestMessageAt?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTimestamp(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp.`);
  }
  return value.trim();
}

export function inboxSourceMetadata(value: unknown, label = "Inbox snapshot"): InboxSourceMetadata {
  if (!isRecord(value)) return {};
  const explicitLatest = validTimestamp(value.latestMessageAt, `${label} latestMessageAt`);
  let messageTimestamps: string[] = [];
  if (value.messageTimestamps !== undefined) {
    if (!Array.isArray(value.messageTimestamps)) throw new Error(`${label} messageTimestamps must be an array.`);
    messageTimestamps = value.messageTimestamps.map((timestamp, index) =>
      validTimestamp(timestamp, `${label} messageTimestamps item ${index + 1}`) as string,
    );
  }
  const sourceLatestMessageAt = [explicitLatest, ...messageTimestamps]
    .filter((timestamp): timestamp is string => Boolean(timestamp))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
  const senderMatch = typeof value.threadText === "string" ? /^From:\s*(.+)$/m.exec(value.threadText) : null;
  const sourceSender = senderMatch?.[1]?.trim();
  return {
    ...(sourceSender ? { sourceSender } : {}),
    ...(sourceLatestMessageAt ? { sourceLatestMessageAt } : {}),
  };
}
