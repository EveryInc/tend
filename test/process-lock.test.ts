import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isLockArtifact, withProcessLock } from "../server/processLock";

async function tempLock(label: string): Promise<{ root: string; lock: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), `tend-lock-${label}-`));
  return { root, lock: path.join(root, "data", ".mutation-lock") };
}

async function entryKind(target: string): Promise<"symlink" | "directory" | "missing"> {
  try {
    const entry = await lstat(target);
    return entry.isSymbolicLink() ? "symlink" : "directory";
  } catch {
    return "missing";
  }
}

test("a killed holder releases the lock and its marker is reclaimed", async () => {
  const { root, lock } = await tempLock("crash");
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "hold-process-lock.ts"), lock], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toContain("locked");
    reader.releaseLock();
    expect(await entryKind(lock)).toBe("symlink");
    await expect(mkdir(lock)).rejects.toMatchObject({ code: "EEXIST" }); // older builds see it as taken
    await expect(withProcessLock(lock, async () => "unexpected", { timeoutMs: 150 })).rejects.toThrow("Timed out waiting for the lock");

    child.kill("SIGKILL");
    await child.exited;
    expect(await entryKind(lock)).toBe("symlink"); // the crash left the marker behind
    expect(await withProcessLock(lock, async () => "recovered", { timeoutMs: 2_000 })).toBe("recovered");
    expect(await entryKind(lock)).toBe("missing");
  } finally {
    child.kill();
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
});

test("a lock directory from an older build is respected, then reported with its path", async () => {
  const { root, lock } = await tempLock("legacy");
  try {
    await mkdir(lock, { recursive: true });
    await expect(withProcessLock(lock, async () => "unexpected", { timeoutMs: 60 })).rejects.toThrow(`A lock directory exists at ${lock}`);
    await expect(withProcessLock(lock, async () => "unexpected", { timeoutMs: 0, busyMessage: "Another Tend service command is already running." }))
      .rejects.toThrow("Another Tend service command is already running. A lock directory exists at");
    await rm(lock, { recursive: true, force: true });
    expect(await withProcessLock(lock, async () => "acquired")).toBe("acquired");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an older build releasing its directory mid-wait hands the lock over", async () => {
  const { root, lock } = await tempLock("handoff");
  try {
    await mkdir(lock, { recursive: true });
    const waiting = withProcessLock(lock, async () => "handed over", { timeoutMs: 2_000 });
    await Bun.sleep(80);
    await rm(lock, { recursive: true, force: true });
    expect(await waiting).toBe("handed over");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failing callback still releases the lock and leaves no artifacts behind", async () => {
  const { root, lock } = await tempLock("release");
  try {
    await expect(withProcessLock(lock, async () => { throw new Error("callback failed"); })).rejects.toThrow("callback failed");
    expect(await entryKind(lock)).toBe("missing");
    expect(await entryKind(`${lock}.sqlite-journal`)).toBe("missing");
    expect(await withProcessLock(lock, async () => "released")).toBe("released");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("callers in one process take turns", async () => {
  const { root, lock } = await tempLock("serial");
  try {
    const order: string[] = [];
    let firstAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => { firstAcquired = resolve; });
    const first = withProcessLock(lock, async () => { order.push("first:start"); firstAcquired(); await Bun.sleep(120); order.push("first:end"); });
    await acquired;
    const second = withProcessLock(lock, async () => { order.push("second:start"); });
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lock artifacts are recognized so backups can skip them", () => {
  for (const name of [".mutation-lock", ".mutation-lock.sqlite", ".mutation-lock.sqlite-journal", ".agent-wake-lock", ".agent-wake-lock.sqlite"]) {
    expect(isLockArtifact(path.join("/x/data", name))).toBe(true);
  }
  expect(isLockArtifact("/x/data/cards/.mutation-lockish.json")).toBe(false);
  expect(isLockArtifact("/x/data/attention.db")).toBe(false);
});
