import { describe, expect, test } from "bun:test";
import { prepareApprovedEmailDelivery, semanticEmailHtml, validateEmailDeliveryReadback } from "../server/workflow/emailDelivery";
import type { Card, CardBlock, EmailDeliveryReadback, PreparedEmailDelivery, ProposedAction } from "../shared/types";

const body = `Hello <Dan> & "team".
Second line.

Best,
Dan`;

const attachment: CardBlock = {
  id: "attachment",
  type: "image",
  image: {
    name: `card-image-${"a".repeat(64)}.png`,
    filename: "chart.png",
    sha256: "a".repeat(64),
    mediaType: "image/png",
    byteLength: 1234,
    width: 100,
    height: 80,
    alt: "A chart",
    source: { cardId: "email-card", contentRevision: "b".repeat(64) },
  },
};

const artifact: CardBlock = { id: "draft", type: "editable_text", value: body, editable: true };
const action: ProposedAction = {
  label: "Send reply",
  instruction: "Send the exact reply to Reader@Example.test and cc editor@example.test.",
  artifactBlockId: "draft",
  externalMutation: true,
  mailboxPolicy: "reply_from_source",
};
const card: Card = {
  id: "email-card",
  feedId: "inbox",
  kind: "attention",
  status: "working",
  title: "Send the reviewed reply",
  eyebrow: "Inbox",
  why: "The user approved this exact message.",
  sourceMailbox: "owner@example.test",
  blocks: [artifact, attachment],
  actions: [{ id: "send", behavior: "approve_action", ...action }],
  readyForPass: 1,
  createdAt: "2026-09-12T12:00:00.000Z",
  updatedAt: "2026-09-12T12:00:00.000Z",
  history: [],
};

function prepare(): PreparedEmailDelivery {
  const result = prepareApprovedEmailDelivery({
    card,
    action,
    artifact,
    attachments: [attachment],
    approvalDigest: "approval-digest",
    verifiedMailbox: "owner@example.test",
  });
  if (!result) throw new Error("Expected email preparation.");
  return result;
}

function readback(delivery: PreparedEmailDelivery): EmailDeliveryReadback {
  return {
    ...structuredClone(delivery),
    source: "connector_readback",
    providerMessageId: "gmail-message-123",
    readAt: "2026-09-12T12:01:00.000Z",
  };
}

describe("approval-bound email delivery", () => {
  test("builds exact plain text plus escaped, unstyled semantic HTML", () => {
    const prepared = prepare();

    expect(prepared.fromAddress).toBe("owner@example.test");
    expect(prepared.recipients).toEqual(["reader@example.test", "editor@example.test"]);
    expect(prepared.payload.mime_type).toBe("multipart/alternative");
    expect(prepared.payload.parts[0].body.content).toBe(body);
    expect(prepared.payload.parts[1].body.content).toBe(
      "<p>Hello &lt;Dan&gt; &amp; &quot;team&quot;.<br>Second line.</p><p>Best,<br>Dan</p>",
    );
    expect(prepared.payload.parts[1].body.content).not.toMatch(/<pre|style=|width=/i);
    expect(prepared.attachments).toEqual([{
      blockId: "attachment",
      filename: "chart.png",
      mediaType: "image/png",
      byteLength: 1234,
      sha256: "a".repeat(64),
    }]);
    expect(prepared.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  test("preserves exact CRLF in plain text without copying it into HTML", () => {
    expect(semanticEmailHtml("First\r\nline\r\n\r\nSecond")).toBe("<p>First<br>line</p><p>Second</p>");
    const crlfArtifact = { ...artifact, value: "First\r\nline\r\n\r\nSecond" };
    const prepared = prepareApprovedEmailDelivery({
      card: { ...card, blocks: [crlfArtifact] }, action, artifact: crlfArtifact, attachments: [],
      approvalDigest: "approval-digest", verifiedMailbox: "owner@example.test",
    });
    expect(prepared?.payload.parts[0].body.content).toBe("First\r\nline\r\n\r\nSecond");
  });

  test("does not mistake ordinary attribute-like prose for HTML styling", () => {
    const prose = "Use width=100 and style=compact in the source settings.";
    const proseArtifact = { ...artifact, value: prose };
    const prepared = prepareApprovedEmailDelivery({
      card: { ...card, blocks: [proseArtifact] }, action, artifact: proseArtifact, attachments: [],
      approvalDigest: "approval-digest", verifiedMailbox: "owner@example.test",
    });
    expect(validateEmailDeliveryReadback(prepared!, readback(prepared!)).payload.parts[1].body.content).toBe(
      `<p>${prose}</p>`,
    );
  });

  test("fails closed when the reviewed email has no explicit outbound recipient", () => {
    expect(() => prepareApprovedEmailDelivery({
      card,
      action: { ...action, instruction: "Send the exact approved reply." },
      artifact: { ...artifact, value: "Body mention: historical@example.test" },
      attachments: [],
      approvalDigest: "approval-digest",
      verifiedMailbox: "owner@example.test",
    })).toThrow("outbound recipient address");
  });

  test("accepts only an exact connector readback of the prepared delivery", () => {
    const prepared = prepare();
    const exact = readback(prepared);
    expect(validateEmailDeliveryReadback(prepared, exact)).toEqual(exact);

    expect(() => validateEmailDeliveryReadback(prepared, {
      ...exact,
      payload: { mime_type: "text/plain", body: { content: body } },
    })).toThrow("multipart/alternative, not text-only");

    const changedBody = structuredClone(exact);
    changedBody.payload.parts[0].body.content = "Changed after approval.";
    expect(() => validateEmailDeliveryReadback(prepared, changedBody)).toThrow("does not match");

    const changedRecipients = { ...exact, recipients: ["other@example.test"] };
    expect(() => validateEmailDeliveryReadback(prepared, changedRecipients)).toThrow("does not match");

    const changedAttachment = structuredClone(exact);
    changedAttachment.attachments[0].filename = "renamed.png";
    expect(() => validateEmailDeliveryReadback(prepared, changedAttachment)).toThrow("does not match");

    const styledHtml = structuredClone(exact);
    styledHtml.payload.parts[1].body.content = '<p style="width: 40ch">Wrapped</p>';
    expect(() => validateEmailDeliveryReadback(prepared, styledHtml)).toThrow("unstyled semantic paragraphs");
  });
});
