import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { attentionHome } from "../paths";
import { apiPort, apiUrl, print } from "./shared";

const SERVICE_LABEL = "com.every.attention";
const SERVICE_TARGET = `gui/${process.getuid?.() ?? ""}/${SERVICE_LABEL}`;

export async function startBackgroundCommand(): Promise<void> {
  await withServiceLock(async () => {
    ensureLaunchctl();
    if (serviceExists()) {
      if (await serviceHealthy()) {
        print(`Attention is already healthy (pid ${servicePid() ?? "unknown"}, url ${apiUrl()}, runtime ${attentionHome()}).`);
        return;
      }
      throw new Error("Attention service exists but is unhealthy. Run: attention restart");
    }
    const owner = listenerPid(apiPort());
    if (owner) throw new Error(`Port ${apiPort()} is already owned by pid ${owner}. Stop that server before starting Attention.`);
    await rm(pidFile(), { force: true });
    runLaunchctl(["remove", SERVICE_LABEL], { allowFailure: true });
    await launchService();
    for (let index = 0; index < 40; index += 1) {
      if (await serviceHealthy()) {
        const pid = servicePid() ?? listenerPid(apiPort());
        if (pid) await writeFile(pidFile(), `${pid}\n`);
        print(`Attention is healthy (pid ${pid ?? "unknown"}, url ${apiUrl()}, runtime ${attentionHome()}).`);
        return;
      }
      await Bun.sleep(250);
    }
    runLaunchctl(["remove", SERVICE_LABEL], { allowFailure: true });
    await rm(pidFile(), { force: true });
    throw new Error(`Attention failed to become healthy. Recent log output:\n${await recentLogs()}`);
  });
}

export async function stopCommand(): Promise<void> {
  await withServiceLock(async () => {
    ensureLaunchctl();
    const pid = servicePid() ?? await readPid() ?? listenerPid(apiPort());
    if (!pid && !serviceExists()) {
      print("Attention is not running as a background service.");
      return;
    }
    runLaunchctl(["remove", SERVICE_LABEL], { allowFailure: true });
    if (pid) terminateTree(pid);
    await rm(pidFile(), { force: true });
    for (let index = 0; index < 40; index += 1) {
      if (!listenerPid(apiPort())) break;
      await Bun.sleep(250);
    }
    print(`Stopped Attention${pid ? ` pid ${pid}` : ""}.`);
  });
}

export async function restartCommand(): Promise<void> {
  await stopCommand();
  await startBackgroundCommand();
}

export async function healthCommand(): Promise<void> {
  ensureLaunchctl();
  const pid = servicePid() ?? await readPid() ?? listenerPid(apiPort());
  if (!await serviceHealthy()) throw new Error(`Attention${pid ? ` pid ${pid}` : ""} is not healthy at ${apiUrl()}.`);
  print(`Attention is healthy (pid ${pid ?? "unknown"}, url ${apiUrl()}, runtime ${attentionHome()}).`);
}

export async function logsCommand(): Promise<void> {
  print(await recentLogs());
}

export async function validateCommand(): Promise<void> {
  const validationHome = await mkdtemp(path.join(os.tmpdir(), "attention-validation-"));
  process.env.ATTENTION_HOME = validationHome;
  process.env.ATTENTION_API_PORT = "14333";
  process.env.ATTENTION_CLIENT_DIR ??= defaultClientDir();
  print(`Starting isolated Attention validation runtime at ${validationHome}
URL: ${apiUrl()}
`);
  await import("../../server");
}

async function launchService(): Promise<void> {
  await mkdir(attentionHome(), { recursive: true });
  await mkdir(path.dirname(logFile()), { recursive: true });
  const command = currentCliCommand();
  runLaunchctl([
    "submit",
    "-l",
    SERVICE_LABEL,
    "-o",
    logFile(),
    "-e",
    logFile(),
    "--",
    "/usr/bin/env",
    `PATH=${process.env.PATH ?? ""}`,
    `ATTENTION_HOME=${attentionHome()}`,
    `ATTENTION_API_PORT=${String(apiPort())}`,
    ...command,
    "start",
    "--foreground",
  ]);
}

function currentCliCommand(): string[] {
  const scriptPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
  if (scriptPath.endsWith(".ts") && existsSync(scriptPath)) return [process.argv[0], scriptPath];
  return [process.execPath];
}

async function serviceHealthy(): Promise<boolean> {
  const health = await checkUrl(`${apiUrl()}/api/health`);
  const ui = await checkUrl(apiUrl());
  return (health && ui) || Boolean(listenerPid(apiPort()));
}

async function checkUrl(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function withServiceLock(callback: () => Promise<void>): Promise<void> {
  await mkdir(attentionHome(), { recursive: true });
  try {
    await mkdir(lockDir());
  } catch {
    throw new Error("Another attention service command is already running.");
  }
  try {
    await callback();
  } finally {
    await rm(lockDir(), { recursive: true, force: true });
  }
}

async function readPid(): Promise<string | null> {
  try {
    return (await readFile(pidFile(), "utf8")).trim() || null;
  } catch {
    return null;
  }
}

function serviceExists(): boolean {
  return runLaunchctl(["print", SERVICE_TARGET], { allowFailure: true }).exitCode === 0;
}

function servicePid(): string | null {
  const result = runLaunchctl(["print", SERVICE_TARGET], { allowFailure: true });
  return result.stdout.match(/pid = (\d+)/)?.[1] ?? null;
}

function listenerPid(port: number): string | null {
  const result = shell(["lsof", "-nP", `-tiTCP:${port}`, "-sTCP:LISTEN"], { allowFailure: true });
  return result.stdout.trim().split("\n").filter(Boolean)[0] ?? null;
}

function terminateTree(pid: string): void {
  const children = shell(["pgrep", "-P", pid], { allowFailure: true }).stdout.trim().split("\n").filter(Boolean);
  for (const child of children) terminateTree(child);
  shell(["kill", "-TERM", pid], { allowFailure: true });
}

async function recentLogs(): Promise<string> {
  if (!existsSync(logFile())) return "No Attention service log exists yet.";
  const result = shell(["tail", "-n", "100", logFile()], { allowFailure: true });
  return result.stdout || result.stderr || "Attention service log is empty.";
}

function runLaunchctl(args: string[], options: { allowFailure?: boolean } = {}) {
  return shell(["launchctl", ...args], options);
}

function shell(command: string[], options: { allowFailure?: boolean } = {}): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  if (!options.allowFailure && result.exitCode !== 0) throw new Error(`${command.join(" ")} failed: ${stderr || stdout}`);
  return { exitCode: result.exitCode, stdout, stderr };
}

function ensureLaunchctl(): void {
  if (process.platform !== "darwin") throw new Error("Background service commands currently require macOS launchctl.");
}

function pidFile(): string {
  return path.join(attentionHome(), "attention.pid");
}

function lockDir(): string {
  return path.join(attentionHome(), "attention.lock");
}

function logFile(): string {
  return path.join(attentionHome(), "logs", "attention.log");
}

function defaultClientDir(): string {
  return path.join(process.cwd(), "dist");
}
