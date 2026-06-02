import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AttentionDomain } from "./server/domain";
import { AttentionStore } from "./server/store";

const root = path.dirname(fileURLToPath(import.meta.url));
const store = new AttentionStore(process.env.ATTENTION_DATA_DIR ?? path.join(root, "data"));
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
    output = await domain.upsertCard(required("feed"), json(required("card")));
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
      } : {
        label: "Review disposition",
        instruction: "Reread authoritative Inbox Sweep and Gmail state, decide the disposition, and return any proposed action for review.",
      },
    });
    break;
  }
  case "card:dismiss":
    output = await domain.dismissCard(required("feed"), required("card"));
    break;
  case "card:undo-dismiss":
    output = await domain.undoDismiss(required("feed"), required("card"));
    break;
  case "work:list":
    output = await domain.listPendingWork(required("feed"), required("thread"), flag("cross-feed"));
    break;
  case "work:claim":
    output = await domain.claimWork(required("feed"), required("thread"), flag("cross-feed"));
    break;
  case "work:cancel":
    output = await domain.cancelQueuedWork(required("feed"), required("work"), value("reason"));
    break;
  case "work:complete":
    output = await domain.completeWork(required("feed"), required("work"), required("token"), json(required("result")));
    break;
  case "action:verify":
    output = await domain.verifyApprovedAction(required("feed"), required("work"), required("token"));
    break;
  case "work:fail":
    output = await domain.failWork(required("feed"), required("work"), required("token"), required("error"));
    break;
  case "policy:apply":
    output = await domain.applyPolicyRevision(required("feed"), required("content"), required("reason"), (value("source") ?? "user_instruction") as any);
    break;
  case "policy:revert":
    output = await domain.revertPolicyRevision(required("feed"), required("revision"));
    break;
  case "revision:propose":
    output = await domain.proposeRevision(required("feed"), json(required("target")), required("instruction"), required("content"));
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
  case "inspect":
    output = await domain.inspectHowFeedWorks(required("feed"));
    break;
  case "demo:seed":
    await domain.seedDemo();
    output = { ok: true };
    break;
  case "demo:clear":
    await domain.clearDemo();
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
        "card:upsert --feed <id> --card <json>",
        "legacy:import-attention-card --feed <id> --path <attention-batch-json> --card-id <id>",
        "legacy:import-inbox-card --feed inbox --path <inbox-sweep-brief-json> --card-id <id>",
        "card:dismiss --feed <id> --card <id>",
        "card:undo-dismiss --feed <id> --card <id>",
        "work:list --feed <id> --thread <id> [--cross-feed]",
        "work:claim --feed <id> --thread <id> [--cross-feed]",
        "work:cancel --feed <id> --work <id> [--reason <text>]",
        "work:complete --feed <id> --work <id> --token <token> --result <json>",
        "action:verify --feed <id> --work <id> --token <token>",
        "work:fail --feed <id> --work <id> --token <token> --error <text>",
        "policy:apply --feed <id> --content <markdown> --reason <text> [--source micro_learning]",
        "policy:revert --feed <id> --revision <id>",
        "revision:propose --feed <anchor-id> --target <json> --instruction <text> --content <markdown>",
        "global-policy:update --content <markdown>",
        "global-prompt:update --prompt <allowlisted-name.md> --content <markdown>",
        "proposal:create --feed <id> --title <text> --brief <text> --instruction <text>",
        "inspect --feed <id>",
        "demo:seed",
        "demo:clear",
      ],
    };
}

console.log(JSON.stringify(output, null, 2));
