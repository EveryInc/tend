import { expect, test } from "bun:test";
import path from "node:path";
test("cancelled SSE connections release their idle loop", async () => {
 const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "sse-cancel.ts")], { stdout: "pipe", stderr: "pipe" });
 const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
 expect({ code, output: code ? stdout + stderr : "" }).toEqual({ code: 0, output: "" });
 expect(stdout).toContain('"scheduledSleepsAfterCancel":0');
});
