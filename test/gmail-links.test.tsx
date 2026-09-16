import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "../shared/types";
import { gmailHref, gmailLinks, GmailLinks } from "../src/feed/GmailLinks";
import { CardView } from "../src/feed/CardView";

const card: Card = {
  id: "source-email", feedId: "inbox", kind: "attention", status: "to_review_new",
  title: "Workshop attendee list", eyebrow: "Email", why: "Review the attendee list.",
  sourceMailbox: "owner+work@example.com",
  blocks: [{ id: "receipt", type: "receipt", text: "Gmail thread IDs: 1234567890abcdef and fedcba0987654321." }],
  readyForPass: 1, createdAt: "2026-09-16T12:00:00Z", updatedAt: "2026-09-16T12:00:00Z", history: [],
};

test("opens each referenced conversation in the source account, including archived mail", () => {
  expect(gmailLinks(card)).toEqual([
    "https://mail.google.com/mail/u/?authuser=owner%2Bwork%40example.com#all/1234567890abcdef",
    "https://mail.google.com/mail/u/?authuser=owner%2Bwork%40example.com#all/fedcba0987654321",
  ]);
});

test("uses evidence references and deduplicates the same thread", () => {
  expect(gmailLinks({ ...card, blocks: [{
    id: "sources", type: "evidence", items: [
      { label: "Gmail thread", detail: "1234567890abcdef" },
      { label: "Gmail thread", detail: "1234567890abcdef" },
      { label: "Original", href: "https://mail.google.com/mail/u/0/#inbox/fedcba0987654321" },
    ],
  }] })).toEqual(gmailLinks(card));
});

test("does not guess from the title, card ID, arbitrary text or an unrelated URL", () => {
  expect(gmailLinks({ ...card, id: "email-1234567890abcdef", blocks: [
    { id: "memo", type: "memo", text: "Thread ID: 1234567890abcdef" },
    { id: "receipt", type: "receipt", text: "Transaction ID: 1234567890abcdef" },
    { id: "source", type: "evidence", items: [{ label: "Original", href: "https://mail.google.com.evil.example/#all/1234567890abcdef" }] },
  ] })).toEqual([]);
  expect(gmailLinks({ ...card, sourceMailbox: undefined })).toEqual([]);
});

test("renders detached links and omits the control when no reference exists", () => {
  const html = renderToStaticMarkup(<GmailLinks card={card} />);
  expect(html).toContain("Open email 1 in Gmail");
  expect(html).toContain("Open email 2 in Gmail");
  expect(html).toContain('target="_blank" rel="noopener noreferrer"');
  expect(renderToStaticMarkup(<GmailLinks card={{ ...card, blocks: [] }} />)).toBe("");
});


test("keeps explicit modern Gmail references and fixes their account selector", () => {
  const href = "https://mail.google.com/mail/u/0/#inbox/FMfcgzExample";
  expect(gmailLinks({ ...card, blocks: [{ id: "source", type: "evidence", items: [{ label: "Original", href }] }] }))
    .toEqual(["https://mail.google.com/mail/u/?authuser=owner%2Bwork%40example.com#inbox/FMfcgzExample"]);
  expect(gmailHref(href, " owner@example.com ")).toContain("authuser=owner%40example.com");
  expect(gmailLinks({ ...card, sourceMailbox: "   " })).toEqual([]);
});

test("requires Gmail context before interpreting plain thread IDs", () => {
  expect(gmailLinks({ ...card, blocks: [{ id: "receipt", type: "receipt", text: "Thread ID: 1234567890abcdef." }] })).toEqual([]);
});

test("uses the source account in both the header and original evidence link", () => {
  const html = renderToStaticMarkup(<CardView
    card={{ ...card, blocks: [{ id: "source", type: "evidence", items: [
      { label: "Original", href: "https://mail.google.com/mail/u/0/#inbox/1234567890abcdef" },
    ] }] }}
    active={false} onActivate={() => {}} onChanged={() => {}}
    onAction={() => {}} onReturnToReview={() => {}}
  />);
  expect(html).toContain("Open in Gmail");
  expect(html).not.toContain("/mail/u/0/");
  expect(html.match(/authuser=owner%2Bwork%40example.com/g)).toHaveLength(2);
});
