import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AttentionDomain } from "./server/domain";
import { CLI_COMMANDS, INTERNAL_CLI_COMMANDS } from "./server/cli/contract";
import { MissingFlagError, formatCliError } from "./server/cli/errors";
import { importLegacyAttentionCard, importLegacyInboxCard } from "./server/cli/legacyImports";
import { assertCliRuntimeMatchesLive } from "./server/cli/runtimeGuard";
import { formatWorkClaimOutput, formatWorkListOutput } from "./server/operator";
import { createLocalRuntime, resolveArtifactsDir, resolveDataDir, resolveDbPath, resolveRuntimeRoot } from "./server/runtime";

const root = path.dirname(fileURLToPath(import.meta.url));
const [command = "help", ...argv] = process.argv.slice(2);
const runtimeRoot = resolveRuntimeRoot(root);
try {
  await assertCliRuntimeMatchesLive(command, runtimeRoot, { explicitRuntime: Boolean(process.env.ATTENTION_HOME) });
} catch (error) {
  process.stderr.write(`${JSON.stringify(formatCliError(error), null, 2)}\n`);
  process.exit(1);
}
const dataDir = resolveDataDir(root);
const { store } = await createLocalRuntime(dataDir, resolveDbPath(root));
const domain = new AttentionDomain(store);

const value = (name: string) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const flag = (name: string) => argv.includes(`--${name}`);
const json = (input?: string) => input ? JSON.parse(input) : undefined;
const required = (name: string) => {
  const result = value(name);
  if (!result) throw new MissingFlagError(command, name);
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

try {
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
    output = await importLegacyAttentionCard(domain, { required, value });
    break;
  }
  case "legacy:import-inbox-card": {
    output = await importLegacyInboxCard(domain, { required, value });
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
      const sweepFeedback = work?.intent === "sweep_rejudge" && work.feedbackId ? await store.readSweepFeedback(feedId, work.feedbackId) : undefined;
      const routineActionGroup = work?.routineActionGroupId ? await store.readRoutineActionGroup(feedId, work.routineActionGroupId) : undefined;
      const feedConfig = work?.kind === "default_cleanup" ? await store.readConfig(feedId) : undefined;
      output = formatWorkClaimOutput(feedId, work, { card, feedConfig, routineActionGroup, sweepFeedback });
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
  case "work:reconcile-approved":
    output = await domain.reconcileApprovedWork(required("feed"), required("work"), required("token"), json(required("result")));
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
    output = { appRoot: root, runtimeRoot, dataDir, dbPath: resolveDbPath(root), artifactsDir: resolveArtifactsDir(root) };
    break;
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
  case "help:internal":
    output = { commands: CLI_COMMANDS, internalCommands: INTERNAL_CLI_COMMANDS };
    break;
  default:
    output = {
      commands: CLI_COMMANDS,
    };
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify(formatCliError(error), null, 2)}\n`);
  process.exit(1);
}
