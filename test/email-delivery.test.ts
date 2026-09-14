import { describe, expect, test } from "bun:test";
import { canonicalSenderIdentity, prepareApprovedEmailDelivery, semanticEmailHtml, validateEmailDeliveryReadback } from "../server/workflow/emailDelivery";
import type { Card, CardBlock, EmailDeliveryReadback, LegacyPreparedEmailDelivery, PreparedEmailDelivery, ProposedAction } from "../shared/types";

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
  sourceMailbox: "dan@every.to",
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
    verifiedMailbox: "dan@every.to",
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
    deliveredFromHeader: delivery.fromHeader,
  };
}

describe("approval-bound email delivery", () => {
  test("builds exact plain text plus escaped, unstyled semantic HTML", () => {
    const prepared = prepare();

    expect(prepared.version).toBe(2);
    expect(prepared.fromAddress).toBe("dan@every.to");
    expect(prepared.fromHeader).toBe("Dan Shipper <dan@every.to>");
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
      approvalDigest: "approval-digest", verifiedMailbox: "dan@every.to",
    });
    expect(prepared?.payload.parts[0].body.content).toBe("First\r\nline\r\n\r\nSecond");
  });

  test("does not mistake ordinary attribute-like prose for HTML styling", () => {
    const prose = "Use width=100 and style=compact in the source settings.";
    const proseArtifact = { ...artifact, value: prose };
    const prepared = prepareApprovedEmailDelivery({
      card: { ...card, blocks: [proseArtifact] }, action, artifact: proseArtifact, attachments: [],
      approvalDigest: "approval-digest", verifiedMailbox: "dan@every.to",
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
      verifiedMailbox: "dan@every.to",
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

  test("requires the connector's actual display-name-bearing From header", () => {
    const prepared = prepare();
    const exact = readback(prepared);

    expect(validateEmailDeliveryReadback(prepared, {
      ...exact,
      deliveredFromHeader: '"Dan Shipper" <dan@every.to>',
    }).deliveredFromHeader).toBe('"Dan Shipper" <dan@every.to>');

    for (const deliveredFromHeader of [
      "dan@every.to",
      "dan <dan@every.to>",
      "Dan Shipper <other@every.to>",
      "Dan Shipper <dan@every.to>\r\nBcc: attacker@example.test",
    ]) {
      expect(() => validateEmailDeliveryReadback(prepared, { ...exact, deliveredFromHeader })).toThrow(/delivered From/i);
    }
    expect(() => validateEmailDeliveryReadback(prepared, {
      ...exact,
      deliveredFromHeader: "attacker@example.test, Dan Shipper <dan@every.to>",
    })).toThrow("RFC address syntax");
    const missing = structuredClone(exact) as Partial<EmailDeliveryReadback>;
    delete missing.deliveredFromHeader;
    expect(() => validateEmailDeliveryReadback(prepared, missing)).toThrow(/delivered From/i);
  });

  test("binds the canonical sender identity into the delivery digest", () => {
    const prepared = prepare();
    const changedHeader = { ...readback(prepared), fromHeader: "dan <dan@every.to>" };
    expect(() => validateEmailDeliveryReadback(prepared, changedHeader)).toThrow("does not match");
  });

  test("loads configured identities and rejects identity drift after verification", () => {
    const previous = process.env.ATTENTION_EMAIL_SENDER_IDENTITIES;
    try {
      process.env.ATTENTION_EMAIL_SENDER_IDENTITIES = JSON.stringify({ "owner@example.test": "Owner Example" });
      const prepared = prepareApprovedEmailDelivery({
        card: { ...card, sourceMailbox: "owner@example.test" },
        action,
        artifact,
        attachments: [],
        approvalDigest: "configured-approval",
        verifiedMailbox: "owner@example.test",
      });
      expect(prepared?.fromHeader).toBe("Owner Example <owner@example.test>");
      process.env.ATTENTION_EMAIL_SENDER_IDENTITIES = JSON.stringify({ "owner@example.test": "Changed Owner" });
      expect(() => validateEmailDeliveryReadback(prepared!, readback(prepared!))).toThrow("identity changed");
    } finally {
      if (previous === undefined) delete process.env.ATTENTION_EMAIL_SENDER_IDENTITIES;
      else process.env.ATTENTION_EMAIL_SENDER_IDENTITIES = previous;
    }
  });

  test("does not guess an identity for another mailbox or accept unsafe configured identity data", () => {
    expect(canonicalSenderIdentity("OWNER@EXAMPLE.TEST", {
      "owner@example.test": "Owner Example",
    })).toEqual({
      displayName: "Owner Example",
      address: "owner@example.test",
      fromHeader: "Owner Example <owner@example.test>",
    });
    expect(() => canonicalSenderIdentity("other@example.test", {})).toThrow("No canonical sender identity");
    expect(() => canonicalSenderIdentity("other@example.test", {
      "other@example.test": "Other Person\r\nBcc: attacker@example.test",
    })).toThrow("control characters");
    expect(() => canonicalSenderIdentity("other@example.test\r\nBcc: attacker@example.test", {
      "other@example.test": "Other Person",
    })).toThrow("safe email address");
    expect(() => canonicalSenderIdentity("other@example.test", {
      "other@example.test": "Other Person\u2028Bcc: attacker@example.test",
    })).toThrow("control characters");
    expect(() => canonicalSenderIdentity("owner@example.test", {
      "owner@example.test": "evil@example.com, Owner",
    })).toThrow("RFC address syntax");
  });

  test("requires legacy delivery preparations to be freshly verified without changing the action approval", () => {
    const prepared = prepare();
    const { fromHeader: _fromHeader, ...withoutHeader } = structuredClone(prepared);
    const legacy: LegacyPreparedEmailDelivery = { ...withoutHeader, version: 1 };
    expect(() => validateEmailDeliveryReadback(legacy, readback(prepared)))
      .toThrow("Rerun action:verify");
    expect(prepared.approvalDigest).toBe("approval-digest");
  });
});
