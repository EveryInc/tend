import type {
  Card,
  CardBlock,
  EmailDeliveryAttachment,
  EmailDeliveryReadback,
  EmailMimePayload,
  PreparedEmailDelivery,
  ProposedAction,
} from "../../shared/types";
import { actionEmailRecipients } from "../../shared/emailRecipients";
import { digest } from "../util";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function semanticEmailHtml(plainText: string): string {
  return plainText
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll("\n", "<br>")}</p>`)
    .join("");
}

function emailMimePayload(plainText: string): EmailMimePayload {
  return {
    mime_type: "multipart/alternative",
    parts: [
      { mime_type: "text/plain", charset: "utf-8", body: { content: plainText } },
      { mime_type: "text/html", charset: "utf-8", body: { content: semanticEmailHtml(plainText) } },
    ],
  };
}

function emailAttachments(blocks: CardBlock[]): EmailDeliveryAttachment[] {
  return blocks.map((block) => {
    if (block.type !== "image" || !block.image) throw new Error("Approved email attachments must be verified image blocks.");
    return {
      blockId: block.id,
      filename: block.image.filename,
      mediaType: block.image.mediaType,
      byteLength: block.image.byteLength,
      sha256: block.image.sha256,
    };
  });
}

function deliveryDigest(input: Omit<PreparedEmailDelivery, "payloadDigest">): string {
  return digest(input);
}

export function prepareApprovedEmailDelivery(input: {
  card: Card;
  action: ProposedAction;
  artifact?: CardBlock;
  attachments: CardBlock[];
  approvalDigest: string;
  verifiedMailbox?: string;
}): PreparedEmailDelivery | undefined {
  if (!input.verifiedMailbox) return undefined;
  if (input.artifact?.type !== "editable_text") {
    throw new Error("Approved email delivery requires one editable-text artifact containing the exact reviewed body.");
  }
  const plainText = input.artifact.value;
  if (typeof plainText !== "string" || !plainText.trim()) throw new Error("Approved email delivery requires a non-empty reviewed body.");
  const recipients = actionEmailRecipients(input.card, input.action);
  if (!recipients.length) {
    throw new Error("Approved email delivery requires the outbound recipient address in the action instruction or the draft's leading To/Cc/Bcc headers.");
  }
  const preparedWithoutDigest: Omit<PreparedEmailDelivery, "payloadDigest"> = {
    version: 1,
    approvalDigest: input.approvalDigest,
    fromAddress: input.verifiedMailbox,
    recipients,
    payload: emailMimePayload(plainText),
    attachments: emailAttachments(input.attachments),
  };
  return { ...preparedWithoutDigest, payloadDigest: deliveryDigest(preparedWithoutDigest) };
}

function readbackPayload(value: unknown): EmailMimePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Email delivery readback must include the delivered multipart/alternative payload.");
  }
  const payload = value as Partial<EmailMimePayload>;
  if (payload.mime_type !== "multipart/alternative" || !Array.isArray(payload.parts) || payload.parts.length !== 2) {
    throw new Error("Email delivery readback must be multipart/alternative, not text-only.");
  }
  const [plain, html] = payload.parts;
  if (
    plain?.mime_type !== "text/plain" || plain.charset !== "utf-8" || typeof plain.body?.content !== "string"
    || html?.mime_type !== "text/html" || html.charset !== "utf-8" || typeof html.body?.content !== "string"
  ) {
    throw new Error("Email delivery readback must contain exact UTF-8 text/plain and text/html parts in that order.");
  }
  if (/<pre\b|\bstyle\s*=|\b(?:max-)?width\s*=/i.test(html.body.content)) {
    throw new Error("Email delivery HTML must use unstyled semantic paragraphs without preformatted or fixed-width markup.");
  }
  return {
    mime_type: "multipart/alternative",
    parts: [
      { mime_type: "text/plain", charset: "utf-8", body: { content: plain.body.content } },
      { mime_type: "text/html", charset: "utf-8", body: { content: html.body.content } },
    ],
  };
}

function deliverySnapshot(readback: PreparedEmailDelivery): Omit<PreparedEmailDelivery, "payloadDigest"> {
  return {
    version: readback.version,
    approvalDigest: readback.approvalDigest,
    fromAddress: readback.fromAddress,
    recipients: readback.recipients,
    payload: readback.payload,
    attachments: readback.attachments,
  };
}

export function validateEmailDeliveryReadback(
  expected: PreparedEmailDelivery,
  value: unknown,
): EmailDeliveryReadback {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Email completion requires a connector delivery readback for the exact verified payload.");
  }
  const input = value as Partial<EmailDeliveryReadback>;
  if (input.source !== "connector_readback") {
    throw new Error('Email delivery readback source must be "connector_readback".');
  }
  if (typeof input.providerMessageId !== "string" || !input.providerMessageId.trim()) {
    throw new Error("Email delivery readback requires the provider message id.");
  }
  if (typeof input.readAt !== "string" || !Number.isFinite(Date.parse(input.readAt))) {
    throw new Error("Email delivery readback requires a valid readAt timestamp.");
  }
  if (!Array.isArray(input.recipients) || !Array.isArray(input.attachments)) {
    throw new Error("Email delivery readback must include exact recipients and attachments.");
  }
  if (!input.recipients.every((recipient) => typeof recipient === "string")) {
    throw new Error("Email delivery readback recipients must all be email-address strings.");
  }
  const attachments = input.attachments.map((attachment) => {
    if (
      !attachment || typeof attachment !== "object"
      || typeof attachment.blockId !== "string" || typeof attachment.filename !== "string"
      || attachment.mediaType !== "image/png" || !Number.isInteger(attachment.byteLength)
      || typeof attachment.sha256 !== "string"
    ) {
      throw new Error("Email delivery readback attachments must include exact block, filename, media type, byte length, and SHA-256 metadata.");
    }
    return {
      blockId: attachment.blockId,
      filename: attachment.filename,
      mediaType: attachment.mediaType,
      byteLength: attachment.byteLength,
      sha256: attachment.sha256,
    };
  });
  const readback: EmailDeliveryReadback = {
    source: "connector_readback",
    providerMessageId: input.providerMessageId,
    readAt: input.readAt,
    version: input.version as 1,
    approvalDigest: String(input.approvalDigest ?? ""),
    payloadDigest: String(input.payloadDigest ?? ""),
    fromAddress: String(input.fromAddress ?? ""),
    recipients: [...input.recipients],
    payload: readbackPayload(input.payload),
    attachments,
  };
  const actualDigest = deliveryDigest(deliverySnapshot(readback));
  if (input.payloadDigest !== expected.payloadDigest || actualDigest !== expected.payloadDigest) {
    throw new Error("Email delivery readback does not match the approval-bound sender, recipients, body, or attachments.");
  }
  if (JSON.stringify(deliverySnapshot(readback)) !== JSON.stringify(deliverySnapshot(expected))) {
    throw new Error("Email delivery readback does not exactly match the verified email payload.");
  }
  return readback;
}
