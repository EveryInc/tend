import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AttentionDomain } from "../server/domain";
import { mobileActionConfirmation } from "../server/mobile/projection";
import { formatWorkClaimOutput } from "../server/operator";
import { AttentionStore } from "../server/store";
import { configuredApprovalAction } from "../server/workflow/approvals";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const quotedMessage = [
  "---------- Forwarded message ---------",
  "From: Original Sender <original@elsewhere.test>",
  "To: Historical Recipient <old-to@elsewhere.test>",
  "Cc: Historical Copy <old-cc@elsewhere.test>",
  "Subject: Earlier discussion",
  "",
  "Contact consultant@another.test for background.",
].join("\n");

test.each([
  {
    name: "internal forward with external people in the quoted history",
    blockType: "editable_text" as const,
    instruction: "Forward from sender@company.test to colleague@company.test, cc teammate@company.test.",
    value: `Please take a look.\n\n${quotedMessage}`,
    recipients: ["colleague@company.test", "teammate@company.test"],
  },
  {
    name: "external forward with old quoted To and Cc headers",
    blockType: "editable_text" as const,
    instruction: "Forward from sender@company.test to partner@outside.test, cc observer@outside.test.",
    value: `Contact consultant@another.test for background.\n\n${quotedMessage}`,
    recipients: ["partner@outside.test", "observer@outside.test"],
  },
  {
    name: "outbound header block with folded Cc and Bcc",
    blockType: "editable_text" as const,
    instruction: "Send the exact approved draft.",
    value: `From: sender@company.test\r\nTo: PARTNER@outside.test\r\nCc: observer@outside.test,\r\n second@outside.test\r\nBcc: private@outside.test\r\nSubject: Current draft\r\n\r\nContact body@another.test.\r\n\r\n${quotedMessage}`,
    recipients: ["partner@outside.test", "observer@outside.test", "second@outside.test", "private@outside.test"],
  },
  {
    name: "body-only draft without named recipients",
    blockType: "editable_text" as const,
    instruction: "Send the exact approved reply in the source conversation.",
    value: "Please contact body@another.test.\n\nTo: this-is-body@another.test\n\nThanks.",
    recipients: undefined,
  },
  {
    name: "source email block with original envelope headers",
    blockType: "email_thread" as const,
    instruction: "Forward the original message to partner@outside.test.",
    value: "From: original@elsewhere.test\nTo: sender@company.test\nCc: old-cc@elsewhere.test\nSubject: Original email\n\nOriginal content.",
    recipients: ["partner@outside.test"],
  },
].map(({ name, ...scenario }) => [name, scenario] as const))("approval recipients exclude quoted and body addresses: %s", async (_name, { instruction, value, recipients, blockType }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tend-approval-recipients-"));
  roots.push(root);
  const store = new AttentionStore(root);
  await store.init();
  const domain = new AttentionDomain(store);
  await domain.upsertCard("inbox", {
    id: "reply",
    title: "Review this exact message.",
    why: "Recipient reporting must reflect the outbound action.",
    sourceMailbox: "sender@company.test",
    blocks: [blockType === "email_thread"
      ? { id: "draft", type: "email_thread", text: value }
      : { id: "draft", type: "editable_text", value, editable: true }],
    actions: [{ id: "send", label: "Send reply", behavior: "approve_action", instruction,
      artifactBlockId: "draft", externalMutation: true, mailboxPolicy: "reply_from_source" }],
  });
  const approved = await domain.runCardAction("inbox", "reply", "send");
  const card = await store.readCard("inbox", "reply");
  const output = formatWorkClaimOutput("inbox", approved, { card });
  if (!("operatorGuidance" in output)) throw new Error("Missing approval receipt.");

  expect(output.operatorGuidance?.userAuthorization?.riskConfirmation?.recipients).toEqual(recipients);
  expect(mobileActionConfirmation(card, configuredApprovalAction(card, "send"))?.recipients).toEqual(recipients);
  const artifact = output.operatorGuidance?.userAuthorization?.exactApprovedArtifact;
  expect(artifact?.value ?? artifact?.text).toBe(value);
  expect(output.operatorGuidance?.userAuthorization).toMatchObject({
    scope: "tend_workflow",
    connectorAuthorization: "not_attested",
  });
});
