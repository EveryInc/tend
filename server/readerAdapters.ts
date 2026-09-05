import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readerLoginGuidance, type ReaderConfig, type ReaderFailureCode, type ReaderReceipt } from "../shared/readers";

export interface ReaderResult {
  output: unknown;
  rawOutput: string;
  actualModel?: string;
  actualEffort?: string;
  authentication?: ReaderReceipt["authentication"];
  usage?: ReaderReceipt["usage"];
}

export type ReaderAdapter = (config: ReaderConfig, packet: string, signal: AbortSignal) => Promise<ReaderResult>;

export class ReaderExecutionError extends Error {
  constructor(message: string, readonly rawOutput?: string, readonly failureCode?: ReaderFailureCode) { super(message); }
}

function loginFailure(adapter: ReaderConfig["adapter"], rawOutput: string): ReaderExecutionError {
  return new ReaderExecutionError(readerLoginGuidance(adapter).message, rawOutput, "subscription_login_required");
}

function isLoginFailure(diagnostics: string): boolean {
  return /failed to authenticate|oauth (?:session|token) (?:has )?expired|(?:access|refresh) token (?:has |is )?expired|invalid_grant|invalid_refresh_token|refresh_token_(?:reused|expired)|not logged in|please (?:run|use) (?:\/login|claude auth login|codex login)|authentication_error/i.test(diagnostics);
}

/** Used only for a failed provider process; successful model prose is never classified as an access error. */
export function readerProcessFailure(adapter: ReaderConfig["adapter"], response: { stdout: string; stderr: string; code: number | null }): ReaderExecutionError {
  const raw = JSON.stringify({ stdout: response.stdout, stderr: response.stderr });
  if (isLoginFailure(`${response.stdout}\n${response.stderr}`)) return loginFailure(adapter, raw);
  return new ReaderExecutionError(`${adapter === "claude" ? "Claude" : "Codex"} reader exited unsuccessfully (${response.code}). No automatic retry or fallback was attempted.`, raw);
}

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const CODEX_DISABLED_FEATURES = [
  "shell_tool", "unified_exec", "apps", "browser_use", "browser_use_external", "browser_use_full_cdp_access",
  "computer_use", "in_app_browser", "image_generation", "view_image", "multi_agent", "multi_agent_v2",
  "code_mode", "code_mode_host", "code_mode_only", "code_mode_buffered_exec", "hooks", "plugins", "remote_plugin",
  "memories", "chronicle", "skill_search", "skill_mcp_dependency_install", "workspace_dependencies", "tool_suggest", "goals",
];

/** Fixed executable and argument arrays only. Neither the packet nor caller supplies executable code. */
export function readerCommand(config: ReaderConfig, outputFile: string): { binary: string; args: string[] } {
  if (config.adapter === "claude") return { binary: "claude", args: [
    "--print", "--model", config.model, "--effort", config.effort,
    "--input-format", "text", "--output-format", "json", "--safe-mode", "--tools", "",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands", "--no-chrome",
    "--no-session-persistence", "--permission-mode", "dontAsk",
  ] };
  return { binary: "codex", args: [
    "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check",
    "--sandbox", "read-only", "--model", config.model, "--config", `model_reasoning_effort=${JSON.stringify(config.effort)}`,
    "--config", 'approval_policy="never"', "--config", 'web_search="disabled"', "--config", 'model_provider="openai"',
    "--config", "mcp_servers={}", "--config", "project_doc_max_bytes=0",
    ...CODEX_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
    "--color", "never", "--json", "--output-last-message", outputFile, "-",
  ] };
}

/** Preserve normal login stores; remove only per-child settings that could select a paid/alternate route. */
export function readerEnvironment(adapter: ReaderConfig["adapter"], source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  const keys = adapter === "claude"
    ? ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "CLAUDE_CODE_EFFORT_LEVEL",
      "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_SIMPLE"]
    : ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY"];
  for (const key of keys) delete env[key];
  return env;
}

type ProcessResult = { stdout: string; stderr: string; code: number | null };

