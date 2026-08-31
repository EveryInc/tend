import type { Card, ProposedAction } from "./types";

function uniqueEmails(values: string[]): string[] {
  const emails = new Set<string>();
  for (const value of values) {
    for (const match of value.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) {
      emails.add(match[0].toLowerCase());
    }
  }
  return [...emails];
}

function outboundHeaderRecipients(text: string): string[] {
  const values: string[] = [];
  let header = "";
  // Only the leading envelope is eligible; later headers belong to message content.
  for (const line of text.trimStart().split(/\r?\n/)) {
    const match = line.match(/^(from|to|cc|bcc|reply-to|subject|date|sent|message-id|in-reply-to|references|mime-version|content-type|content-transfer-encoding):\s*(.*)$/i);
    if (match) {
      header = match[1].toLowerCase();
      if (/^(to|cc|bcc)$/.test(header)) values.push(match[2]);
    } else if (header && /^[ \t]+\S/.test(line)) {
      if (/^(to|cc|bcc)$/.test(header)) values.push(line.trim());
    } else {
      break;
    }
  }
  return uniqueEmails(values);
}

export function actionEmailRecipients(card: Card | undefined, action: ProposedAction): string[] {
  const artifact = action.artifactBlockId ? card?.blocks.find((block) => block.id === action.artifactBlockId) : undefined;
  const sourceMailbox = card?.sourceMailbox?.trim().toLowerCase();
  return uniqueEmails([
    action.label,
    action.instruction,
    ...(artifact?.type === "editable_text" ? outboundHeaderRecipients(artifact.value ?? artifact.text ?? "") : []),
  ]).filter((email) => email !== sourceMailbox);
}
