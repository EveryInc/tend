#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { attentionDataDir, attentionDbPath, attentionHome } from "./server/paths";
import { LocalSqliteStore } from "./server/sqlite";

const rawArgs = process.argv.slice(2);
if (rawArgs[0] === "--") rawArgs.shift();
const [command = "help", subcommand, ...rest] = rawArgs;
const apiPort = Number(process.env.ATTENTION_API_PORT ?? 4332);

function print(value: unknown): void {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
}

async function initRuntime(): Promise<LocalSqliteStore> {
  await mkdir(attentionHome(), { recursive: true });
  await mkdir(attentionDataDir(), { recursive: true });
  const sqlite = new LocalSqliteStore();
  await sqlite.init();
  return sqlite;
}

async function status(): Promise<void> {
  const sqlite = await initRuntime();
  print({
    home: attentionHome(),
    dataDir: attentionDataDir(),
    dbPath: attentionDbPath(),
    apiUrl: `http://127.0.0.1:${apiPort}`,
    uiUrl: `http://127.0.0.1:${apiPort}`,
    mcpUrl: `http://127.0.0.1:${apiPort}/mcp`,
    sqlite: sqlite.status(),
  });
  sqlite.close();
}

async function doctor(): Promise<void> {
  const sqlite = await initRuntime();
  const checks = [
    { name: "home", ok: existsSync(attentionHome()), detail: attentionHome() },
    { name: "data directory", ok: existsSync(attentionDataDir()), detail: attentionDataDir() },
    { name: "sqlite metadata", ok: sqlite.status().schemaVersion >= 1, detail: attentionDbPath() },
    { name: "mcp endpoint", ok: true, detail: `Run attention start, then configure Codex MCP to http://127.0.0.1:${apiPort}/mcp` },
  ];
  print({ ok: checks.every((check) => check.ok), checks });
  sqlite.close();
}

function setupCodex(): void {
  const mcpUrl = `http://127.0.0.1:${apiPort}/mcp`;
  print(`Add this MCP server to Codex Desktop:

Name: attention
URL: ${mcpUrl}

Then start one fresh Codex thread per feed and use this prompt:

Connect this Codex Desktop thread to local Attention.

MCP server: ${mcpUrl}
Feed: inbox

Inspect the feed, bind this thread as the feed home thread with bind_feed_thread, and create or update one heartbeat automation on this same thread. On each wakeup, inspect the feed, list queued work first, claim before using local connectors for queued instructions, execute and complete/fail/block/retry/cancel each claim through Attention MCP, verify approved external actions immediately before mutation, and refresh configured sources only when no queued work is being handled.
`);
}

async function backupExport(targetPath: string): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  if (existsSync(targetPath)) await rm(targetPath, { recursive: true, force: true });
  await cp(attentionDataDir(), targetPath, { recursive: true });
  print({ ok: true, exported: attentionDataDir(), to: targetPath });
}

async function backupImport(sourcePath: string): Promise<void> {
  if (!existsSync(sourcePath)) throw new Error(`Backup path does not exist: ${sourcePath}`);
  await mkdir(path.dirname(attentionDataDir()), { recursive: true });
  if (existsSync(attentionDataDir())) await rm(attentionDataDir(), { recursive: true, force: true });
  await cp(sourcePath, attentionDataDir(), { recursive: true });
  print({ ok: true, imported: sourcePath, to: attentionDataDir() });
}

async function runLegacyCli(args: string[]): Promise<void> {
  process.argv = [process.argv[0] ?? "bun", "cli.ts", ...args];
  await import("./cli");
}

switch (command) {
  case "start":
    await initRuntime();
    process.env.ATTENTION_CLIENT_DIR ??= path.join(process.cwd(), "dist");
    print(`attention starting
UI:  http://127.0.0.1:${apiPort}
API: http://127.0.0.1:${apiPort}
MCP: http://127.0.0.1:${apiPort}/mcp
Data: ${attentionDataDir()}
`);
    await import("./server");
    break;
  case "status":
    await status();
    break;
  case "doctor":
    await doctor();
    break;
  case "setup":
    if (subcommand !== "codex") throw new Error("Expected: attention setup codex");
    setupCodex();
    break;
  case "backup":
    if (subcommand === "export") await backupExport(rest[0] ?? path.join(attentionHome(), "exports", `attention-${Date.now()}`));
    else if (subcommand === "import") await backupImport(rest[0] ?? "");
    else throw new Error("Expected: attention backup export [path] or attention backup import <path>");
    break;
  case "help":
    print({
      commands: [
        "attention start",
        "attention status",
        "attention doctor",
        "attention setup codex",
        "attention backup export [path]",
        "attention backup import <path>",
        "attention cli <existing-low-level-command> [...args]",
      ],
    });
    break;
  case "cli":
    await runLegacyCli([subcommand, ...rest].filter((value): value is string => Boolean(value)));
    break;
  default:
    await runLegacyCli([command, subcommand, ...rest].filter((value): value is string => Boolean(value)));
}
