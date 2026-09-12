import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ReaderRunner, readerHash, type ReaderRunnerOptions } from "../server/readers";
import { assertCodexReaderEvent, parseClaudeResult, parseCodexResult, readerCommand, readerEnvironment, ReaderExecutionError, type ReaderAdapter } from "../server/readerAdapters";
import { AttentionStore } from "../server/store";
import type { ReaderConfig, ReaderReceipt } from "../shared/readers";
import type { SourceRun } from "../shared/types";

const roots: string[] = [];
const runners: ReaderRunner[] = [];
const configs: ReaderConfig[] = [
  { id: "a", label: "First", adapter: "codex", model: "codex-fixture-model", effort: "high" },
  { id: "b", label: "Second", adapter: "claude", model: "claude-fixture-model", effort: "high" },
];
const packet = "Frozen instructions\n<source>Untrusted complete meeting transcript</source>\n";

async function setup(adapters: Partial<Record<ReaderConfig["adapter"], ReaderAdapter>>, timeoutMs = 10_000, options: Pick<ReaderRunnerOptions, "probePid"> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tend-readers-test-"));
  roots.push(root);
  const store = new AttentionStore(root);
  await store.init();
  const run: SourceRun = { id: "run-test", feedId: "company-attention", sourceId: "company-attention", snapshots: 1, judgments: [], completedAt: new Date().toISOString() };
  await store.writeRawSnapshot(run.feedId, run.id, run.sourceId, "snapshot-1", { transcript: "complete meeting" });
  await store.writeRun(run);
  const runner = new ReaderRunner(store, { adapters, timeoutMs, ...options });
  runners.push(runner);
  const input = { feedId: run.feedId, sourceRunId: run.id, packet, readers: configs };
  return { store, runner, run, input };
}

afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("native source-run readers", () => {
  test("starts arbitrary configured readers concurrently on identical bytes, preserves outputs, and never publishes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let allStarted!: () => void;
    const ready = new Promise<void>((resolve) => { allStarted = resolve; });
    const received: Array<{ id: string; packet: string }> = [];
    const adapter: ReaderAdapter = async (config, input) => {
      received.push({ id: config.id, packet: input });
      if (received.length === 3) allStarted();
      await gate;
      const rawOutput = JSON.stringify({ flags: [{ id: config.id, title: `Draft by ${config.id}` }] });
      return { rawOutput, output: JSON.parse(rawOutput), actualModel: config.model };
    };
    const { store, runner, run, input } = await setup({ codex: adapter, claude: adapter });
    const before = await store.readFeed(run.feedId);
    const submitted = await runner.start({ ...input, readers: [...configs, { ...configs[0], id: "third" }] });
    expect(submitted.id).toBe(run.id);
    expect(submitted.readers).toHaveLength(3);
    await ready;
    expect(received.map((item) => item.packet)).toEqual([packet, packet, packet]);
    release();
    await runner.waitForRun(run.feedId, run.id);
    const saved = await store.readRun(run.feedId, run.id);
    for (const receipt of saved.readers!) {
      expect(receipt.status).toBe("complete");
      expect(receipt.inputSha256).toBe(readerHash(packet));
      const output = await runner.readOutput(run.feedId, run.id, receipt.readerId);
      expect(output.output).toEqual({ flags: [{ id: receipt.readerId, title: `Draft by ${receipt.readerId}` }] });
      expect(receipt.outputSha256).toBe(readerHash(output.rawOutput));
      expect(receipt.actualModel).toBe(receipt.requestedModel);
    }
    const storedPacket = JSON.parse(await readFile(store.feedPath(run.feedId, "raw", run.id, run.sourceId, "reader-input.json"), "utf8"));
    expect(storedPacket.packet).toBe(packet);
    const after = await store.readFeed(run.feedId);
    expect(after.cards).toEqual(before.cards);
    expect(after.work).toEqual(before.work);
    expect(after.policy).toBe(before.policy);
    expect(after.sweep).toEqual(before.sweep);
  });

  test("identical retries reuse terminal receipts; changes require a new source run", async () => {
    let calls = 0;
    const adapter: ReaderAdapter = async () => { calls += 1; return { rawOutput: '{"flags":[]}', output: { flags: [] } }; };
    const { runner, run, input } = await setup({ codex: adapter, claude: adapter });
    await runner.start(input);
    await runner.waitForRun(run.feedId, run.id);
    const retry = await runner.start({ ...input, readers: [...configs].reverse() });
    expect(retry.readers?.every((item) => item.status === "complete")).toBe(true);
    expect(calls).toBe(2);
    await expect(runner.start({ ...input, packet: `${packet}changed` })).rejects.toThrow("different reader packet");
    await expect(runner.start({ ...input, readers: [{ ...configs[0], effort: "medium" }, configs[1]] })).rejects.toThrow("different reader packet");
    expect(calls).toBe(2);
  });

  test("one reader failure preserves the other output and does not auto-retry or substitute", async () => {
    let failedCalls = 0;
    const { store, runner, run, input } = await setup({
      codex: async () => ({ rawOutput: '{"flags":[]}', output: { flags: [] } }),
      claude: async () => { failedCalls += 1; throw new ReaderExecutionError("Fixture model unavailable", '{"error":"unavailable"}'); },
    });
    await runner.start(input);
    await runner.waitForRun(run.feedId, run.id);
    const saved = await store.readRun(run.feedId, run.id);
    expect(saved.readers?.map((item) => item.status)).toEqual(["complete", "failed"]);
    const failure = await runner.readOutput(run.feedId, run.id, "b");
    expect(failure.rawOutput).toBe('{"error":"unavailable"}');
    expect(failure.error).toBe("Fixture model unavailable");
    await runner.start(input);
    expect(failedCalls).toBe(1);
  });

  test("login failures persist safe receipt guidance and private raw diagnostics without feedback or replay", async () => {
    let calls = 0;
    const raw = "private@example.test fixture-private-token";
    const { store, runner, run, input } = await setup({ claude: async () => {
      calls += 1;
      throw new ReaderExecutionError(raw, raw, "subscription_login_required");
    } });
    const before = await store.readFeed(run.feedId);
    await runner.start({ ...input, readers: [configs[1]] });
    await runner.waitForRun(run.feedId, run.id);
    const saved = await store.readRun(run.feedId, run.id);
    expect(saved.readers![0]).toMatchObject({ status: "failed", failureCode: "subscription_login_required" });
    expect(saved.readers![0].error).toContain("Sign in");
    expect(JSON.stringify(saved)).not.toContain(raw);
    expect((await runner.readOutput(run.feedId, run.id, configs[1].id)).rawOutput).toBe(raw);
    const events = await store.readEvents(run.feedId);
    expect(JSON.stringify(events)).not.toContain(raw);
    expect(events.some((event) => event.type === "card.reaction_recorded" || event.type === "reading.preference_recorded")).toBe(false);
    const after = await store.readFeed(run.feedId);
    expect(after.cards).toEqual(before.cards);
    expect(after.work).toEqual(before.work);
    expect(after.policy).toEqual(before.policy);
    await runner.start({ ...input, readers: [configs[1]] });
    expect(calls).toBe(1);
  });

  test("a queued-event write failure leaves terminal pre-launch receipts, not a stranded queued retry", async () => {
    let calls = 0;
    const adapter: ReaderAdapter = async () => { calls += 1; return { rawOutput: "{}", output: {} }; };
    const { store, runner, run, input } = await setup({ codex: adapter, claude: adapter });
    const appendEvent = store.appendEvent.bind(store);
    let eventAttempts = 0;
    store.appendEvent = async (event) => {
      if (event.type === "readers.queued" && eventAttempts++ === 0) throw new Error("Fixture queued-event append failed");
      return appendEvent(event);
    };
    await expect(runner.start(input)).rejects.toThrow("Fixture queued-event append failed");
    const failed = await store.readRun(run.feedId, run.id);
    expect(failed.readers?.map((receipt) => receipt.status)).toEqual(["failed", "failed"]);
    expect(failed.readers?.every((receipt) => receipt.error?.includes("before any provider was launched"))).toBe(true);
    store.appendEvent = appendEvent;
    const retried = await runner.start(input);
    expect(retried.readers?.map((receipt) => receipt.status)).toEqual(["failed", "failed"]);
    expect(calls).toBe(0);
    expect(eventAttempts).toBe(1);
  });

  test("timeout is terminal even when an adapter returns late", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const { store, runner, run, input } = await setup({ codex: async () => { await gate; return { rawOutput: "{}", output: {} }; } }, 25);
    await runner.start({ ...input, readers: [configs[0]] });
    await runner.waitForRun(run.feedId, run.id);
    finish();
    await Promise.resolve();
    const saved = await store.readRun(run.feedId, run.id);
    expect(saved.readers?.[0].status).toBe("failed");
    expect(saved.readers?.[0].error).toContain("timed out");
    await expect(runner.readOutput(run.feedId, run.id, "a")).rejects.toThrow("no recorded output");
  });

  test("timeout preserves diagnostics returned while the adapter shuts down", async () => {
    const diagnostics = JSON.stringify({ stdout: "partial reader event", stderr: "bounded diagnostic" });
    const adapter: ReaderAdapter = async (_config, _packet, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        setTimeout(() => reject(new ReaderExecutionError("Reader timed out; no automatic retry was attempted.", diagnostics)), 5);
      }, { once: true });
    });
    const { store, runner, run, input } = await setup({ codex: adapter }, 25);
    await runner.start({ ...input, readers: [configs[0]] });
    await runner.waitForRun(run.feedId, run.id);

    const saved = await store.readRun(run.feedId, run.id);
    expect(saved.readers?.[0].status).toBe("failed");
    expect(saved.readers?.[0].error).toContain("timed out");
    expect((await runner.readOutput(run.feedId, run.id, "a")).rawOutput).toBe(diagnostics);
  });

  test("server recovery reclaims a dead owner and interrupts abandoned readers without replaying providers", async () => {
    let calls = 0;
    const probed: number[] = [];
    const { store, runner, run, input } = await setup({ codex: async () => { calls += 1; return { rawOutput: "{}", output: {} }; } }, 1_000, {
      probePid: (pid) => { probed.push(pid); throw Object.assign(new Error("No such process"), { code: "ESRCH" }); },
    });
    const receipt: ReaderReceipt = { readerId: "a", label: "First", adapter: "codex", requestedModel: configs[0].model, requestedEffort: "high", status: "running", inputSha256: readerHash(packet), inputSnapshotId: "reader-input" };
    await store.writeRun({ ...run, readers: [receipt] });
    await writeFile(store.path(".reader-owner.json"), JSON.stringify({ pid: 424242, instanceId: "previous-worker" }));
    expect(await runner.recoverInterrupted()).toBe(1);
    expect((await store.readRun(run.feedId, run.id)).readers?.[0].status).toBe("interrupted");
    await runner.start({ ...input, readers: [configs[0]] });
    expect(calls).toBe(0);
    expect(probed).toEqual([424242]);
    expect(JSON.parse(await readFile(store.path(".reader-owner.json"), "utf8")).pid).toBe(process.pid);
  });

  test("another runner in the same process cannot recover or start the active owner's work", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let calls = 0;
    const adapter: ReaderAdapter = async () => {
      calls += 1;
      started();
      await gate;
      return { rawOutput: '{"flags":[]}', output: { flags: [] } };
    };
    const { store, runner, run, input } = await setup({ codex: adapter }, 10_000);
    await runner.start({ ...input, readers: [configs[0]] });
    await ready;
    const owner = await readFile(store.path(".reader-owner.json"), "utf8");
    // Separate store instances also share the existing filesystem mutation lock.
    for (const peerStore of [store, new AttentionStore(store.dataDir)]) {
      const peer = new ReaderRunner(peerStore, { adapters: { codex: adapter } });
      runners.push(peer);
      await expect(peer.recoverInterrupted()).rejects.toThrow("Another Tend reader worker");
      await expect(peer.start({ ...input, readers: [configs[0]] })).rejects.toThrow("Another Tend reader worker");
      await peer.close();
      expect(await readFile(store.path(".reader-owner.json"), "utf8")).toBe(owner);
      expect((await store.readRun(run.feedId, run.id)).readers?.[0].status).toBe("running");
    }
    expect(await runner.recoverInterrupted()).toBe(0);
    release();
    await runner.waitForRun(run.feedId, run.id);
    expect((await store.readRun(run.feedId, run.id)).readers?.[0].status).toBe("complete");
    expect(calls).toBe(1);
  });

  test("uncertain PID probes and invalid ownership records never permit takeover", async () => {
    const { store, runner, run, input } = await setup({ codex: async () => ({ rawOutput: "{}", output: {} }) }, 1_000, {
      probePid: () => { throw Object.assign(new Error("Not permitted"), { code: "EPERM" }); },
    });
    const filename = store.path(".reader-owner.json");
    const owner = JSON.stringify({ pid: 424242, instanceId: "unverifiable-worker" });
    await writeFile(filename, owner);
    await expect(runner.recoverInterrupted()).rejects.toThrow("Another Tend reader worker");
    await expect(runner.start({ ...input, readers: [configs[0]] })).rejects.toThrow("Another Tend reader worker");
    expect(await readFile(filename, "utf8")).toBe(owner);
    await writeFile(filename, JSON.stringify({ pid: -1, instanceId: "invalid-worker" }));
    await expect(runner.recoverInterrupted()).rejects.toThrow("owner record is invalid");
    expect((await store.readRun(run.feedId, run.id)).readers).toBeUndefined();
  });

  test("close waits for a committing start before releasing ownership and never launches its provider", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let queued!: () => void;
    const ready = new Promise<void>((resolve) => { queued = resolve; });
    let calls = 0;
    const { store, runner, run, input } = await setup({ codex: async () => { calls += 1; return { rawOutput: "{}", output: {} }; } });
    const appendEvent = store.appendEvent.bind(store);
    store.appendEvent = async (event) => {
      if (event.type === "readers.queued") { queued(); await gate; }
      return appendEvent(event);
    };
    const starting = runner.start({ ...input, readers: [configs[0]] });
    await ready;
    let closed = false;
    const closing = runner.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(JSON.parse(await readFile(store.path(".reader-owner.json"), "utf8")).pid).toBe(process.pid);
    release();
    await starting;
    await closing;
    expect(calls).toBe(0);
    const receipt = (await store.readRun(run.feedId, run.id)).readers?.[0];
    expect(receipt?.status).toBe("interrupted");
    expect(receipt?.error).toContain("stopping");
    await expect(readFile(store.path(".reader-owner.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const successor = new ReaderRunner(store, { adapters: { codex: async () => ({ rawOutput: "{}", output: {} }) } });
    runners.push(successor);
    expect(await successor.recoverInterrupted()).toBe(0);
    const nextOwner = await readFile(store.path(".reader-owner.json"), "utf8");
    await runner.close();
    expect(await readFile(store.path(".reader-owner.json"), "utf8")).toBe(nextOwner);
    await expect(runner.start(input)).rejects.toThrow("closed");
  });

  test("closing a runner cannot delete an ownership record that no longer matches", async () => {
    const { store, runner } = await setup({});
    await runner.recoverInterrupted();
    const filename = store.path(".reader-owner.json");
    const replacement = JSON.stringify({ pid: process.pid, instanceId: "replacement-worker" });
    await store.serialize(() => writeFile(filename, replacement));
    await runner.close();
    expect(await readFile(filename, "utf8")).toBe(replacement);
  });

  test("output reads are confined to recorded same-run reader snapshots", async () => {
    const { store, runner, run, input } = await setup({ codex: async () => ({ rawOutput: "{}", output: {} }) });
    await runner.start({ ...input, readers: [configs[0]] });
    await runner.waitForRun(run.feedId, run.id);
    await expect(runner.readOutput(run.feedId, run.id, "../a")).rejects.toThrow("plain identifier");
    await expect(runner.readOutput(run.feedId, run.id, "missing")).rejects.toThrow("no recorded output");
    const saved = await store.readRun(run.feedId, run.id);
    saved.readers![0].outputSnapshotId = "../../private";
    await store.writeRun(saved);
    await expect(runner.readOutput(run.feedId, run.id, "a")).rejects.toThrow("reference is invalid");
  });

  test("invalid configurations fail before adding reader receipts", async () => {
    const { store, runner, run, input } = await setup({ codex: async () => ({ rawOutput: "{}", output: {} }) });
    await expect(runner.start({ ...input, readers: [{ ...configs[0], model: "--dangerous" }] })).rejects.toThrow("plain model");
    await expect(runner.start({ ...input, readers: [configs[0], configs[0]] })).rejects.toThrow("unique");
    expect((await store.readRun(run.feedId, run.id)).readers).toBeUndefined();
  });

  test("reads the hash-bound raw draft, ignores a changed parsed mirror, and rejects changed bytes", async () => {
    const original = { flags: [{ id: "one", title: "The original observation", face: "The actual model output." }] };
    const rawOutput = `\`\`\`json\n${JSON.stringify(original)}\n\`\`\``;
    const { store, runner, run, input } = await setup({ codex: async () => ({ rawOutput, output: original }) });
    await runner.start({ ...input, readers: [configs[0]] });
    await runner.waitForRun(run.feedId, run.id);
    const filename = store.feedPath(run.feedId, "raw", run.id, run.sourceId, "reader-output-a.json");
    const snapshot = JSON.parse(await readFile(filename, "utf8"));
    snapshot.output = { flags: [{ id: "forged", title: "Not generated by the reader", face: "Changed independently of raw output." }] };
    await writeFile(filename, JSON.stringify(snapshot));
    expect((await runner.readOutput(run.feedId, run.id, "a")).output).toEqual(original);
    snapshot.rawOutput = JSON.stringify(snapshot.output);
    await writeFile(filename, JSON.stringify(snapshot));
    await expect(runner.readOutput(run.feedId, run.id, "a")).rejects.toThrow("immutable receipt");
  });
});

