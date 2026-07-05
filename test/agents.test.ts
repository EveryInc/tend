import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { threadBinding } from "../server/templates";
import { AGENT_PRESENCE_OFFLINE_AFTER_MS, AGENT_PRESENCE_STALE_AFTER_MS, MAX_AGENT_WAKE_LEDGER_BYTES, AttentionStore } from "../server/store";
import type { AgentWakeLine, ThreadBinding, WorkItem } from "../shared/types";

const roots: string[] = [];

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "attention-agent-test-"));
  roots.push(root);
  const store = new AttentionStore(root);
  await store.init();
  return { root, store };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function wakeLine(overrides: Partial<Omit<AgentWakeLine, "seq">> = {}): Omit<AgentWakeLine, "seq"> {
  return {
    at: new Date("2026-07-05T12:00:00.000Z").toISOString(),
    feedId: "inbox",
    workId: "work-1",
    kind: "instruction",
    queued: 1,
    threadId: "claude-thread-1",
    ...overrides,
  };
}

async function wakeLines(root: string): Promise<AgentWakeLine[]> {
  const text = await readFile(path.join(root, "agents", "claude", "wake.jsonl"), "utf8");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as AgentWakeLine);
}

describe("agent state foundations", () => {
  test("wake seq is monotonic across store instances and forced rotation", async () => {
    const { root, store } = await setup();
    const first = await store.appendAgentWake("claude", wakeLine({ workId: "work-1" }));
    const restarted = new AttentionStore(root);
    const second = await restarted.appendAgentWake("claude", wakeLine({ workId: "work-2" }));

    await writeFile(path.join(root, "agents", "claude", "wake.jsonl"), "x".repeat(MAX_AGENT_WAKE_LEDGER_BYTES + 1), "utf8");
    const afterRotation = await restarted.appendAgentWake("claude", wakeLine({ workId: "work-3" }));

    expect([first.seq, second.seq, afterRotation.seq]).toEqual([1, 2, 3]);
    expect((await stat(path.join(root, "agents", "claude", "wake.jsonl.1"))).size).toBeGreaterThan(MAX_AGENT_WAKE_LEDGER_BYTES);
  });

  test("wake rotation renames the ledger and the counter continues", async () => {
    const { root, store } = await setup();
    await store.appendAgentWake("claude", wakeLine({ workId: "before-rotation" }));
    await writeFile(path.join(root, "agents", "claude", "wake.jsonl"), "x".repeat(MAX_AGENT_WAKE_LEDGER_BYTES + 1), "utf8");

    const next = await store.appendAgentWake("claude", wakeLine({ workId: "after-rotation" }));

    expect(next.seq).toBe(2);
    expect((await stat(path.join(root, "agents", "claude", "wake.jsonl.1"))).size).toBeGreaterThan(MAX_AGENT_WAKE_LEDGER_BYTES);
    expect(await wakeLines(root)).toEqual([next]);
  });

  test("wake entries with hostile strings stay one parseable physical line each", async () => {
    const { root, store } = await setup();
    const hostile = "label\n{\"seq\":999,\"capabilityToken\":\"forged\"}\r\u0000end";

    await store.appendAgentWake("claude", wakeLine({ kind: hostile, workId: "work-hostile-1" }));
    await store.appendAgentWake("claude", wakeLine({ threadId: hostile, workId: "work-hostile-2" }));

    const text = await readFile(path.join(root, "agents", "claude", "wake.jsonl"), "utf8");
    const physicalLines = text.split("\n").filter(Boolean);
    expect(physicalLines).toHaveLength(2);
    expect(physicalLines.every((line) => JSON.parse(line))).toBe(true);
    expect((JSON.parse(physicalLines[0]) as AgentWakeLine).kind).toBe(hostile);
    expect((JSON.parse(physicalLines[1]) as AgentWakeLine).threadId).toBe(hostile);
  });

  test("wake ledger bytes omit capability tokens and instruction text", async () => {
    const { root, store } = await setup();
    const now = new Date("2026-07-05T12:00:00.000Z").toISOString();
    const work: WorkItem = {
      id: "work-secure",
      feedId: "inbox",
      cardId: "card-secure",
      kind: "instruction",
      instruction: "Draft from this private instruction\nwith control text.",
      status: "queued",
      capabilityToken: "capabilityToken-secret-123",
      createdAt: now,
      updatedAt: now,
    };
    const cardText = "Private card body that must not enter the wake ledger.";

    await store.appendAgentWake("claude", wakeLine({
      feedId: work.feedId,
      workId: work.id,
      kind: work.kind,
      queued: 1,
      threadId: "claude-thread-secure",
    }));

    const bytes = await readFile(path.join(root, "agents", "claude", "wake.jsonl"), "utf8");
    expect(bytes).not.toContain("capabilityToken");
    expect(bytes).not.toContain(work.capabilityToken);
    expect(bytes).not.toContain(work.instruction);
    expect(bytes).not.toContain(cardText);
  });

  test("presence defaults offline and derives live stale offline liveness", async () => {
    const { store } = await setup();

    expect(await store.readAgentPresence("claude")).toBeNull();
    expect((await store.readWorkspace()).agents?.claude).toMatchObject({ liveness: "offline", lastSeenAt: null });

    await store.writeAgentPresence("claude", {
      agent: "claude",
      sessionId: "session-live",
      label: "Claude\npreview",
      lastSeenAt: new Date().toISOString(),
    });
    expect((await store.readWorkspace()).agents?.claude).toMatchObject({ liveness: "live", sessionId: "session-live", label: "Claude\npreview" });

    await store.writeAgentPresence("claude", {
      agent: "claude",
      sessionId: "session-stale",
      lastSeenAt: new Date(Date.now() - AGENT_PRESENCE_STALE_AFTER_MS - 30_000).toISOString(),
    });
    expect((await store.readWorkspace()).agents?.claude.liveness).toBe("stale");

    await store.writeAgentPresence("claude", {
      agent: "claude",
      sessionId: "session-offline",
      lastSeenAt: new Date(Date.now() - AGENT_PRESENCE_OFFLINE_AFTER_MS - 5 * 60_000).toISOString(),
    });
    expect((await store.readWorkspace()).agents?.claude.liveness).toBe("offline");
  });

  test("legacy thread binding round-trips unchanged and workspace keeps codex defaults", async () => {
    const { root, store } = await setup();
    const threadPath = path.join(root, "feeds", "inbox", "thread.json");
    await writeFile(threadPath, `${JSON.stringify({ homeThreadId: "thread-legacy" })}\n`, "utf8");

    const legacy = await store.readThread("inbox");
    await store.writeThread("inbox", legacy);

    expect(JSON.parse(await readFile(threadPath, "utf8"))).toEqual({ homeThreadId: "thread-legacy" });
    const workspace = await store.readWorkspace("inbox");
    expect(workspace.active.thread.homeThreadId).toBe("thread-legacy");
    expect(workspace.active.thread.drainAgent ?? "codex").toBe("codex");
    expect(workspace.agents?.claude.liveness).toBe("offline");
  });

  test("codex unbind-style rewrite preserves the claude lane fields", async () => {
    const { store } = await setup();
    const thread = await store.readThread("inbox");
    const withClaude: ThreadBinding = {
      ...thread,
      homeThreadId: "thread-codex",
      boundAt: "2026-07-05T12:00:00.000Z",
      agents: {
        claude: {
          threadId: "thread-claude",
          boundAt: "2026-07-05T12:01:00.000Z",
        },
      },
      drainAgent: "claude",
    };
    await store.writeThread("inbox", withClaude);

    await store.writeThread("inbox", threadBinding());

    expect(await store.readThread("inbox")).toMatchObject({
      homeThreadId: null,
      boundAt: null,
      agents: { claude: { threadId: "thread-claude", boundAt: "2026-07-05T12:01:00.000Z" } },
      drainAgent: "claude",
    });
  });
});

