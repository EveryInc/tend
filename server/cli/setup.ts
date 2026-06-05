import { existsSync } from "node:fs";
import path from "node:path";
import { print } from "./shared";

export function setupCodexCommand(): void {
  print(setupCodexPrompt());
}

export function setupCodexPrompt(options: { binaryPath?: string; skillPath?: string; attentionHome?: string } = {}): string {
  const binaryPath = options.binaryPath ?? resolveAttentionBinaryPath();
  const skillPath = options.skillPath ?? resolveSkillPath(binaryPath);
  const cliPrefix = commandPrefix(binaryPath, options.attentionHome ?? process.env.ATTENTION_HOME);
  return `Start one fresh Codex thread per feed and use this prompt:

Connect this Codex Desktop thread to local Attention.

Feed: inbox
Local Attention binary: ${binaryPath}
Skill/reference: ${skillPath}
CLI prefix: ${cliPrefix}

Read the skill/reference file if available. Use the local Attention CLI contract, not a hosted Attention or MCP setup. Run every command through the CLI prefix above. Do setup sequentially: bind first and wait for it to finish, then propose/install the heartbeat. Bind this thread as the feed home thread with ${cliPrefix} cli feed:bind --feed inbox --thread <current-codex-thread-id>, and create or update one heartbeat automation on this same thread. On each wakeup, inspect the feed, list queued work first, claim before using local connectors for queued instructions, execute and complete/fail/block/retry/cancel each claim through ${cliPrefix} cli, verify approved external actions immediately before mutation, and refresh configured sources only when no queued work is being handled.
`;
}

function resolveAttentionBinaryPath(): string {
  for (const candidate of [process.argv[1], process.argv[0], process.execPath]) {
    if (candidate && !candidate.startsWith("/$bunfs/") && existsSync(candidate)) return path.resolve(candidate);
  }
  if (process.execPath && existsSync(process.execPath)) return path.resolve(process.execPath);
  return path.resolve(process.argv[1] ?? "attention");
}

function resolveSkillPath(binaryPath: string): string {
  const packaged = path.join(path.dirname(binaryPath), "docs", "SKILL.md");
  if (existsSync(packaged)) return packaged;
  const source = path.resolve("docs", "SKILL.md");
  if (existsSync(source)) return source;
  return packaged;
}

function commandPrefix(binaryPath: string, attentionHome?: string): string {
  const executable = shellQuote(binaryPath);
  return attentionHome ? `ATTENTION_HOME=${shellQuote(attentionHome)} ${executable}` : executable;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
