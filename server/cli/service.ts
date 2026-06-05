import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { attentionHome, attentionLogDir } from "../paths";
import { apiPort, apiUrl, print } from "./shared";

export async function startBackgroundCommand(): Promise<void> {
  await withServiceLock(async () => {
    if (await serviceHealthy()) {
      print(`Attention is already healthy (pid ${await readPid() ?? "unknown"}, url ${apiUrl()}, home ${attentionHome()}).`);
      return;
    }
    const stalePid = await readPid();
    if (stalePid && processAlive(stalePid)) {
      throw new Error(`Attention pid ${stalePid} exists but is not healthy. Run: attention restart`);
    }
    await rm(pidFile(), { force: true });
    await launchDetached();
    for (let index = 0; index < 60; index += 1) {
      if (await serviceHealthy()) {
        print(`Attention is healthy (pid ${await readPid() ?? "unknown"}, url ${apiUrl()}, home ${attentionHome()}).`);
        return;
      }
      await Bun.sleep(250);
    }
    throw new Error(`Attention failed to become healthy. Recent log output:\n${await recentLogs()}`);
  });
}

export async function stopCommand(): Promise<void> {
  await withServiceLock(async () => {
    const pid = await readPid();
    if (!pid) {
      print("Attention is not running as a background service.");
      return;
    }
    terminate(pid);
    await rm(pidFile(), { force: true });
    for (let index = 0; index < 40; index += 1) {
      if (!await serviceHealthy()) break;
      await Bun.sleep(250);
    }
    print(`Stopped Attention pid ${pid}.`);
  });
}

export async function restartCommand(): Promise<void> {
  await stopCommand();
  await startBackgroundCommand();
}

export async function healthCommand(): Promise<void> {
  const pid = await readPid();
  if (!await serviceHealthy()) throw new Error(`Attention${pid ? ` pid ${pid}` : ""} is not healthy at ${apiUrl()}.`);
  print(`Attention is healthy (pid ${pid ?? "unknown"}, url ${apiUrl()}, home ${attentionHome()}).`);
}

export async function logsCommand(): Promise<void> {
  print(await recentLogs());
}

async function launchDetached(): Promise<void> {
  await mkdir(attentionHome(), { recursive: true });
  await mkdir(attentionLogDir(), { recursive: true });
  const proc = Bun.spawn(backgroundCommand(), {
    cwd: process.cwd(),
    detached: true,
    env: {
      ...process.env,
      ATTENTION_HOME: attentionHome(),
      ATTENTION_API_PORT: String(apiPort()),
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    windowsHide: true,
  });
  proc.unref();
  await writeFile(pidFile(), `${proc.pid}\n`);
}

function backgroundCommand(): string[] {
  const command = [...currentCliCommand(), "start", "--foreground"];
  if (process.platform === "win32") {
    return ["cmd.exe", "/d", "/s", "/c", `${quoteWindowsCommand(command)} >> ${quoteWindowsArg(logFile())} 2>&1`];
  }
  return [
    "/bin/sh",
    "-c",
    'log="$1"; shift; exec "$@" >> "$log" 2>&1',
    "attention-bg",
    logFile(),
    ...command,
  ];
}

function currentCliCommand(): string[] {
  const scriptPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
  if (scriptPath.endsWith(".ts") && existsSync(scriptPath)) return [process.argv[0], scriptPath];
  return [process.execPath];
}

async function serviceHealthy(): Promise<boolean> {
  const health = await checkUrl(`${apiUrl()}/api/health`);
  const ui = await checkUrl(apiUrl());
  return health && ui;
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

function processAlive(pid: string): boolean {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function terminate(pid: string): void {
  const numericPid = Number(pid);
  try {
    if (process.platform !== "win32") process.kill(-numericPid, "SIGTERM");
    else process.kill(numericPid, "SIGTERM");
  } catch {
    try {
      process.kill(numericPid, "SIGTERM");
    } catch {
      return;
    }
  }
}

async function recentLogs(): Promise<string> {
  if (!existsSync(logFile())) return "No Attention background log exists yet.";
  const contents = await readFile(logFile(), "utf8");
  return contents.trim().split("\n").slice(-100).join("\n") || "Attention background log is empty.";
}

function quoteWindowsCommand(command: string[]): string {
  return command.map(quoteWindowsArg).join(" ");
}

function quoteWindowsArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function pidFile(): string {
  return path.join(attentionHome(), "attention.pid");
}

function lockDir(): string {
  return path.join(attentionHome(), "attention.lock");
}

function logFile(): string {
  return path.join(attentionLogDir(), "attention.log");
}
