import { expect, test } from "bun:test";
import path from "node:path";
test("browser regression in an isolated process", async () => {
  const child = Bun.spawn([process.execPath, "test", path.join(import.meta.dir, "queued-work-undo.browser.tsx")], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, output: code ? stdout + stderr : "" }).toEqual({ code: 0, output: "" });
}, 15_000);
