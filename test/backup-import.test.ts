import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLocalRuntime } from "../server/runtime";

for (const failure of ["empty", "invalid", "first", "install", "database", "rollback", "nested", "nested-link", "success"]) {
  test(`backup import preserves recoverability on ${failure}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tend-backup-test-"));
    try {
      const home = path.join(root, "home");
      const source = failure.startsWith("nested") ? path.join(home, "data", "saved-backup") : path.join(root, "source");
      await mkdir(path.join(home, "data"), { recursive: true });
      const original = await createLocalRuntime(path.join(home, "data"), path.join(home, "attention.db"));
      original.sqlite.close();
      const originalDb = await readFile(path.join(home, "attention.db"));
      await writeFile(path.join(home, "data", "original.txt"), "original");
      const staged = await createLocalRuntime(path.join(source, "data"), path.join(root, "source.db"));
      await staged.sqlite.backupTo(path.join(source, "attention.db"));
      staged.sqlite.close();
      if (failure === "invalid") await writeFile(path.join(source, "attention.db"), "invalid sqlite");
      const input = failure === "nested-link" ? path.join(root, "backup-link") : source;
      if (failure === "nested-link") await symlink(source, input);
      const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "backup-import.ts"), failure === "empty" ? "" : input, failure], {
        env: { ...process.env, ATTENTION_HOME: home }, stdout: "pipe", stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code === 0).toBe(failure === "success");
      if (failure === "success") {
        expect(stdout).toContain('"ok": true');
        const restored = await createLocalRuntime(path.join(home, "data"), path.join(home, "attention.db"));
        expect(await restored.store.listFeedIds()).toContain("inbox");
        restored.sqlite.close();
      } else if (failure === "rollback") {
        expect(stderr).toContain("Preserved recovery files");
        const stage = (await readdir(home)).find((entry) => entry.startsWith(".attention-import-"));
        expect(stage).toBeDefined();
        expect(await readFile(path.join(home, stage!, "rollback", "data", "original.txt"), "utf8")).toBe("original");
      } else {
        expect(existsSync(path.join(home, "data", "original.txt"))).toBe(true);
        expect(await readFile(path.join(home, "attention.db"))).toEqual(originalDb);
        if (failure.startsWith("nested")) expect(existsSync(source)).toBe(true);
        if (failure === "database") expect(stderr).toContain("Injected database install failure");
        if (failure === "first") expect(stderr).toContain("Injected first rename failure");
        if (failure === "install") expect(stderr).toContain("Injected install failure");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
