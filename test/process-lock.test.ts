import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withProcessLock } from "../server/processLock";

test("a live holder excludes competitors and process death releases ownership", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tend-process-lock-"));
  const lock = path.join(root, "lock");
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "hold-process-lock.ts"), lock], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toContain("locked");
    await expect(mkdir(lock)).rejects.toMatchObject({ code: "EEXIST" });
    reader.releaseLock();
    await expect(withProcessLock(lock, async () => "unexpected", 30)).rejects.toThrow("Timed out");
    child.kill("SIGKILL");
    await child.exited;
    expect(await withProcessLock(lock, async () => "recovered", 30)).toBe("recovered");
    await expect(withProcessLock(lock, async () => { throw new Error("callback failed"); })).rejects.toThrow("callback failed");
    expect(await withProcessLock(lock, async () => "released")).toBe("released");
  } finally {
    child.kill();
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
});

test("ownerless legacy locks are not mistaken for dead processes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tend-legacy-lock-"));
  try {
    const lock = path.join(root, "lock");
    await mkdir(lock);
    await expect(withProcessLock(lock, async () => "unexpected")).rejects.toThrow("Stop all older Tend processes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
