import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withProcessLock } from "../server/processLock";

async function tempLock(label: string): Promise<{ root: string; lock: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), `tend-lock-${label}-`));
  return { root, lock: path.join(root, "data", ".mutation-lock") };
}

test("a killed holder releases the lock and its directory is reclaimed", async () => {
  const { root, lock } = await tempLock("crash");
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "hold-process-lock.ts"), lock], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toContain("locked");
    reader.releaseLock();
    expect(existsSync(path.join(lock, "owner.json"))).toBe(true);
    await expect(withProcessLock(lock, async () => "unexpected", { timeoutMs: 150 })).rejects.toThrow("Timed out waiting for the lock");

    child.kill("SIGKILL");
    await child.exited;
    expect(existsSync(lock)).toBe(true); // the crash left the legacy directory behind
    const started = Date.now();
    expect(await withProcessLock(lock, async () => "recovered", { timeoutMs: 2_000 })).toBe("recovered");
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(existsSync(lock)).toBe(false);
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

test("a failing callback still releases the lock and leaves no artifacts behind", async () => {
  const { root, lock } = await tempLock("release");
  try {
    await expect(withProcessLock(lock, async () => { throw new Error("callback failed"); })).rejects.toThrow("callback failed");
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(`${lock}.sqlite-journal`)).toBe(false);
    expect(await withProcessLock(lock, async () => "released")).toBe("released");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("callers in one process take turns", async () => {
  const { root, lock } = await tempLock("serial");
  try {
    const order: string[] = [];
    const first = withProcessLock(lock, async () => { order.push("first:start"); await Bun.sleep(120); order.push("first:end"); });
    await Bun.sleep(20);
    const second = withProcessLock(lock, async () => { order.push("second:start"); });
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
