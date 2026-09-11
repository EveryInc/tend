import { describe, expect, test } from "bun:test";
import { shouldDispatch } from "../server/dispatcher";
import type { DrainState, ThreadBinding, WorkAgent, WorkItem, WorkStatus } from "../shared/types";

const NOW = Date.parse("2026-07-05T12:00:00.000Z");
const OLD = "2026-07-05T11:58:00.000Z";
const OLDER = "2026-07-05T11:57:00.000Z";
const FRESH = "2026-07-05T11:59:59.000Z";

function thread(overrides: Partial<ThreadBinding> = {}): ThreadBinding {
  return {
    homeThreadId: "thread-codex",
    boundAt: "2026-07-05T11:00:00.000Z",
    heartbeat: { status: "not_proposed", cadence: null, automationId: null },
    ...overrides,
  };
}

function drain(overrides: Partial<DrainState> = {}): DrainState {
  return { status: "idle", ...overrides };
}

function workItem(overrides: {
  id: string;
  status?: WorkStatus;
  assignee?: WorkAgent;
  createdAt?: string;
  updatedAt?: string;
}): WorkItem {
  return {
    id: overrides.id,
    feedId: "inbox",
    cardId: `card-${overrides.id}`,
    kind: "instruction",
    instruction: `Handle ${overrides.id}`,
    status: overrides.status ?? "queued",
    capabilityToken: `token-${overrides.id}`,
    createdAt: overrides.createdAt ?? OLD,
    updatedAt: overrides.updatedAt ?? overrides.createdAt ?? OLD,
    ...(overrides.assignee ? { assignee: overrides.assignee } : {}),
  };
}

function decide(input: { work: WorkItem[]; thread?: ThreadBinding; drain?: DrainState }) {
  return shouldDispatch({
    now: NOW,
    work: input.work,
    thread: input.thread ?? thread(),
    drain: input.drain ?? drain(),
    minQueueAgeMs: 60_000,
    activeClaimWindowMs: 10 * 60_000,
  });
}

describe("shouldDispatch", () => {
  test("returns null when only claude-lane work is queued", () => {
    expect(decide({ work: [workItem({ id: "claude-queued", assignee: "claude" })] })).toBeNull();
  });

  test("dispatches mixed lanes with queued count and oldest age from codex-lane items only", () => {
    const decision = decide({
      thread: thread({ drainAgent: "claude" }),
      work: [
        workItem({ id: "claude-default", createdAt: "2026-07-05T11:30:00.000Z" }),
        workItem({ id: "codex-newer", assignee: "codex", createdAt: OLD }),
        workItem({ id: "codex-older", assignee: "codex", createdAt: OLDER }),
        workItem({ id: "claude-explicit", assignee: "claude", createdAt: "2026-07-05T11:20:00.000Z" }),
      ],
    });

    expect(decision).toEqual({ feedId: "inbox", reason: "queued_work", queued: 2, oldestQueuedAt: OLDER });
  });

  test("dispatches codex queued work while claude has a fresh active claim", () => {
    const decision = decide({
      work: [
        workItem({ id: "claude-working", assignee: "claude", status: "working", updatedAt: FRESH }),
        workItem({ id: "codex-queued" }),
      ],
    });

    expect(decision?.queued).toBe(1);
  });

  test("suppresses dispatch while codex has a fresh active claim", () => {
    expect(
      decide({
        work: [
          workItem({ id: "codex-working", assignee: "codex", status: "working", updatedAt: FRESH }),
          workItem({ id: "codex-queued" }),
        ],
      }),
    ).toBeNull();
  });

  test("does not dispatch an old claude-lane claim by itself", () => {
    expect(decide({ work: [workItem({ id: "claude-working-old", assignee: "claude", status: "working", updatedAt: OLDER })] })).toBeNull();
  });

  test("preserves legacy single-lane behavior when no agents or drainAgent are configured", () => {
    const decision = decide({
      thread: thread({ agents: undefined, drainAgent: undefined }),
      work: [workItem({ id: "legacy-one", createdAt: OLDER }), workItem({ id: "legacy-two", createdAt: OLD })],
    });

    expect(decision).toEqual({ feedId: "inbox", reason: "queued_work", queued: 2, oldestQueuedAt: OLDER });
  });
});
