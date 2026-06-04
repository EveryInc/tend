import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AttentionDomain } from "./server/domain";
import { formatWorkClaimOutput, formatWorkListOutput } from "./server/operator";
import { inspectRuntimeDrift, readRuntimeHandoffMarker, reconcileMissingRuntimeFiles, resolveArtifactsDir, resolveDataDir, resolveRuntimeRoot, writeRuntimeHandoffMarker } from "./server/runtime";
import { AttentionStore } from "./server/store";

const root = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolveRuntimeRoot(root);
const dataDir = resolveDataDir(root);
const store = new AttentionStore(dataDir);
const domain = new AttentionDomain(store);
await store.init();

const [command = "help", ...argv] = process.argv.slice(2);
const value = (name: string) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const flag = (name: string) => argv.includes(`--${name}`);
const json = (input?: string) => input ? JSON.parse(input) : undefined;
const required = (name: string) => {
  const result = value(name);
  if (!result) throw new Error(`Missing --${name}`);
  return result;
};
const text = async (name: string) => {
  const filename = value(`${name}-file`);
  return filename ? readFile(filename, "utf8") : required(name);
};
const structured = async (name: string) => {
  const filename = value(`${name}-file`);
  return filename ? JSON.parse(await readFile(filename, "utf8")) : json(required(name));
};

