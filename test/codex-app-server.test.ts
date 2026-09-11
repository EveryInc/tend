import { expect, test } from "bun:test";
import { declinedServerReply, runAppServerDrain, type AppServerDrainOptions } from "../server/codexAppServer";
import type { NativeApprovalRequest } from "../server/nativeApprovals";

function run(scenario: string, onNativeApproval?: AppServerDrainOptions["onNativeApproval"], timeoutMs = 2_000) {
  return runAppServerDrain({ threadId: "thread-inbox", prompt: "Test fixture only.", cwd: process.cwd(),
    argv: [process.execPath, new URL("./fixtures/native-app-server.ts", import.meta.url).pathname, scenario],
    timeoutMs, onNativeApproval });
}

test("native question waits for human input, forwards exact answers once, and inherits host policy", async () => {
  let ready!: (request: NativeApprovalRequest) => void;
  const requested = new Promise<NativeApprovalRequest>((resolve) => { ready = resolve; });
  let answer!: (reply: unknown) => void;
  const reply = new Promise((resolve) => { answer = resolve; });
  let calls = 0;
  let done = false;
  const result = run("duplicate", (request) => { calls++; ready(request); return reply; }).then((code) => { done = true; return code; });
  expect(await requested).toMatchObject({ requestId: 88, tool: { id: "tool-item", threadId: "thread-inbox", turnId: "turn-one",
    arguments: { to: "reader@example.test", body: "Exact body." } } });
  await Bun.sleep(30);
  expect(done).toBe(false);
  expect(calls).toBe(1);
  answer({ answers: { send: { answers: ["Send once"] } } });
  expect(await result).toBe(0);
  expect(calls).toBe(1);
});

for (const scenario of ["uncorrelated-elicitation", "missing-item", "missing-tool", "wrong-thread", "wrong-turn", "reused-turn"]) {
  test(`declines ${scenario} without inventing an association`, async () => {
    let calls = 0;
    expect(await run(scenario, async () => { calls++; return {}; })).toBe(0);
    expect(calls).toBe(0);
  });
}

for (const scenario of ["cancel-request", "cancel-item", "cancel-turn", "changed-arguments", "disconnect", "timeout"]) {
  test(`${scenario} aborts the pending UI and never sends its late answer`, async () => {
    let aborted = false;
    const result = await run(scenario, (_request, signal) => new Promise((resolve) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        resolve({ answers: { send: { answers: ["Send once"] } } });
      }, { once: true });
    }), scenario === "timeout" ? 150 : 2_000);
    expect(aborted).toBe(true);
    expect(result).toBe(["disconnect", "timeout"].includes(scenario) ? 1 : 0);
  });
}

test("transport failure during initialization terminates without waiting forever", async () => {
  expect(await run("disconnect-initialize")).toBe(1);
});

test("declines each unsupported request using its protocol response shape", () => {
  expect(declinedServerReply("mcpServer/elicitation/request")).toEqual({ result: { action: "decline", content: null } });
  expect(declinedServerReply("item/tool/requestUserInput")).toEqual({ result: { answers: {} } });
  expect(declinedServerReply("execCommandApproval")).toEqual({ result: { decision: "denied" } });
  expect(declinedServerReply("item/commandExecution/requestApproval")).toEqual({ result: { decision: "decline" } });
  expect(declinedServerReply("unknown/request")).toMatchObject({ error: { code: -32601 } });
});