describe("fixed CLI reader adapters (no provider calls)", () => {
  test("disable external tools and preserve subscription auth without changing parent environment", () => {
    const claude = readerCommand(configs[1], "/tmp/result.json");
    expect(claude.args).toContain("--safe-mode");
    expect(claude.args[claude.args.indexOf("--tools") + 1]).toBe("");
    expect(claude.args).not.toContain("--bare");
    expect(claude.args).not.toContain("--fallback-model");
    const codex = readerCommand(configs[0], "/tmp/result.json");
    for (const feature of ["shell_tool", "unified_exec", "apps", "browser_use", "computer_use", "multi_agent", "image_generation", "view_image"]) {
      expect(codex.args[codex.args.indexOf(feature) - 1]).toBe("--disable");
    }
    expect(codex.args).toContain("--ignore-user-config");
    expect(codex.args).toContain('web_search="disabled"');
    expect(codex.args).toContain("read-only");
    const parent = { HOME: "/home/test", CODEX_HOME: "/home/test/.codex", ANTHROPIC_API_KEY: "fixture-key", ANTHROPIC_BASE_URL: "https://fixture.invalid", OPENAI_API_KEY: "fixture-openai" };
    const child = readerEnvironment("claude", parent);
    expect(child.ANTHROPIC_API_KEY).toBeUndefined();
    expect(child.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(child.CODEX_HOME).toBe(parent.CODEX_HOME);
    expect(parent.ANTHROPIC_API_KEY).toBe("fixture-key");
    expect(readerEnvironment("codex", parent).OPENAI_API_KEY).toBeUndefined();
  });

  test("the Claude primary model is verified independently of auxiliary usage", () => {
    const stdout = JSON.stringify({ is_error: false, result: '{"flags":[]}', modelUsage: {
      "claude-fixture-model": { inputTokens: 10, outputTokens: 20 }, "claude-auxiliary-model": { outputTokens: 3 },
    } });
    expect(parseClaudeResult(stdout, "claude-fixture-model").actualModel).toBe("claude-fixture-model");
    expect(() => parseClaudeResult(stdout, "claude-other")).toThrow("requested model");
    expect(() => parseClaudeResult('{"is_error":true}', "claude-fixture-model")).toThrow("did not complete");
  });

  test("the Claude primary model accepts a short selector resolved to one canonical model", () => {
    const stdout = JSON.stringify({ is_error: false, result: '{"flags":[]}', usage: { output_tokens: 12_308 }, modelUsage: {
      "claude-haiku-4-5-20251001": { inputTokens: 6_323, outputTokens: 10, canonicalModel: "claude-haiku-4-5" },
      "claude-fable-5-1": { inputTokens: 2, outputTokens: 12_308, cacheReadInputTokens: 1_024, canonicalModel: "claude-fable-5-1" },
    } });
    const result = parseClaudeResult(stdout, "fable");
    expect(result.actualModel).toBe("claude-fable-5-1");
    expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 12_308, cachedInputTokens: 1_024 });
    expect(() => parseClaudeResult(stdout, "fab")).toThrow("requested model");
    expect(() => parseClaudeResult(stdout, "default")).toThrow("requested model");
    expect(() => parseClaudeResult(stdout, "haiku")).toThrow("requested model");
  });

  test("Codex remains unknown when no model is reported and refuses tool events", () => {
    const stdout = [
      JSON.stringify({ type: "item.completed", item: { type: "error", message: "Code Mode is unavailable because code-mode host is disabled." } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "{}" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 20 } }),
    ].join("\n");
    expect(parseCodexResult(stdout, "{}", "codex-fixture-model").actualModel).toBeUndefined();
    expect(() => parseCodexResult(stdout + '\n{"type":"turn.failed"}', "{}", "codex-fixture-model")).toThrow("did not complete");
    expect(() => assertCodexReaderEvent(JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "unexpected" } }))).toThrow("attempted a tool");
    expect(() => assertCodexReaderEvent(JSON.stringify({ type: "item.started", item: { type: "mcp_tool_call" } }))).toThrow("attempted a tool");
  });
});
