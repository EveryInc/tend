import { existsSync } from "node:fs";
import path from "node:path";
import { print } from "./shared";

export function setupCodexCommand(): void {
  print(setupCodexPrompt());
}

export function setupCodexPrompt(options: { binaryPath?: string; command?: string[]; skillPath?: string; attentionHome?: string } = {}): string {
  const command = options.command ?? (options.binaryPath ? [options.binaryPath] : resolveAttentionCommand());
  const entryPath = command.at(-1) ?? path.resolve("attention");
  const skillPath = options.skillPath ?? resolveSkillPath(entryPath);
  const cliPrefix = commandPrefix(command, options.attentionHome ?? process.env.ATTENTION_HOME);
  return `Start one fresh Codex thread per feed and use this prompt:

Connect this Codex Desktop thread to local Attention.

Feed: inbox
Local Attention entry point: ${entryPath}
Skill/reference: ${skillPath}
CLI prefix: ${cliPrefix}

Read the skill/reference file if available. Use the local Attention CLI contract, not a hosted Attention or MCP setup. Run every command through the CLI prefix above. Do setup sequentially: bind first and wait for it to finish, then propose/install the heartbeat. Bind this thread as the feed home thread with ${cliPrefix} cli feed:bind --feed inbox --thread <current-codex-thread-id>, and create or update one heartbeat automation on this same thread. On each wakeup, inspect the feed, list queued work first, claim before using local connectors for queued instructions, execute and complete/fail/block/retry/cancel each claim through ${cliPrefix} cli, verify approved external actions immediately before mutation, and refresh configured sources only when no queued work is being handled.
`;
}

function resolveAttentionCommand(): string[] {
  const sourceEntry = process.argv[1];
  if (
    sourceEntry
    && !sourceEntry.startsWith("/$bunfs/")
    && /\.(?:[cm]?[jt]s|tsx)$/.test(sourceEntry)
    && existsSync(sourceEntry)
  ) {
    return [path.resolve(process.execPath), path.resolve(sourceEntry)];
  }
  for (const candidate of [process.argv[0], process.execPath]) {
    if (candidate && !candidate.startsWith("/$bunfs/") && existsSync(candidate)) return [path.resolve(candidate)];
  }
  return [path.resolve(sourceEntry ?? "attention")];
}

function resolveSkillPath(entryPath: string): string {
  const packaged = path.join(path.dirname(entryPath), "docs", "SKILL.md");
  if (existsSync(packaged)) return packaged;
  const source = path.resolve("docs", "SKILL.md");
  if (existsSync(source)) return source;
  return packaged;
}

function commandPrefix(command: string[], attentionHome?: string): string {
  const executable = command.map(shellQuote).join(" ");
  return attentionHome ? `ATTENTION_HOME=${shellQuote(attentionHome)} ${executable}` : executable;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