async function runProcess(binary: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; input?: string; onLine?: (line: string) => void;
}): Promise<ProcessResult> {
  if (options.signal.aborted) throw options.signal.reason;
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], shell: false });
    let stdout = "";
    let stderr = "";
    let lineBuffer = "";
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const stop = (error: Error) => {
      if (closed || failure) return;
      failure = error;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, 2_000);
      killTimer.unref();
    };
    const aborted = () => stop(options.signal.reason instanceof Error ? options.signal.reason : new Error("Reader interrupted."));
    options.signal.addEventListener("abort", aborted, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > MAX_OUTPUT_BYTES) return stop(new Error("Reader output exceeded the safe capture limit."));
      stdout += chunk;
      if (!options.onLine) return;
      lineBuffer += chunk;
      let end: number;
      while ((end = lineBuffer.indexOf("\n")) >= 0) {
        const line = lineBuffer.slice(0, end);
        lineBuffer = lineBuffer.slice(end + 1);
        try { if (line.trim()) options.onLine(line); } catch (error) { stop(error instanceof Error ? error : new Error("Unexpected reader tool call.")); }
      }
    });
    child.stderr.on("data", (chunk: string) => {
      if (Buffer.byteLength(stderr) + Buffer.byteLength(chunk) > MAX_OUTPUT_BYTES) return stop(new Error("Reader diagnostics exceeded the safe capture limit."));
      stderr += chunk;
    });
    child.on("error", (error) => { failure = new Error(`Reader executable could not start: ${error.message}`); });
    child.on("close", (code) => {
      closed = true;
      if (killTimer) clearTimeout(killTimer);
      options.signal.removeEventListener("abort", aborted);
      if (!failure && options.onLine && lineBuffer.trim()) {
        try { options.onLine(lineBuffer); } catch (error) { failure = error instanceof Error ? error : new Error("Unexpected reader output."); }
      }
      if (failure) reject(new ReaderExecutionError(failure.message, stdout));
      else resolve({ stdout, stderr, code });
    });
    child.stdin.on("error", () => { /* Process exit is handled above; never let EPIPE crash Tend. */ });
    child.stdin.end(options.input ?? "");
    if (options.signal.aborted) aborted();
  });
}

export function parseReaderContent(text: string): unknown {
  const trimmed = text.trim();
  const unwrapped = trimmed.replace(/^```(?:json)?\s*\n([\s\S]*)\n```$/, "$1");
  try {
    const output: unknown = JSON.parse(unwrapped);
    if (output === null || typeof output !== "object") throw new Error("object required");
    return output;
  } catch {
    throw new ReaderExecutionError("Reader did not return a JSON object or array. Raw output was preserved; no cards were published.", text);
  }
}

function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }

function claudePrimaryUsage(response: Record<string, any>, requestedModel: string): { actualModel: string; usage: Record<string, any> } | undefined {
  const usages = response.modelUsage;
  if (!usages || typeof usages !== "object") return undefined;
  const exact = usages[requestedModel];
  if (exact && number(exact.outputTokens)! > 0) {
    return { actualModel: typeof exact.canonicalModel === "string" ? exact.canonicalModel : requestedModel, usage: exact };
  }
  if (!/^[a-zA-Z0-9]+$/.test(requestedModel)) return undefined;
  const primaryOutputTokens = number(response.usage?.output_tokens);
  if (!primaryOutputTokens) return undefined;
  const prefix = `claude-${requestedModel}-`;
  const matches = Object.entries(usages).flatMap(([reportedModel, value]) => {
    if (!value || typeof value !== "object") return [];
    const usage = value as Record<string, any>;
    const actualModel = typeof usage.canonicalModel === "string" ? usage.canonicalModel : reportedModel;
    return number(usage.outputTokens) === primaryOutputTokens && (actualModel === `claude-${requestedModel}` || actualModel.startsWith(prefix))
      ? [{ actualModel, usage }]
      : [];
  });
  return matches.length === 1 ? matches[0] : undefined;
}

export function parseClaudeResult(stdout: string, requestedModel: string): ReaderResult {
  let response: Record<string, any>;
  try { response = JSON.parse(stdout); } catch { throw new ReaderExecutionError("Claude returned an invalid CLI receipt.", stdout); }
  if (response?.is_error === true && isLoginFailure(JSON.stringify([response.result, response.error, response.errors]))) {
    throw loginFailure("claude", stdout);
  }
  if (response?.is_error !== false || typeof response.result !== "string") throw new ReaderExecutionError("Claude did not complete successfully. No alternate model or API route was attempted.", stdout);
  const primary = claudePrimaryUsage(response, requestedModel);
  if (!primary) throw new ReaderExecutionError("Claude did not attribute output to the requested model. No cards were published.", stdout);
  return {
    output: parseReaderContent(response.result), rawOutput: response.result, actualModel: primary.actualModel, authentication: "claude_subscription",
    usage: { inputTokens: number(primary.usage.inputTokens), outputTokens: number(primary.usage.outputTokens),
      cachedInputTokens: number(primary.usage.cacheReadInputTokens) },
  };
}

