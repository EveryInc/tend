import { existsSync } from "node:fs";
import path from "node:path";
import { print } from "./shared";

export function setupCodexCommand(args: string[] = []): void {
  print(setupCodexPrompt({ feedId: setupFeedId(args) }));
}

export function setupCodexPrompt(options: { binaryPath?: string; command?: string[]; skillPath?: string; attentionHome?: string; feedId?: string } = {}): string {
  const command = options.command ?? (options.binaryPath ? [options.binaryPath] : resolveAttentionCommand());
  const entryPath = command.at(-1) ?? path.resolve("tend");
  const skillPath = options.skillPath ?? resolveSkillPath(entryPath);
  const cliPrefix = commandPrefix(command, options.attentionHome ?? process.env.ATTENTION_HOME);
  const feedId = options.feedId ?? "inbox";
  return `Tend is Codex-native. Keep its local UI open in Codex Desktop's in-app browser while this thread operates the feed.

Create one fresh Codex thread for each feed. This prompt connects the current thread to "${feedId}":

Connect this Codex Desktop thread to local Tend.

Feed: ${feedId}
Local Tend entry point: ${entryPath}
Skill/reference: ${skillPath}
CLI prefix: ${cliPrefix}

Read the skill/reference file if available. Use the local Tend CLI contract, not a hosted Tend or MCP setup. Run every command through the CLI prefix above. Do setup sequentially: bind first and wait for it to finish, then propose/install the heartbeat. Bind this thread as the feed home thread with ${cliPrefix} cli feed:bind --feed ${feedId} --thread <current-codex-thread-id>, and create or update one heartbeat automation on this same thread. On each wakeup, inspect the feed, list queued work first, claim before using local connectors for queued instructions, execute and complete/fail/block/retry/cancel each claim through ${cliPrefix} cli, verify approved external actions immediately before mutation, and refresh configured sources only when no queued work is being handled.

After setup, handle the feed once now. This same thread is also the manual activation path: when the user opens or wakes it and says "go deal with the feed", run the feed immediately even if the heartbeat is paused or not due yet.
`;
}

function setupFeedId(args: string[]): string {
  const index = args.indexOf("--feed");
  if (index < 0) return "inbox";
  const feedId = args[index + 1]?.trim();
  if (!feedId || feedId.startsWith("--")) throw new Error("Expected: tend setup codex --feed <id>");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(feedId)) throw new Error("Feed id must use lowercase letters, numbers, and hyphens.");
  return feedId;
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
  return [path.resolve(sourceEntry ?? "tend")];
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
