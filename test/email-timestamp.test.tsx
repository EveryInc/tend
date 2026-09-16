import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { sourceEmailDates } from "../shared/emailTimestamp";
import type { Card } from "../shared/types";
import { CardView } from "../src/feed/CardView";

const card: Card = {
  id: "mail-abc123", feedId: "inbox", kind: "attention", status: "to_review_new",
  title: "Confirm the attendee list", eyebrow: "Workshop", why: "The organizer needs a reply.",
  sourceMailbox: "owner@example.com", sourceRunIds: ["run-example"],
  blocks: [{ id: "source", type: "receipt", text: "Thread ID: abc123." }],
  readyForPass: 1, createdAt: "2026-09-16T12:00:00Z", updatedAt: "2026-09-16T12:00:00Z", history: [],
};
const source = {
  kind: "gmail_thread_metadata", threadId: "abc123", sourceMailbox: "owner@example.com",
  receivedAt: "2026-07-15T11:47:00+02:00", subject: "Attendee list",
};

test("old cards recover email dates from their exact source thread and mailbox", () => {
  expect(sourceEmailDates(card, [
    { ...source, threadId: "abc1234" },
    { ...source, sourceMailbox: "someone@example.com" },
    { ...source, receivedAt: "2026-07-15" },
    { ...source, receivedAt: "2026-07-15T11:47:00" },
    { ...source, receivedAt: "invalid" },
    { kind: "collection_receipt", collectedAt: card.createdAt },
  ])).toEqual([]);
  expect(sourceEmailDates(card, [{ ...source, kind: undefined }])).toEqual([
    { threadId: source.threadId, receivedAt: source.receivedAt, subject: source.subject },
  ]);
  expect(card).not.toHaveProperty("emailDates");
});

test("source dates are deduplicated per thread and ordered newest first", () => {
  const second = { ...source, threadId: "def456", receivedAt: "2026-07-16T12:00:00Z" };
  const referenced = { ...card, blocks: [{ id: "source", type: "receipt" as const, text: "Thread IDs: abc123 and def456." }] };
  const dates = sourceEmailDates(referenced, [source, second, source, { ...source, receivedAt: "2026-07-14T00:00:00Z" }]);
  expect(dates.map((date) => date.threadId)).toEqual(["def456", "abc123"]);
  expect(dates[1].receivedAt).toBe(source.receivedAt);
});

function render(card: Card) {
  return renderToStaticMarkup(<CardView card={card} active={false} onActivate={() => {}} onChanged={() => {}} onAction={() => {}} onReturnToReview={() => {}} />);
}

test("the card header formats the source instant in the viewer's timezone", () => {
  const dates = sourceEmailDates(card, [source]);
  const html = render({ ...card, emailDates: dates });
  const expected = new Intl.DateTimeFormat(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(source.receivedAt));
  expect(html).toContain(`dateTime="${source.receivedAt}"`);
  expect(html).toContain(expected);
  expect(html.indexOf("Email received")).toBeLessThan(html.indexOf("</header>"));
  expect(html).not.toContain(card.createdAt);
  expect(render(card)).not.toContain("<time");
});

test("legacy Gmail thread snapshots work without a card mailbox and with punctuated IDs", () => {
  const legacy = { ...card, id: "gmail-thread-thread-reviewed", sourceMailbox: undefined,
    blocks: [{ id: "source", type: "evidence" as const, items: [{ label: "Email", href: "https://mail.google.com/mail/u/0/#inbox/thread-reviewed" }] }],
  };
  const instant = "2026-07-15T09:47:00.000Z";
  expect(sourceEmailDates(legacy, [{ id: "thread-reviewed", history_id: "history-1", messages: [
    { id: "message-1", internalDate: String(Date.parse(instant)) },
  ] }])).toEqual([{ threadId: "thread-reviewed", receivedAt: instant }]);
  expect(sourceEmailDates(legacy, [{ ...source, threadId: "thread-review" }])).toEqual([]);
});
