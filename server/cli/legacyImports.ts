import { readFile } from "node:fs/promises";
import type { AttentionDomain } from "../domain";

type ArgReader = {
  required(name: string): string;
  value(name: string): string | undefined;
};

export async function importLegacyAttentionCard(domain: AttentionDomain, args: ArgReader): Promise<unknown> {
  const batch = JSON.parse(await readFile(args.required("path"), "utf8")) as {
    cards?: Array<{
      id: string;
      title: string;
      originalFrame: string;
      source?: { label?: string; kind?: string; timestamp?: string };
      judge?: { shouldSurface?: boolean; whyCare?: string; rationale?: string; evidence?: string[]; nextStep?: string; actionTarget?: string };
    }>;
  };
  const legacy = batch.cards?.find((card) => card.id === args.required("card-id"));
  if (!legacy) throw new Error("Legacy attention card not found.");
  if (!legacy.judge?.shouldSurface) throw new Error("Refusing to import a legacy card that did not clear its source judge.");
  return domain.upsertCard(args.required("feed"), {
    id: `imported-${legacy.id}`,
    title: legacy.title,
    eyebrow: "Company Attention · Imported evidence",
    why: legacy.judge.whyCare ?? legacy.judge.rationale ?? "This imported evidence deserves review.",
    blocks: [
      { id: "brief", type: "memo", label: "Brief", text: legacy.originalFrame },
      { id: "evidence", type: "evidence", label: "Evidence", items: legacy.judge.evidence ?? [] },
      { id: "provenance", type: "receipt", label: "Provenance", text: `${legacy.source?.label ?? "Imported Attention Workbench"} · ${legacy.source?.kind ?? "unknown"} · ${legacy.source?.timestamp ?? "timestamp unavailable"}` },
    ],
    proposedAction: legacy.judge.nextStep ? {
      label: legacy.judge.nextStep,
      instruction: `${legacy.judge.nextStep}${legacy.judge.actionTarget ? ` Target: ${legacy.judge.actionTarget}.` : ""}`,
    } : undefined,
    actions: legacy.judge.nextStep ? [{
      id: "take-next-step",
      label: legacy.judge.nextStep,
      behavior: "queue_instruction",
      instruction: `${legacy.judge.nextStep}${legacy.judge.actionTarget ? ` Target: ${legacy.judge.actionTarget}.` : ""}`,
      variant: "primary",
    }] : undefined,
  });
}

export async function importLegacyInboxCard(domain: AttentionDomain, args: ArgReader): Promise<unknown> {
  const brief = JSON.parse(await readFile(args.required("path"), "utf8")) as {
    drafts?: Array<{
      id: string;
      from: { name: string };
      subject: string;
      pill: string;
      why: string;
      originalEmailSummary: string;
      draft: { body: string };
    }>;
    decisions?: Array<{
      id: string;
      from: { name: string };
      subject: string;
      pill: string;
      why: string;
      originalEmailSummary?: string;
    }>;
  };
  const cardId = args.required("card-id");
  const draft = brief.drafts?.find((card) => card.id === cardId);
  const decision = brief.decisions?.find((card) => card.id === cardId);
  const legacy = draft ?? decision;
  if (!legacy) throw new Error("Legacy Inbox Sweep card not found.");
  return domain.upsertCard(args.required("feed"), {
    id: `imported-${legacy.id}`,
    title: legacy.subject,
    eyebrow: `Inbox · ${legacy.pill}`,
    why: legacy.why,
    ...(args.value("mailbox") ? { sourceMailbox: args.value("mailbox") } : {}),
    blocks: [
      { id: "brief", type: "rich_text", label: "Brief", text: legacy.originalEmailSummary ?? legacy.why },
      { id: "provenance", type: "receipt", label: "Parallel comparison", text: `Imported from the current Inbox Sweep card for ${legacy.from.name}. Inbox Sweep remains authoritative during migration.` },
      ...(draft ? [{ id: "draft", type: "editable_text" as const, label: "Suggested reply", value: draft.draft.body, editable: true }] : []),
    ],
    proposedAction: draft ? {
      label: "Send this reply",
      instruction: "Reread authoritative Inbox Sweep and Gmail state, verify the exact current approved draft snapshot is unchanged, then send the reply and record the outcome.",
      artifactBlockId: "draft",
      externalMutation: true,
      mailboxPolicy: "reply_from_source",
    } : {
      label: "Review disposition",
      instruction: "Reread authoritative Inbox Sweep and Gmail state, decide the disposition, and return any proposed action for review.",
    },
    actions: draft ? [
      { id: "archive", label: "Archive", behavior: "default_cleanup", shortcut: "x" },
      { id: "send-reply", label: "Send reply", behavior: "approve_action", instruction: "Reread authoritative Inbox Sweep and Gmail state, verify the exact current approved draft snapshot is unchanged, then send the reply and record the outcome.", artifactBlockId: "draft", externalMutation: true, mailboxPolicy: "reply_from_source", variant: "primary", shortcut: "s" },
    ] : [
      { id: "archive", label: "Archive", behavior: "default_cleanup", shortcut: "x" },
      { id: "review-with-codex", label: "Review with Codex", behavior: "queue_instruction", instruction: "Reread authoritative Inbox Sweep and Gmail state, decide the disposition, and return any proposed action for review.", variant: "primary", shortcut: "r" },
    ],
  });
}
