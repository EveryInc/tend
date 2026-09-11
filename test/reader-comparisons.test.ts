import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AttentionDomain } from "../server/domain";
import { ReaderExecutionError, type ReaderAdapter } from "../server/readerAdapters";
import { ReaderRunner, readerHash } from "../server/readers";
import { AttentionStore } from "../server/store";
import { apiRoutes } from "../server/routes/api";
import { groupReadingCards } from "../shared/readingGroups";
import type { ReaderConfig } from "../shared/readers";
import type { Card, SourceRun } from "../shared/types";
import { currentReadingPreference } from "../src/feed/selectors";

const feedId = "company-attention";
const packet = "Frozen fixture instructions and complete source material.\n";
const promptSha256 = readerHash("Frozen fixture instructions.");
const configs: ReaderConfig[] = [
  { id: "first", label: "First reader", adapter: "codex", model: "codex-fixture", effort: "high" },
  { id: "second", label: "Second reader", adapter: "claude", model: "claude-fixture", effort: "high" },
];
const fixtures: Array<{ root: string; runner: ReaderRunner }> = [];
const member = (card: Card) => ({ cardId: card.id, contentRevision: card.reading!.contentRevision });

async function setup(options: { retryPacket?: string; retryPrompt?: string; omitPrompt?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tend-reader-comparison-"));
  const store = new AttentionStore(path.join(root, "data"));
  await store.init();
  const domain = new AttentionDomain(store);
  const calls: string[] = [];
  let secondAttempts = 0;
  const adapter: ReaderAdapter = async (config) => {
    calls.push(config.id);
    if (config.id === "second" && secondAttempts++ === 0) throw new ReaderExecutionError("Fixture login expired.", "Private failed attempt.");
    const output = { flags: [
      { id: "main", title: `Main observation by ${config.id}`, face: `Exact main text by ${config.id}.` },
      { id: "aside", title: `Other observation by ${config.id}`, face: `Exact other text by ${config.id}.` },
    ] };
    return { output, rawOutput: JSON.stringify(output), actualModel: config.model };
  };
  const runner = new ReaderRunner(store, { adapters: { codex: adapter, claude: adapter }, timeoutMs: 10_000 });
  fixtures.push({ root, runner });
  const original: SourceRun = { id: "original-attempt", feedId, sourceId: "fixture-source", snapshots: 1, judgments: [], completedAt: new Date().toISOString() };
  const retry: SourceRun = { ...original, id: "retry-attempt" };
  for (const run of [original, retry]) await store.writeRun(run);
  await runner.start({ feedId, sourceRunId: original.id, packet, readers: configs, ...(!options.omitPrompt ? { promptSha256 } : {}) });
  await runner.waitForRun(feedId, original.id);
  await runner.start({ feedId, sourceRunId: retry.id, packet: options.retryPacket ?? packet, readers: [configs[1]],
    ...(!options.omitPrompt ? { promptSha256: options.retryPrompt ?? promptSha256 } : {}) });
  await runner.waitForRun(feedId, retry.id);
  await domain.recordSweepBatch(feedId, [original.id, retry.id]);
  const publish = async (run: SourceRun, readerId: string, draftId: string, topicKey: string, id: string) => domain.upsertCard(feedId, {
    id, title: `${draftId === "main" ? "Main" : "Other"} observation by ${readerId}`,
    why: `Exact ${draftId === "main" ? "main" : "other"} text by ${readerId}.`, blocks: [], sourceRunIds: [run.id],
    reading: { runId: run.id, readerId, draftId, topicKey },
  });
  const first = await publish(original, "first", "main", "same-moment", "first-main");
  const second = await publish(retry, "second", "main", "same-moment", "second-main");
  const aside = await publish(retry, "second", "aside", "other-moment", "second-aside");
  const input = { id: "retry-comparison", topicKey: "same-moment", runIds: [original.id, retry.id], members: [member(first), member(second)] };
  return { root, store, domain, runner, original, retry, first, second, aside, input, calls, publish };
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.runner.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

describe("explicit reader retry comparisons", () => {
  test("links matching moments without replaying a provider or changing attempt/card provenance", async () => {
    const { domain, store, original, retry, first, second, input, calls } = await setup();
    const beforeRuns = await Promise.all([original, retry].map((run) => store.readRun(feedId, run.id)));
    const beforeCards = await store.listCards(feedId);
    expect(groupReadingCards(beforeCards.filter((card) => card.reading))).toHaveLength(3);
    const result = await domain.linkReadingComparison(feedId, input);
    const feed = await store.readFeed(feedId);
    const groups = groupReadingCards(feed.cards.filter((card) => card.reading), feed.readingComparisons);
    expect(groups).toHaveLength(2);
    const group = groups.find((item) => item.comparisonId === input.id)!;
    expect(group.cards.map((card) => card.id).sort()).toEqual([first.id, second.id].sort());
    expect(group.cards.map((card) => card.reading!.runId).sort()).toEqual([original.id, retry.id].sort());
    expect(result.duplicate).toBe(false);
    expect((await domain.linkReadingComparison(feedId, { ...input, members: [...input.members].reverse() })).duplicate).toBe(true);
    expect(await store.listCards(feedId)).toEqual(beforeCards);
    expect(await Promise.all([original, retry].map((run) => store.readRun(feedId, run.id)))).toEqual(beforeRuns);
    expect(calls).toEqual(["first", "second", "second"]);
  });

  test("preserves per-version reactions and binds preferences to both actual attempts", async () => {
    const { domain, store, original, retry, first, second, aside, input } = await setup();
    await domain.recordCardReaction(feedId, first.id, { clientEventId: "first-like", contentRevision: first.reading!.contentRevision, reaction: "like" });
    await domain.linkReadingComparison(feedId, input);
    const preference = await domain.recordReadingPreference(feedId, {
      clientEventId: "prefer-retry", runId: original.id, comparisonId: input.id, topicKey: input.topicKey,
      members: input.members, preferredCardId: second.id,
    });
    const feed = await store.readFeed(feedId);
    const group = groupReadingCards(feed.cards, feed.readingComparisons).find((item) => item.comparisonId === input.id)!;
    expect(currentReadingPreference(group, feed.readingPreferences)?.preferredCardId).toBe(second.id);
    expect(feed.readingReactions?.[first.id].reaction).toBe("like");
    expect(feed.readingReactions?.[second.id]).toBeUndefined();
    expect((await store.readCard(feedId, aside.id)).status).not.toBe("done");
    const snapshots = (preference.event.detail as { readingCards: Array<{ reading: { runId: string } }> }).readingCards;
    expect(snapshots.map((item) => item.reading.runId).sort()).toEqual([original.id, retry.id].sort());
  });

  test("a newly published version invalidates the old comparison choice", async () => {
    const { domain, store, original, retry, first, input, publish } = await setup();
    await domain.linkReadingComparison(feedId, input);
    const preference = { clientEventId: "old-preference", runId: original.id, comparisonId: input.id, topicKey: input.topicKey,
      members: input.members, preferredCardId: first.id };
    await domain.recordReadingPreference(feedId, preference);
    const late = await publish(retry, "second", "aside", input.topicKey, "late-version");
    const feed = await store.readFeed(feedId);
    const group = groupReadingCards(feed.cards, feed.readingComparisons).find((item) => item.comparisonId === input.id)!;
    expect(group.cards).toHaveLength(3);
    expect(currentReadingPreference(group, feed.readingPreferences)).toBeUndefined();
    await expect(domain.recordReadingPreference(feedId, { ...preference, clientEventId: "stale-choice" })).rejects.toMatchObject({ code: "stale_members" });
    await domain.recordReadingPreference(feedId, preference);
    expect((await store.readCard(feedId, late.id)).status).not.toBe("done");
  });

  for (const [name, options] of [
    ["packet", { retryPacket: `${packet}Different source text.` }],
    ["prompt", { retryPrompt: readerHash("Changed instructions.") }],
    ["missing prompt", { omitPrompt: true }],
  ] as const) test(`rejects a ${name} mismatch without linking the runs`, async () => {
    const { domain, store, input } = await setup(options);
    await expect(domain.linkReadingComparison(feedId, input)).rejects.toThrow(/packet|prompt/i);
    expect((await store.readEvents(feedId)).some((event) => event.type === "reading.comparison_linked")).toBe(false);
  });

  test("checks input bytes instead of trusting caller or receipt hash claims", async () => {
    const { domain, store, retry, input } = await setup();
    const file = store.feedPath(feedId, "raw", retry.id, retry.sourceId, "reader-input.json");
    const saved = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...saved, packet: "Tampered input." }));
    await expect(domain.linkReadingComparison(feedId, input)).rejects.toThrow(/input|packet/i);
  });

  test("receipt key order is irrelevant, but changed writer provenance is rejected", async () => {
    const { domain, store, original, retry, input } = await setup();
    const saved = await store.readRun(feedId, original.id);
    await store.writeRun({ ...saved, readers: saved.readers!.map((reader) => Object.fromEntries(Object.entries(reader).reverse()) as typeof reader) });
    expect((await domain.linkReadingComparison(feedId, input)).duplicate).toBe(false);
    const changed = await store.readRun(feedId, retry.id);
    changed.readers![0].requestedModel = "different-model";
    await store.writeRun(changed);
    await expect(domain.linkReadingComparison(feedId, input)).rejects.toMatchObject({ code: "invalid_provenance" });
  });

  test("rejects stale versions, other moments, cross-feed IDs, and overlapping comparison identities", async () => {
    const { domain, input, aside, first } = await setup();
    await expect(domain.linkReadingComparison(feedId, { ...input, members: [member(first), member(aside)] })).rejects.toMatchObject({ code: "stale_members" });
    await expect(domain.linkReadingComparison(feedId, { ...input, members: input.members.map((item) => ({ ...item, contentRevision: "0".repeat(64) })) })).rejects.toMatchObject({ code: "stale_content" });
    await expect(domain.linkReadingComparison("inbox", input)).rejects.toThrow();
    await domain.linkReadingComparison(feedId, input);
    await expect(domain.linkReadingComparison(feedId, { ...input, id: "different-comparison" })).rejects.toMatchObject({ code: "comparison_conflict" });
  });

  test("an additional attempt must be explicitly linked and cannot retarget the comparison", async () => {
    const { domain, store, runner, original, retry, first, input, publish } = await setup();
    await domain.linkReadingComparison(feedId, input);
    const preference = { clientEventId: "initial-choice", runId: original.id, comparisonId: input.id,
      topicKey: input.topicKey, members: input.members, preferredCardId: first.id };
    await domain.recordReadingPreference(feedId, preference);
    const third = { ...retry, id: "third-attempt" };
    await store.writeRun(third);
    await runner.start({ feedId, sourceRunId: third.id, packet, promptSha256, readers: [configs[1]] });
    await runner.waitForRun(feedId, third.id);
    await domain.recordSweepBatch(feedId, [original.id, retry.id, third.id]);
    const thirdCard = await publish(third, "second", "main", input.topicKey, "third-main");
    const before = await store.readFeed(feedId);
    const beforeGroup = groupReadingCards(before.cards, before.readingComparisons).find((group) => group.comparisonId === input.id)!;
    expect(beforeGroup.cards).toHaveLength(2);
    expect(currentReadingPreference(beforeGroup, before.readingPreferences)).toBeDefined();
    const extended = { ...input, runIds: [...input.runIds, third.id], members: [...input.members, member(thirdCard)] };
    expect((await domain.linkReadingComparison(feedId, extended)).comparison.sequence).toBe(2);
    const after = await store.readFeed(feedId);
    const afterGroup = groupReadingCards(after.cards, after.readingComparisons).find((group) => group.comparisonId === input.id)!;
    expect(afterGroup.cards).toHaveLength(3);
    expect(currentReadingPreference(afterGroup, after.readingPreferences)).toBeUndefined();
    await domain.recordReadingPreference(feedId, preference);
    expect((await store.readCard(feedId, thirdCard.id)).status).not.toBe("done");
    await expect(domain.linkReadingComparison(feedId, input)).rejects.toMatchObject({ code: "comparison_conflict" });
    await expect(domain.linkReadingComparison(feedId, { ...extended, runIds: [...extended.runIds].reverse() })).rejects.toMatchObject({ code: "comparison_conflict" });
    await expect(domain.linkReadingComparison(feedId, { ...extended, topicKey: "another-moment" })).rejects.toMatchObject({ code: "comparison_conflict" });
    await expect(domain.recordReadingPreference(feedId, { ...preference, clientEventId: "missing-comparison", comparisonId: undefined })).rejects.toMatchObject({ code: "stale_members" });
  });

  test("the HTTP link uses existing session protections and returns actionable validation errors", async () => {
    const { root, domain, store, input } = await setup();
    let notices = 0;
    const app = apiRoutes({ root, artifactsDir: root, dataDir: path.join(root, "data"), domain, store,
      sqlite: { status: () => ({ ok: true }) } as any, port: 0, mutationToken: "fixture-token", notify: () => { notices += 1; } });
    const route = `/api/feeds/${feedId}/reading-comparisons`;
    const headers = { "content-type": "application/json", origin: "http://127.0.0.1:4321", "x-attention-mutation-token": "fixture-token" };
    const post = (body: unknown, override = headers) => {
      const request = new Request(`http://127.0.0.1:4321${route}`, { method: "POST", body: JSON.stringify(body) });
      // The UI suite installs a browser Request that strips Origin during construction.
      // Set the received server headers afterward so this remains a real origin-boundary test.
      for (const [name, value] of Object.entries(override)) request.headers.set(name, value);
      return app.fetch(request);
    };
    expect((await post(input, { ...headers, "x-attention-mutation-token": "" })).status).toBe(403);
    expect((await post(input, { ...headers, origin: "https://outside.example" })).status).toBe(403);
    expect((await post(input, { ...headers, "content-type": "text/plain" })).status).toBe(415);
    expect((await post({ ...input, runIds: [input.runIds[0]] })).status).toBe(400);
    const stale = await post({ ...input, members: input.members.map((item) => ({ ...item, contentRevision: "0".repeat(64) })) });
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe("stale_content");
    expect(notices).toBe(0);
    const linked = await post(input);
    expect(linked.status).toBe(200);
    expect((await linked.json()).comparison.id).toBe(input.id);
    expect(notices).toBe(1);
  });

  test("the file-safe CLI links a comparison in an isolated SQLite runtime", async () => {
    const { root, store, runner, input } = await setup();
    await runner.close();
    const file = path.join(root, "comparison.json");
    await writeFile(file, JSON.stringify(input));
    const child = Bun.spawn([process.execPath, "tend.ts", "cli", "readers:compare", "--feed", feedId, "--comparison-file", file], {
      cwd: process.cwd(), env: { ...process.env, ATTENTION_HOME: root }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(stdout)).toMatchObject({ duplicate: false, comparison: { id: input.id, inputSha256: readerHash(packet), promptSha256 } });
    expect((await store.readFeed(feedId)).readingComparisons?.[0].id).toBe(input.id);
  });
});
