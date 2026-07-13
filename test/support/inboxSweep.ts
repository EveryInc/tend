import type { AttentionDomain } from "../../server/domain";

export function inboxThreadFixture(threadId: string, cardId = `inbox-thread-${threadId}`) {
  const threadText = `From: sender-${threadId}@example.com\nTo: owner@example.com\nSubject: Thread ${threadId}\n\nPlease review thread ${threadId}.`;
  return {
    snapshot: { threadId, threadText, labels: ["INBOX"] },
    card: {
      id: cardId,
      sourceItemId: threadId,
      title: `Review thread ${threadId}.`,
      why: "It is currently in the Inbox and needs an explicit next step.",
      sourceMailbox: "owner@example.com",
      blocks: [
        { id: "brief", type: "memo" as const, text: `Thread ${threadId} needs review.` },
        { id: "email", type: "email_thread" as const, text: threadText },
      ],
      proposedAction: { label: "Archive", instruction: "Archive this email thread." },
      actions: [{ id: "archive", label: "Archive", behavior: "default_cleanup" as const }],
    },
  };
}

export async function recordInboxCollection(domain: AttentionDomain, threadIds: string[]): Promise<string> {
  return (await domain.recordInboxPage("inbox", "gmail-inbox", undefined, undefined, null, null, threadIds)).id;
}

export async function recordTwoPageInboxCollection(domain: AttentionDomain, firstPageIds: string[], secondPageIds: string[]): Promise<string> {
  const first = await domain.recordInboxPage("inbox", "gmail-inbox", undefined, undefined, null, "page-2", firstPageIds);
  return (await domain.recordInboxPage("inbox", "gmail-inbox", first.id, undefined, "page-2", null, secondPageIds)).id;
}
