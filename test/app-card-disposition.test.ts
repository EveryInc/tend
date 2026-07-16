import { expect, test } from "bun:test";
import path from "node:path";

test("App disposition wiring passes in an isolated browser process", async () => {
  const child = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "support", "app-card-disposition-browser.tsx")],
    {
      cwd: path.join(import.meta.dir, ".."),
      env: { ...process.env, FORCE_COLOR: "0" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
});