let output: unknown;
switch (command) {
  case "state":
    output = await store.readWorkspace(value("feed"));
    break;
  case "setup:detect-monologue":
    output = await domain.detectLocalMonologue();
    break;
  case "feed:create":
    output = await domain.createFeedFromBrief(required("brief"), value("thread") ?? null);
    break;
  case "feed:bind":
    output = await domain.bindFeed(required("feed"), required("thread"));
    break;
  case "feed:archive":
    await domain.archiveFeed(required("feed"));
    output = { ok: true };
    break;
  case "feed:heartbeat:propose":
    output = await domain.proposeHeartbeat(required("feed"), required("cadence"));
    break;
  case "feed:heartbeat:installed":
    output = await domain.recordHeartbeatInstalled(required("feed"), required("automation"));
    break;
  case "source:add":
    output = await domain.addSourceFromBrief(required("feed"), required("brief"));
    break;
  case "source:remove":
    await domain.removeSource(required("feed"), required("source"));
    output = { ok: true };
    break;
  case "source:record-run":
    output = await domain.recordSourceRun(required("feed"), required("source"), json(required("snapshots")), json(required("judgments")), json(required("checkpoint")), value("work"));
    break;
  case "sweep:record-batch":
    output = await domain.recordSweepBatch(required("feed"), json(required("runs")), value("work"));
    break;
  case "sweep:rejudge":
    output = await domain.recordSweepRejudgment(required("feed"), required("feedback"), json(required("ordered-cards")), json(required("removed-cards")));
    break;
  case "source:import-json-file": {
    const sourcePath = required("path");
    output = await domain.recordSourceRun(required("feed"), required("source"), [JSON.parse(await readFile(sourcePath, "utf8"))], [], { importedFrom: sourcePath, importedAt: new Date().toISOString() }, value("work"));
    break;
  }
  case "source:import-file": {
    const sourcePath = required("path");
    const content = await readFile(sourcePath, "utf8");
    output = await domain.recordSourceRun(required("feed"), required("source"), [{ format: "text", content }], [], { importedFrom: sourcePath, importedAt: new Date().toISOString() }, value("work"));
    break;
  }
  case "card:upsert":
    output = await domain.upsertCard(required("feed"), await structured("card"));
    break;
  case "routine:upsert":
    output = await domain.upsertRoutineActionGroup(required("feed"), json(required("group")));
    break;
  case "routine:approve":
    output = await domain.approveRoutineActionGroup(required("feed"), required("group"));
    break;
  case "legacy:import-attention-card": {
    const batch = JSON.parse(await readFile(required("path"), "utf8")) as {
      cards?: Array<{
        id: string;
        title: string;
        originalFrame: string;
        source?: { label?: string; kind?: string; timestamp?: string };
        judge?: { shouldSurface?: boolean; whyCare?: string; rationale?: string; evidence?: string[]; nextStep?: string; actionTarget?: string };
      }>;
    };
    const legacy = batch.cards?.find((card) => card.id === required("card-id"));
    if (!legacy) throw new Error("Legacy attention card not found.");
    if (!legacy.judge?.shouldSurface) throw new Error("Refusing to import a legacy card that did not clear its source judge.");
    output = await domain.upsertCard(required("feed"), {
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
    break;
  }
  case "legacy:import-inbox-card": {
    const brief = JSON.parse(await readFile(required("path"), "utf8")) as {
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
    const cardId = required("card-id");
    const draft = brief.drafts?.find((card) => card.id === cardId);
    const decision = brief.decisions?.find((card) => card.id === cardId);
    const legacy = draft ?? decision;
    if (!legacy) throw new Error("Legacy Inbox Sweep card not found.");
    output = await domain.upsertCard(required("feed"), {
      id: `imported-${legacy.id}`,
      title: legacy.subject,
      eyebrow: `Inbox · ${legacy.pill}`,
      why: legacy.why,
      ...(value("mailbox") ? { sourceMailbox: value("mailbox") } : {}),
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
    break;
  }
  case "card:dismiss":
    output = await domain.dismissCard(required("feed"), required("card"));
    break;
  case "card:undo-dismiss":
    output = await domain.undoDismiss(required("feed"), required("card"));
    break;
  case "card:return-to-review":
    output = await domain.returnCardToReview(required("feed"), required("card"));
    break;
  case "work:list":
    {
      const feedId = required("feed");
      output = formatWorkListOutput(feedId, await domain.listPendingWork(feedId, required("thread"), flag("cross-feed")));
    }
    break;
  case "work:claim":
    {
      const feedId = required("feed");
      const work = await domain.claimWork(feedId, required("thread"), flag("cross-feed"));
      const card = work && !work.cardId.startsWith("__") ? await store.readCard(feedId, work.cardId) : undefined;
      output = formatWorkClaimOutput(feedId, work, card);
    }
    break;
  case "work:cancel":
    output = await domain.cancelQueuedWork(required("feed"), required("work"), value("reason"));
    break;
  case "work:edit":
    output = await domain.updateQueuedWorkInstruction(required("feed"), required("work"), required("instruction"));
    break;
  case "work:complete":
    output = await domain.completeWork(required("feed"), required("work"), required("token"), json(required("result")));
    break;
  case "action:verify":
    output = await domain.verifyApprovedAction(required("feed"), required("work"), required("token"), value("mailbox"));
    break;
  case "work:fail":
    output = await domain.failWork(required("feed"), required("work"), required("token"), required("error"));
    break;
  case "work:block":
    output = await domain.blockApprovedWork(required("feed"), required("work"), required("token"), required("error"));
    break;
  case "work:retry":
    output = await domain.retryApprovedWork(required("feed"), required("work"));
    break;
  case "policy:apply":
    output = await domain.applyPolicyRevision(required("feed"), await text("content"), required("reason"), (value("source") ?? "user_instruction") as any);
    break;
  case "policy:revert":
    output = await domain.revertPolicyRevision(required("feed"), required("revision"));
    break;
  case "revision:propose":
    output = await domain.proposeRevision(required("feed"), json(required("target")), required("instruction"), await text("content"), (value("source") ?? "voice") as any);
    break;
  case "revision:update":
    output = await domain.updateRevisionProposal(required("proposal"), await text("content"));
    break;
  case "revision:reject":
    output = await domain.rejectRevisionProposal(required("proposal"));
    break;
  case "learning:request":
    output = await domain.queueCompound(required("feed"));
    break;
  case "global-policy:update":
    await domain.updateGlobalPolicy(required("content"));
    output = { ok: true };
    break;
  case "global-prompt:update":
    await domain.updateGlobalPrompt(required("prompt"), required("content"));
    output = { ok: true };
    break;
  case "proposal:create":
    output = await domain.createImprovementCard(required("feed"), required("title"), required("brief"), required("instruction"));
    break;
  case "feedback:record":
    output = await domain.recordAppFeedback(required("feed"), required("title"), required("detail"), value("source-thread"));
    break;
  case "feedback:list":
    output = await store.readAppFeedback();
    break;
  case "feedback:resolve":
    output = await domain.resolveAppFeedback(required("feedback"), required("resolution"));
    break;
  case "runtime:where":
    output = { appRoot: root, runtimeRoot, dataDir, artifactsDir: resolveArtifactsDir(root) };
    break;
  case "runtime:mark-handoff":
    output = await writeRuntimeHandoffMarker(runtimeRoot, dataDir, required("legacy-data"));
    break;
  case "runtime:reconcile": {
    const legacyDataDir = required("legacy-data");
    const marker = await readRuntimeHandoffMarker(runtimeRoot);
    const since = value("since") ?? (marker?.legacyDataDirs.includes(path.resolve(legacyDataDir)) ? marker.createdAt : undefined);
    output = flag("apply-missing")
      ? await reconcileMissingRuntimeFiles(dataDir, legacyDataDir, since)
      : await inspectRuntimeDrift(dataDir, legacyDataDir, since);
    break;
  }
  case "inspect":
    output = await domain.inspectHowFeedWorks(required("feed"));
    break;
  case "demo:seed":
    await domain.seedDemo(value("feed"));
    output = { ok: true };
    break;
  case "demo:clear":
    await domain.clearDemo(value("feed"));
    output = { ok: true };
    break;
  default:
    output = {
      commands: [
        "state [--feed inbox]",
        "setup:detect-monologue",
        "feed:create --brief <plain-English brief> [--thread <current Codex thread id>]",
        "feed:bind --feed <id> --thread <Codex thread id>",
        "feed:archive --feed <id>",
        "feed:heartbeat:propose --feed <id> --cadence <plain-English cadence>",
        "source:add --feed <id> --brief <plain-English source recipe>",
        "source:remove --feed <id> --source <id>",
        "source:record-run --feed <id> --source <id> --snapshots <json> --judgments <json> --checkpoint <json> [--work <recollection-work-id>]",
        "sweep:record-batch --feed <id> --runs <json-array> [--work <recollection-work-id>]",
        "sweep:rejudge --feed <id> --feedback <id> --ordered-cards <json-array> --removed-cards <json-array>",
        "source:import-json-file --feed <id> --source <id> --path <local-json-file>",
        "source:import-file --feed <id> --source <id> --path <local-text-or-jsonl-file>",
        "card:upsert --feed <id> (--card <json> | --card-file <path>)",
        "routine:upsert --feed <id> --group <json>",
        "routine:approve --feed <id> --group <id>",
        "legacy:import-attention-card --feed <id> --path <attention-batch-json> --card-id <id>",
        "legacy:import-inbox-card --feed inbox --path <inbox-sweep-brief-json> --card-id <id> [--mailbox <received-at-email>]",
        "card:dismiss --feed <id> --card <id>",
        "card:undo-dismiss --feed <id> --card <id>",
        "card:return-to-review --feed <id> --card <id>",
        "work:list --feed <id> --thread <id> [--cross-feed]",
        "work:claim --feed <id> --thread <id> [--cross-feed]",
        "work:cancel --feed <id> --work <id> [--reason <text>]",
        "work:edit --feed <id> --work <id> --instruction <text>",
        "work:complete --feed <id> --work <id> --token <token> --result <json>",
        "action:verify --feed <id> --work <id> --token <token> [--mailbox <authenticated-gmail-email>]",
        "work:fail --feed <id> --work <id> --token <token> --error <text>",
        "work:block --feed <id> --work <id> --token <token> --error <text>",
        "work:retry --feed <id> --work <id>",
        "policy:apply --feed <id> (--content <markdown> | --content-file <path>) --reason <text> [--source micro_learning]",
        "policy:revert --feed <id> --revision <id>",
        "revision:propose --feed <anchor-id> --target <json> --instruction <text> (--content <markdown> | --content-file <path>) [--source compound]",
        "revision:update --proposal <id> (--content <markdown> | --content-file <path>)",
        "revision:reject --proposal <id>",
        "learning:request --feed <id>",
        "global-policy:update --content <markdown>",
        "global-prompt:update --prompt <allowlisted-name.md> --content <markdown>",
        "proposal:create --feed <id> --title <text> --brief <text> --instruction <text>",
        "feedback:record --feed <id> --title <text> --detail <text> [--source-thread <Codex thread id>]",
        "feedback:list",
        "feedback:resolve --feedback <id> --resolution <text>",
        "runtime:where",
        "runtime:mark-handoff --legacy-data <retired-checkout-data-dir>",
        "runtime:reconcile --legacy-data <retired-checkout-data-dir> [--since <ISO timestamp>] [--apply-missing]",
        "inspect --feed <id>",
        "demo:seed [--feed inbox]",
        "demo:clear [--feed inbox]",
      ],
    };
}

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
