import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CardView } from "../src/feed/CardView";
import type { Card } from "../shared/types";

test("renders Inbox sender and arrival time before the subject", () => {
  const card: Card = {
    id: "inbox-thread-metadata",
    feedId: "inbox",
    kind: "attention",
    status: "to_review_new",
    title: "Quarterly planning",
    eyebrow: "Inbox",
    why: "The sender needs a decision.",
    sourceSender: "Ada Lovelace <ada@example.com>",
    sourceLatestMessageAt: "2026-07-13T09:45:00-06:00",
    blocks: [],
    readyForPass: 1,
    createdAt: "2026-07-13T16:00:00.000Z",
    updatedAt: "2026-07-13T16:00:00.000Z",
    history: [],
  };

  const html = renderToStaticMarkup(<CardView card={card} active={false} onActivate={() => {}} onChanged={() => {}} onAction={() => {}} onReturnToReview={() => {}} />);

  expect(html).toContain("Ada Lovelace &lt;ada@example.com&gt;");
  expect(html).toContain('dateTime="2026-07-13T09:45:00-06:00"');
  expect(html.indexOf("Ada Lovelace")).toBeLessThan(html.indexOf("Quarterly planning"));
  expect(html).toContain("Start agent");
  expect(html).not.toContain("Additional instructions");
});

test("renders structured evidence hrefs as clickable anchors", () => {
  const card: Card = {
    id: "linked-evidence",
    feedId: "company-attention",
    kind: "attention",
    status: "to_review_new",
    title: "Linked evidence",
    eyebrow: "Source",
    why: "The source should open from the card.",
    blocks: [{
      id: "sources",
      type: "evidence",
      label: "Sources",
      items: [{ label: "Signed agreement", href: "https://example.com/agreement" }],
    }],
    readyForPass: 1,
    createdAt: "2026-06-10T12:00:00.000Z",
    updatedAt: "2026-06-10T12:00:00.000Z",
    history: [],
  };

  const html = renderToStaticMarkup(
    <CardView
      card={card}
      active={false}
      onActivate={() => {}}
      onChanged={() => {}}
      onAction={() => {}}
      onReturnToReview={() => {}}
    />,
  );

  expect(html).toContain('href="https://example.com/agreement"');
  expect(html).toContain(">Signed agreement</a>");
});

test("renders a visible lens receipt for a context-influenced card", () => {
  const card: Card = {
    id: "paywall-context",
    feedId: "every-performance",
    kind: "attention",
    status: "to_review_new",
    title: "Mobile paywall behavior deserves a closer look.",
    eyebrow: "Every Performance",
    why: "A current metric now connects to the active paywall diagnosis.",
    sourceRunIds: ["run-current"],
    contextInfluence: {
      updateId: "mind-current",
      signalIds: ["paywall"],
      mode: "lens",
      effect: "prioritized",
      summary: "Prioritized because paywall diagnosis is an active decision.",
      sourceCount: 3,
    },
    blocks: [{ id: "brief", type: "memo", text: "Source-backed metric detail." }],
    readyForPass: 1,
    createdAt: "2026-06-13T12:00:00.000Z",
    updatedAt: "2026-06-13T12:00:00.000Z",
    history: [],
  };

  const html = renderToStaticMarkup(
    <CardView
      card={card}
      active={false}
      onActivate={() => {}}
      onChanged={() => {}}
      onAction={() => {}}
      onReturnToReview={() => {}}
    />,
  );

  expect(html).toContain("On your mind");
  expect(html).toContain("Prioritized because paywall diagnosis is an active decision.");
  expect(html).toContain('href="/mind/mind-current#signal-paywall"');
  expect(html).toContain("View context and 3 sources");
});

test("labels context-originated research separately from source evidence", () => {
  const card: Card = {
    id: "paywall-research",
    feedId: "company-attention",
    kind: "attention",
    status: "to_review_new",
    title: "Three evidence-backed paywall improvements.",
    eyebrow: "Company Attention",
    why: "A bounded research pass found relevant patterns.",
    sourceRunIds: ["run-research"],
    contextInfluence: {
      updateId: "mind-current",
      signalIds: ["paywall"],
      mode: "research",
      effect: "selected",
      summary: "Prompted by the active paywall work.",
      researchQuestion: "What evidence-backed paywall improvements fit Every?",
      sourceCount: 2,
    },
    blocks: [{ id: "sources", type: "evidence", items: ["Independent research source"] }],
    readyForPass: 1,
    createdAt: "2026-06-13T12:00:00.000Z",
    updatedAt: "2026-06-13T12:00:00.000Z",
    history: [],
  };

  const html = renderToStaticMarkup(
    <CardView
      card={card}
      active={false}
      onActivate={() => {}}
      onChanged={() => {}}
      onAction={() => {}}
      onReturnToReview={() => {}}
    />,
  );

  expect(html).toContain("Prompted by On Your Mind");
  expect(html).toContain("What evidence-backed paywall improvements fit Every?");
});