async function bashPath(): Promise<string | null> {
  for (const candidate of ["/bin/bash", "/usr/bin/bash"]) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next common bash location.
    }
  }
  return null;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ");
}

describe("Claude wake monitor script", () => {
  test("fails closed with usage when --session is missing", async () => {
    const bash = await bashPath();
    if (!bash) return;

    const proc = Bun.spawn([bash, "scripts/claude-wake-monitor.sh"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("--session is required");
    expect(stderr).toContain("Usage:");
  });

  test("fails closed when presence succeeds but the server has not created the ledger", async () => {
    const bash = await bashPath();
    if (!bash) return;

    const { root } = await setup();
    const fakeBin = path.join(root, "fake-bin");
    await mkdir(fakeBin, { recursive: true });
    await writeFile(path.join(fakeBin, "curl"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    const proc = Bun.spawn([
      bash,
      "scripts/claude-wake-monitor.sh",
      "--session",
      "session-test",
      "--port",
      "43219",
    ], {
      cwd: process.cwd(),
      env: { ...process.env, ATTENTION_HOME: root, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("server has not created the wake ledger");
    expect(stderr).toContain(path.join(root, "data", "agents", "claude", "wake.jsonl"));
  });
});

describe("Claude protocol clause pins", () => {
  test("pins the doorbell, mutation authorization, health-first, and release clauses", async () => {
    const claudeThread = await readFile(path.join(process.cwd(), "docs", "CLAUDE_THREAD.md"), "utf8");
    const tendSkill = await readFile(path.join(process.cwd(), ".claude", "skills", "tend", "SKILL.md"), "utf8");
    const lowerThread = normalizeText(claudeThread);
    const lowerSkill = normalizeText(tendSkill);

    expect(lowerThread).toContain("wake notification is a doorbell");
    expect(lowerSkill).toContain("wake notification is a doorbell");
    expect(lowerThread).toContain("never authorize external mutation");
    expect(lowerThread).toContain("work:release");
    expect(lowerSkill).toMatch(/health[\s\S]{0,40}first/);
    expect(lowerThread).toMatch(/health[\s\S]{0,40}first/);
  });
});