/** Defense in depth: external tools are disabled in config, and any remaining tool event fails the read. */
export function assertCodexReaderEvent(line: string): void {
  let event: Record<string, any>;
  try { event = JSON.parse(line); } catch { throw new Error("Codex emitted an invalid event receipt."); }
  // The CLI emits item-level diagnostics when intentionally disabled optional
  // capabilities cannot start. Those are not tool calls; turn completion still
  // decides success below. Real execution/MCP/file events remain forbidden.
  if (event.item?.type && !["agent_message", "reasoning", "error"].includes(event.item.type)) {
    throw new Error(`Read-only Codex reader attempted a tool (${String(event.item.type).slice(0, 80)}); the run was stopped.`);
  }
}

export function parseCodexResult(stdout: string, text: string, requestedModel: string): ReaderResult {
  const events = stdout.trim().split("\n").filter(Boolean).map((line) => {
    assertCodexReaderEvent(line);
    return JSON.parse(line) as Record<string, any>;
  });
  const recentEvents = [...events].reverse();
  const completed = recentEvents.find((event) => event.type === "turn.completed");
  const failures = events.filter((event) => event.type === "turn.failed" || event.type === "error");
  if (!completed || failures.length) {
    if (isLoginFailure(JSON.stringify(failures))) throw loginFailure("codex", stdout);
    throw new ReaderExecutionError("Codex did not complete successfully.", stdout);
  }
  const returned = recentEvents.find((event) => typeof event.model === "string" || typeof event.model_slug === "string");
  const actualModel = returned?.model ?? returned?.model_slug;
  if (actualModel && actualModel !== requestedModel) throw new ReaderExecutionError("Codex reported a model different from the requested reader.", stdout);
  return {
    output: parseReaderContent(text), rawOutput: text, ...(actualModel ? { actualModel } : {}), authentication: "codex_login",
    usage: { inputTokens: number(completed.usage?.input_tokens), outputTokens: number(completed.usage?.output_tokens),
      cachedInputTokens: number(completed.usage?.cached_input_tokens) },
  };
}

export function createReaderAdapters(): Record<ReaderConfig["adapter"], ReaderAdapter> {
  const execute: ReaderAdapter = async (config, packet, signal) => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "tend-reader-"));
    const env = readerEnvironment(config.adapter);
    const outputFile = path.join(cwd, "result.json");
    try {
      if (config.adapter === "claude") {
        const auth = await runProcess("claude", ["auth", "status", "--json"], { cwd, env, signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]) });
        let status: Record<string, unknown> = {};
        try { status = JSON.parse(auth.stdout); } catch { /* A failed preflight never proceeds to generation. */ }
        if (auth.code !== 0 || status?.loggedIn !== true || status.authMethod !== "claude.ai" || status.apiProvider !== "firstParty") {
          throw loginFailure("claude", JSON.stringify({ stdout: auth.stdout, stderr: auth.stderr }));
        }
      } else {
        const auth = await runProcess("codex", ["login", "status"], { cwd, env, signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]) });
        if (auth.code !== 0 || !/logged in using ChatGPT/i.test(`${auth.stdout}\n${auth.stderr}`)) {
          throw loginFailure("codex", JSON.stringify({ stdout: auth.stdout, stderr: auth.stderr }));
        }
      }
      const command = readerCommand(config, outputFile);
      const response = await runProcess(command.binary, command.args, { cwd, env, signal, input: packet,
        ...(config.adapter === "codex" ? { onLine: assertCodexReaderEvent } : {}) });
      if (response.code !== 0) throw readerProcessFailure(config.adapter, response);
      if (config.adapter === "claude") return parseClaudeResult(response.stdout, config.model);
      let text: string;
      try { text = await readFile(outputFile, "utf8"); } catch { throw new ReaderExecutionError("Codex completed without a final answer file.", response.stdout); }
      return parseCodexResult(response.stdout, text, config.model);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  };
  return { codex: execute, claude: execute };
}
