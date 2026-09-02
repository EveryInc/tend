import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseClaudeResult, parseCodexResult, readerProcessFailure, ReaderExecutionError } from "../server/readerAdapters";

describe("sanitized reader login failures", () => {
  test("recognizes an expired subscription session without exposing private diagnostics", () => {
    const raw = JSON.stringify({ is_error: true,
      result: "Failed to authenticate: OAuth session expired and could not be refreshed. private@example.test token=fixture-private-token",
      usage: { input_tokens: 0, output_tokens: 0 } });
    let error: ReaderExecutionError | undefined;
    try { parseClaudeResult(raw, "claude-fixture"); } catch (caught) { error = caught as ReaderExecutionError; }
    expect(error).toMatchObject({ failureCode: "subscription_login_required", rawOutput: raw });
    expect(error!.message).toContain("Sign in");
    expect(error!.message).not.toContain("private@example.test");
    expect(error!.message).not.toContain("fixture-private-token");
  });

  test("does not classify successful model text about OAuth as a login failure", () => {
    const text = JSON.stringify({ flags: [{ id: "auth", title: "OAuth expired", face: "Discuss the error message as source evidence." }] });
    const result = parseClaudeResult(JSON.stringify({ is_error: false, result: text, modelUsage: { "claude-fixture": { inputTokens: 4, outputTokens: 8 } } }), "claude-fixture");
    expect(result.rawOutput).toBe(text);
    expect(() => parseClaudeResult("null", "claude-fixture")).toThrow("did not complete successfully");
  });

  test("recognizes failed Codex auth events without classifying successful quoted diagnostics", () => {
    const failed = JSON.stringify({ type: "turn.failed", error: { message: "refresh_token_reused private@example.test" } });
    expect(() => parseCodexResult(failed, "{}", "codex-fixture")).toThrow("Sign in");
    const complete = [
      { type: "item.completed", item: { type: "agent_message", text: "Failed to authenticate was the meeting topic." } },
      { type: "turn.completed", usage: { output_tokens: 10 } },
    ].map((event) => JSON.stringify(event)).join("\n");
    expect(parseCodexResult(complete, "{}", "codex-fixture").output).toEqual({});
  });

  test("keeps non-auth failures distinct and all raw process diagnostics out of the public error", () => {
    const response = { stdout: "", stderr: "Rate limit exceeded for private@example.test", code: 1 };
    const error = readerProcessFailure("claude", response);
    expect(error.failureCode).toBeUndefined();
    expect(error.message).toContain("exited unsuccessfully");
    expect(error.message).not.toContain("private@example.test");
    expect(JSON.parse(error.rawOutput!).stderr).toBe(response.stderr);
  });

  for (const adapter of ["claude", "codex"] as const) {
    for (const stage of ["preflight", "generation"] as const) {
      test(`${adapter} ${stage} login failure stops without retries or fallback`, async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "tend-reader-login-"));
        try {
          const callsFile = path.join(root, "calls.jsonl");
          const fixture = path.join(process.cwd(), "test/fixtures/reader-cli.ts");
          await writeFile(path.join(root, adapter), `#!${process.execPath}\nimport ${JSON.stringify(fixture)};\n`, { mode: 0o700 });
          const script = `
import { createReaderAdapters } from ${JSON.stringify(path.join(process.cwd(), "server/readerAdapters.ts"))};
try {
  await createReaderAdapters()[${JSON.stringify(adapter)}]({ id: "fixture", label: "Fixture", adapter: ${JSON.stringify(adapter)}, model: "fixture-model", effort: "high" }, "Synthetic packet.", new AbortController().signal);
  process.exit(2);
} catch (error) {
  console.log(JSON.stringify({ message: error.message, failureCode: error.failureCode, rawOutput: error.rawOutput }));
}
`;
          const child = Bun.spawn([process.execPath, "--eval", script], {
            env: { ...process.env, PATH: `${root}:${process.env.PATH}`, TEND_TEST_READER_ADAPTER: adapter, TEND_TEST_READER_STAGE: stage, TEND_TEST_READER_CALLS: callsFile },
            stdout: "pipe", stderr: "pipe",
          });
          const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
          expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
          const error = JSON.parse(stdout);
          expect(error.failureCode).toBe("subscription_login_required");
          expect(error.message).toContain("Sign in");
          expect(error.message).not.toContain("private@example.test");
          expect(error.message).not.toContain("fixture-private-token");
          expect(error.rawOutput).toContain("fixture-private-token");
          const calls = (await readFile(callsFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
          expect(calls).toHaveLength(stage === "preflight" ? 1 : 2);
          expect(calls[0]).toEqual(adapter === "claude" ? ["auth", "status", "--json"] : ["login", "status"]);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });
    }
  }
});
