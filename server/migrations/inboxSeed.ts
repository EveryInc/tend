import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FeedConfig } from "../../shared/types";
import type { SourceRecord, SourceRepository } from "../repositories/sources";
import type { TextDocumentRepository } from "../repositories/textDocuments";
import {
  DEFAULT_FEED_JUDGE_LAYER,
  INBOX_JUDGE_LAYER,
  INBOX_POLICY,
  INBOX_PURPOSE,
  INBOX_SEED_VERSION,
  LEGACY_INBOX_POLICY,
  LEGACY_INBOX_PURPOSE,
  inboxRecipe,
  legacyInboxRecipe,
} from "../templates";
import { isoNow, readJson, writeJson, writeText } from "../util";

interface InboxSeedMigrationContext {
  dataDir: string;
  textDocuments: TextDocumentRepository;
  sources: SourceRepository;
  readConfig(): Promise<FeedConfig>;
  writeConfig(config: FeedConfig): Promise<void>;
  appendEvent(detail: { inboxVersion: number; changed: string[] }): Promise<void>;
  readMigrationEvent(): Promise<{ inboxVersion: number; changed: string[] } | null>;
}

interface InboxSeedMarker {
  inboxVersion?: number;
  targetInboxVersion?: number;
  status?: "started" | "completed";
  changed?: string[];
}

function sourceMatches(record: SourceRecord | undefined, expected: SourceRecord): boolean {
  return Boolean(
    record
    && record.recipe.id === expected.recipe.id
    && record.recipe.name === expected.recipe.name
    && record.recipe.filename === expected.recipe.filename
    && record.recipe.checkpointFilename === expected.recipe.checkpointFilename
    && record.recipe.summary === expected.recipe.summary
    && record.content === expected.content,
  );
}

export async function migrateInboxSeed(context: InboxSeedMigrationContext): Promise<void> {
  const markerPath = path.join(context.dataDir, "feeds", "inbox", "seed.json");
  const marker = existsSync(markerPath) ? await readJson<InboxSeedMarker>(markerPath) : null;
  if ((marker?.inboxVersion ?? 0) >= INBOX_SEED_VERSION && marker?.status !== "started") return;

  const priorEvent = await context.readMigrationEvent();
  const config = await context.readConfig();
  const legacyFeedMarkdown = `# Inbox\n\n${LEGACY_INBOX_PURPOSE}\n`;
  const currentFeedMarkdown = `# Inbox\n\n${INBOX_PURPOSE}\n`;
  const feedMarkdownPath = path.join(context.dataDir, "feeds", "inbox", "feed.md");
  const feedMarkdown = existsSync(feedMarkdownPath) ? await readFile(feedMarkdownPath, "utf8") : null;
  const policyKey = "feeds/inbox/policy.md";
  const judgeKey = "feeds/inbox/prompts/judge.md";
  const policy = await context.textDocuments.has(policyKey) ? await context.textDocuments.read(policyKey) : null;
  const judge = await context.textDocuments.has(judgeKey) ? await context.textDocuments.read(judgeKey) : null;
  const legacySource = legacyInboxRecipe();
  const currentSource = inboxRecipe();
  const source = (await context.sources.list("inbox")).find((record) => record.recipe.id === "gmail-inbox");

  const discoveredChanges = [
    ...(config.purpose === LEGACY_INBOX_PURPOSE ? ["purpose"] : []),
    ...(feedMarkdown === legacyFeedMarkdown ? ["feed-markdown"] : []),
    ...(policy === LEGACY_INBOX_POLICY ? ["policy"] : []),
    ...(judge === DEFAULT_FEED_JUDGE_LAYER ? ["judge-layer"] : []),
    ...(sourceMatches(source, { recipe: legacySource.recipe, content: legacySource.markdown, checkpoint: source?.checkpoint }) ? ["gmail-recipe"] : []),
  ];
  const journalChanges = marker?.status === "started" && marker.targetInboxVersion === INBOX_SEED_VERSION && Array.isArray(marker.changed)
    ? marker.changed.filter((item): item is string => typeof item === "string")
    : null;
  const changed = priorEvent?.changed ?? journalChanges ?? discoveredChanges;
  if (!priorEvent && !journalChanges) {
    await writeJson(markerPath, {
      targetInboxVersion: INBOX_SEED_VERSION,
      status: "started",
      startedAt: isoNow(),
      changed,
    });
  }

  if (config.purpose === LEGACY_INBOX_PURPOSE) {
    config.purpose = INBOX_PURPOSE;
    await context.writeConfig(config);
  }
  if (feedMarkdown === legacyFeedMarkdown) await writeText(feedMarkdownPath, currentFeedMarkdown);

  // Rewriting known current values is intentional: it repairs a stale filesystem mirror after a
  // prior primary-first write failed, while exact-match guards preserve user customizations.
  if (policy === LEGACY_INBOX_POLICY || policy === INBOX_POLICY) await context.textDocuments.write(policyKey, INBOX_POLICY);
  if (judge === DEFAULT_FEED_JUDGE_LAYER || judge === INBOX_JUDGE_LAYER) await context.textDocuments.write(judgeKey, INBOX_JUDGE_LAYER);
  if (
    source
    && (
      sourceMatches(source, { recipe: legacySource.recipe, content: legacySource.markdown, checkpoint: source.checkpoint })
      || sourceMatches(source, { recipe: currentSource.recipe, content: currentSource.markdown, checkpoint: source.checkpoint })
    )
  ) {
    await context.sources.write("inbox", currentSource.recipe, currentSource.markdown, source.checkpoint);
  }

  if (!priorEvent) await context.appendEvent({ inboxVersion: INBOX_SEED_VERSION, changed });
  await writeJson(markerPath, {
    inboxVersion: INBOX_SEED_VERSION,
    status: "completed",
    appliedAt: isoNow(),
    migrated: true,
    changed,
    ...(priorEvent ? { recoveredFromEvent: true } : {}),
  });
}
