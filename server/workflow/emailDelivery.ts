import type {
  Card,
  CardBlock,
  EmailDeliveryAttachment,
  EmailDeliveryReadback,
  EmailMimePayload,
  LegacyEmailDeliveryReadback,
  LegacyPreparedEmailDelivery,
  PreparedEmailDelivery,
  ProposedAction,
  StoredPreparedEmailDelivery,
  VerifiedLegacyEmailDeliveryReadback,
} from "../../shared/types";
import { actionEmailRecipients } from "../../shared/emailRecipients";
import { digest } from "../util";

const BUILTIN_SENDER_IDENTITIES = Object.freeze({
  "dan@every.to": "Dan Shipper",
});

export interface CanonicalSenderIdentity {
  displayName: string;
  address: string;
  fromHeader: string;
}

function hasHeaderControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029;
  });
}

function safeMailbox(value: string): string {
  // This gate is reached only after verifySourceMailbox validates a Gmail account; Gmail mailbox
  // addresses are provider-canonicalized case-insensitively.
  const address = value.trim().toLowerCase();
  if (
    hasHeaderControl(value)
    || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(address)
  ) {
    throw new Error("Canonical sender identity requires a safe email address without header controls.");
  }
  return address;
}

function safeDisplayName(value: string): string {
  const displayName = value.trim();
  if (!displayName) throw new Error("Canonical sender identity requires a non-empty display name.");
  if (hasHeaderControl(value)) {
    throw new Error("Canonical sender display name cannot contain control characters.");
  }
  // Our strict readback parser intentionally supports only one mailbox. Reject RFC address-list,
  // group and comment syntax instead of letting a configured name make a multi-mailbox header
  // appear to be one display name.
  if (/[()<>[\]:;@,\\"]/u.test(displayName)) {
    throw new Error("Canonical sender display name cannot contain RFC address syntax.");
  }
  return displayName;
}

function formatDisplayName(displayName: string): string {
  if (/^[A-Za-z0-9]+(?:[ .'-][A-Za-z0-9]+)*$/.test(displayName)) return displayName;
  return `"${displayName.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function normalizedIdentities(values: Readonly<Record<string, string>>, label: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [mailbox, displayName] of Object.entries(values)) {
    if (typeof displayName !== "string") throw new Error(`${label} values must be display-name strings.`);
    const address = safeMailbox(mailbox);
    const normalizedName = safeDisplayName(displayName);
    if (result[address] && result[address] !== normalizedName) {
      throw new Error(`${label} contains conflicting identities for ${address}.`);
    }
    result[address] = normalizedName;
  }
  return result;
}

function configuredSenderIdentities(): Record<string, string> {
  const raw = process.env.ATTENTION_EMAIL_SENDER_IDENTITIES?.trim();
  let configured: Record<string, string> = {};
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("ATTENTION_EMAIL_SENDER_IDENTITIES must be a JSON object mapping mailboxes to display names.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("ATTENTION_EMAIL_SENDER_IDENTITIES must be a JSON object mapping mailboxes to display names.");
    }
    configured = normalizedIdentities(parsed as Record<string, string>, "ATTENTION_EMAIL_SENDER_IDENTITIES");
  }
  const builtin = normalizedIdentities(BUILTIN_SENDER_IDENTITIES, "Built-in sender identities");
  for (const [address, displayName] of Object.entries(builtin)) {
    if (configured[address] && configured[address] !== displayName) {
      throw new Error(`ATTENTION_EMAIL_SENDER_IDENTITIES cannot override the canonical identity for ${address}.`);
    }
  }
  return { ...configured, ...builtin };
}

export function canonicalSenderIdentity(
  mailbox: string,
  identities?: Readonly<Record<string, string>>,
): CanonicalSenderIdentity {
  const address = safeMailbox(mailbox);
  const names = identities
    ? normalizedIdentities(identities, "Sender identities")
    : configuredSenderIdentities();
  const configuredName = names[address];
  if (!configuredName) {
    throw new Error(
      `No canonical sender identity is configured for ${address}. Configure ATTENTION_EMAIL_SENDER_IDENTITIES; do not guess a display name.`,
    );
  }
  const displayName = safeDisplayName(configuredName);
  return {
    displayName,
    address,
    fromHeader: `${formatDisplayName(displayName)} <${address}>`,
  };
}

function deliveredSenderIdentity(value: unknown): { displayName: string; address: string; header: string } {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Email delivery readback must include the connector's actual delivered From header.");
  }
  if (hasHeaderControl(value)) {
    throw new Error("Email delivered From header contains forbidden control characters.");
  }
  const header = value.trim();
  const match = header.match(/^(.+?)\s*<\s*([^<>\s]+)\s*>$/);
  if (!match) {
    throw new Error("Email delivered From header must include a display name and address.");
  }
  const namePart = match[1].trim();
  let displayName: string;
  if (namePart.startsWith('"') || namePart.endsWith('"')) {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(namePart)) {
      throw new Error("Email delivered From header has an invalid quoted display name.");
    }
    displayName = namePart.slice(1, -1).replace(/\\(.)/g, "$1");
  } else {
    if (namePart.includes('"')) throw new Error("Email delivered From header has an invalid display name.");
    displayName = namePart;
  }
  return { displayName: safeDisplayName(displayName), address: safeMailbox(match[2]), header };
}

function validateDeliveredSender(value: unknown, canonicalSender: CanonicalSenderIdentity): string {
  const deliveredSender = deliveredSenderIdentity(value);
  if (
    deliveredSender.address !== canonicalSender.address
    || deliveredSender.displayName !== canonicalSender.displayName
  ) {
    throw new Error(
      `Email delivered From header must identify ${canonicalSender.fromHeader}; got ${deliveredSender.header}.`,
    );
  }
  return deliveredSender.header;
}

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

function deliveryDigest(input: object): string {
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
  const sender = canonicalSenderIdentity(input.verifiedMailbox);
  const preparedWithoutDigest: Omit<PreparedEmailDelivery, "payloadDigest"> = {
    version: 2,
    approvalDigest: input.approvalDigest,
    fromAddress: sender.address,
    fromHeader: sender.fromHeader,
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
  if (/<pre\b|<[^>]*\s(?:style|(?:max-)?width)\s*=/i.test(html.body.content)) {
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
    fromHeader: readback.fromHeader,
    recipients: readback.recipients,
    payload: readback.payload,
    attachments: readback.attachments,
  };
}

function legacyDeliverySnapshot(readback: LegacyPreparedEmailDelivery): Omit<LegacyPreparedEmailDelivery, "payloadDigest"> {
  return {
    version: readback.version,
    approvalDigest: readback.approvalDigest,
    fromAddress: readback.fromAddress,
    recipients: readback.recipients,
    payload: readback.payload,
    attachments: readback.attachments,
  };
}

interface ParsedReadback {
  source: "connector_readback";
  providerMessageId: string;
  readAt: string;
  version: unknown;
  approvalDigest: string;
  payloadDigest: string;
  fromAddress: string;
  fromHeader: string;
  recipients: string[];
  payload: EmailMimePayload;
  attachments: EmailDeliveryAttachment[];
  deliveredFromHeader: string;
}

function parseReadback(value: unknown, canonicalSender: CanonicalSenderIdentity): ParsedReadback {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Email completion requires a connector delivery readback for the exact verified payload.");
  }
  const input = value as Partial<EmailDeliveryReadback> & Partial<VerifiedLegacyEmailDeliveryReadback>;
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
  const deliveredFromHeader = validateDeliveredSender(input.deliveredFromHeader, canonicalSender);
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
  return {
    source: "connector_readback",
    providerMessageId: input.providerMessageId,
    readAt: input.readAt,
    version: input.version,
    approvalDigest: String(input.approvalDigest ?? ""),
    payloadDigest: String(input.payloadDigest ?? ""),
    fromAddress: String(input.fromAddress ?? ""),
    fromHeader: String(input.fromHeader ?? ""),
    recipients: [...input.recipients],
    payload: readbackPayload(input.payload),
    attachments,
    deliveredFromHeader,
  };
}

export function validateEmailDeliveryReadback(
  expected: StoredPreparedEmailDelivery,
  value: unknown,
): EmailDeliveryReadback {
  if (expected.version !== 2) {
    throw new Error("Legacy email delivery preparation has no canonical sender identity. Rerun action:verify before any send or completion.");
  }
  const canonicalSender = canonicalSenderIdentity(expected.fromAddress);
  if (expected.fromHeader !== canonicalSender.fromHeader) {
    throw new Error("Canonical sender identity changed after verification. Rerun action:verify before any send or completion.");
  }
  const input = parseReadback(value, canonicalSender);
  const readback: EmailDeliveryReadback = {
    source: input.source,
    providerMessageId: input.providerMessageId,
    readAt: input.readAt,
    version: input.version as 2,
    approvalDigest: input.approvalDigest,
    payloadDigest: input.payloadDigest,
    fromAddress: input.fromAddress,
    fromHeader: input.fromHeader,
    recipients: input.recipients,
    payload: input.payload,
    attachments: input.attachments,
    deliveredFromHeader: input.deliveredFromHeader,
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

export function validateLegacyEmailDeliveryIdentityReadback(
  expected: LegacyPreparedEmailDelivery,
  persisted: LegacyEmailDeliveryReadback,
  value: unknown,
): VerifiedLegacyEmailDeliveryReadback {
  const canonicalSender = canonicalSenderIdentity(expected.fromAddress);
  if (persisted.deliveredFromHeader) {
    validateDeliveredSender(persisted.deliveredFromHeader, canonicalSender);
  }
  const expectedDigest = deliveryDigest(legacyDeliverySnapshot(expected));
  if (
    expectedDigest !== expected.payloadDigest
    || persisted.payloadDigest !== expected.payloadDigest
    || JSON.stringify(legacyDeliverySnapshot(persisted)) !== JSON.stringify(legacyDeliverySnapshot(expected))
    || persisted.source !== "connector_readback"
    || typeof persisted.providerMessageId !== "string"
    || !persisted.providerMessageId.trim()
    || typeof persisted.readAt !== "string"
    || !Number.isFinite(Date.parse(persisted.readAt))
  ) {
    throw new Error("Persisted legacy email delivery receipt does not match its approval-bound preparation.");
  }
  const input = parseReadback(value, canonicalSender);
  const readback: VerifiedLegacyEmailDeliveryReadback = {
    source: input.source,
    providerMessageId: input.providerMessageId,
    readAt: input.readAt,
    version: input.version as 1,
    approvalDigest: input.approvalDigest,
    payloadDigest: input.payloadDigest,
    fromAddress: input.fromAddress,
    recipients: input.recipients,
    payload: input.payload,
    attachments: input.attachments,
    deliveredFromHeader: input.deliveredFromHeader,
  };
  const actualDigest = deliveryDigest(legacyDeliverySnapshot(readback));
  if (
    input.version !== 1
    || input.payloadDigest !== expected.payloadDigest
    || actualDigest !== expected.payloadDigest
    || JSON.stringify(legacyDeliverySnapshot(readback)) !== JSON.stringify(legacyDeliverySnapshot(expected))
    || readback.providerMessageId !== persisted.providerMessageId
  ) {
    throw new Error("Legacy email delivery identity readback does not match the already delivered provider message.");
  }
  return readback;
}
