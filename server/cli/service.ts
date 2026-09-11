import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { attentionDataDir, attentionHome, attentionLogDir } from "../paths";
import { apiPort, apiUrl, print } from "./shared";

export async function startBackgroundCommand(): Promise<void> {
  await withServiceLock(async () => {
    if (await serviceHealthy()) {
      print(`Tend is already healthy (pid ${(await readPidRecord())?.pid ?? "unknown"}, url ${apiUrl()}, home ${attentionHome()}).`);
      return;
    }
    const staleRecord = await readPidRecord();
    if (staleRecord && processAlive(staleRecord.pid)) {
      if (await ownsTendProcess(staleRecord)) {
        throw new Error(`Tend pid ${staleRecord.pid} exists but is not healthy. Run: tend restart`);
      }
    }
    await rm(pidFile(), { force: true });
    await launchDetached();
    for (let index = 0; index < 60; index += 1) {
      if (await serviceHealthy()) {
        print(`Tend is healthy (pid ${(await readPidRecord())?.pid ?? "unknown"}, url ${apiUrl()}, home ${attentionHome()}).`);
        return;
      }
      await Bun.sleep(250);
    }
    throw new Error(`Tend failed to become healthy. Recent log output:\n${await recentLogs()}`);
  });
}

export async function stopCommand(): Promise<void> {
  await withServiceLock(async () => {
    const record = await readPidRecord();
    if (!record) {
      print("Tend is not running as a background service.");
      return;
    }
    if (!processAlive(record.pid)) {
      await rm(pidFile(), { force: true });
      print("Tend is not running as a background service.");
      return;
    }
    if (!await ownsTendProcess(record)) {
      throw new Error(`Refusing to stop pid ${record.pid}: it is not the Tend process recorded by this runtime.`);
    }
    await terminate(record.pid);
    for (let index = 0; index < 40; index += 1) {
      if (!processAlive(record.pid) && !await serviceHealthy()) {
        await rm(pidFile(), { force: true });
        print(`Stopped Tend pid ${record.pid}.`);
        return;
      }
      await Bun.sleep(250);
    }
    throw new Error(`Tend pid ${record.pid} did not stop cleanly; the pid record was preserved.`);
  });
}

export async function restartCommand(): Promise<void> {
  await stopCommand();
  await startBackgroundCommand();
}

export async function healthCommand(): Promise<void> {
  const record = await readPidRecord();
  if (!await serviceHealthy()) throw new Error(`Tend${record ? ` pid ${record.pid}` : ""} is not healthy at ${apiUrl()}.`);
  print(`Tend is healthy (pid ${record?.pid ?? "unknown"}, url ${apiUrl()}, home ${attentionHome()}).`);
}

export async function logsCommand(): Promise<void> {
  print(await recentLogs());
}

async function launchDetached(): Promise<void> {
  await mkdir(attentionHome(), { recursive: true });
  await mkdir(attentionLogDir(), { recursive: true });
  const foregroundCommand = [...currentCliCommand(), "start", "--foreground"];
  const proc = Bun.spawn(backgroundCommand(foregroundCommand), {
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
  await writeFile(pidFile(), `${JSON.stringify({
    pid: proc.pid,
    command: foregroundCommand,
    home: path.resolve(attentionHome()),
    apiPort: apiPort(),
    startedAt: new Date().toISOString(),
  }, null, 2)}\n`);
}

function backgroundCommand(command: string[]): string[] {
  if (process.platform === "win32") {
    return ["cmd.exe", "/d", "/s", "/c", `${quoteWindowsCommand(command)} >> ${quoteWindowsArg(logFile())} 2>&1`];
  }
  return [
    "/bin/sh",
    "-c",
    'log="$1"; shift; exec "$@" >> "$log" 2>&1',
    "tend-bg",
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
  const status = await fetchStatus();
  return status?.ok === true
    && typeof status.dataDir === "string"
    && path.resolve(status.dataDir) === path.resolve(attentionDataDir())
    && await checkUrl(apiUrl());
}

async function fetchStatus(): Promise<{ ok?: boolean; dataDir?: string } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1000);
  try {
    const response = await fetch(`${apiUrl()}/api/status`, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json() as { ok?: boolean; dataDir?: string };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
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
    throw new Error("Another Tend service command is already running.");
  }
  try {
    await callback();
  } finally {
    await rm(lockDir(), { recursive: true, force: true });
  }
}

type ServicePidRecord = {
  pid: number;
  command: string[];
  home: string;
  apiPort: number;
  startedAt?: string;
};

async function readPidRecord(): Promise<ServicePidRecord | null> {
  try {
    const contents = (await readFile(pidFile(), "utf8")).trim();
    if (!contents) return null;
    if (/^\d+$/.test(contents)) {
      return {
        pid: Number(contents),
        command: [...currentCliCommand(), "start", "--foreground"],
        home: path.resolve(attentionHome()),
        apiPort: apiPort(),
      };
    }
    const record = JSON.parse(contents) as Partial<ServicePidRecord>;
    if (
      typeof record.pid !== "number" ||
      !Number.isInteger(record.pid) ||
      !Array.isArray(record.command) ||
      record.command.some((item) => typeof item !== "string")
    ) {
      throw new Error("Invalid Tend pid record.");
    }
    return {
      pid: record.pid,
      command: record.command,
      home: typeof record.home === "string" ? record.home : path.resolve(attentionHome()),
      apiPort: typeof record.apiPort === "number" ? record.apiPort : apiPort(),
      startedAt: record.startedAt,
    };
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function ownsTendProcess(record: ServicePidRecord): Promise<boolean> {
  if (path.resolve(record.home) !== path.resolve(attentionHome()) || record.apiPort !== apiPort()) return false;
  const commandLine = await readProcessCommandLine(record.pid);
  if (!commandLine) return false;
  const identity = record.command.find((item) => item.endsWith(".ts"))
    ?? record.command[0];
  const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  const normalizedCommand = normalize(commandLine);
  return Boolean(identity)
    && normalizedCommand.includes(normalize(identity))
    && normalizedCommand.includes("start")
    && normalizedCommand.includes("--foreground");
}

async function readProcessCommandLine(pid: number): Promise<string | null> {
  try {
    const command = process.platform === "win32"
      ? ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`]
      : ["ps", "-p", String(pid), "-ww", "-o", "command="];
    const subprocess = Bun.spawn(command, { stderr: "pipe", stdout: "pipe" });
    const [commandLine, exitCode] = await Promise.all([
      new Response(subprocess.stdout).text(),
      subprocess.exited,
    ]);
    return exitCode === 0 ? commandLine.trim() || null : null;
  } catch {
    return null;
  }
}

async function terminate(numericPid: number): Promise<void> {
  if (process.platform === "win32") {
    const subprocess = Bun.spawn(["taskkill.exe", "/PID", String(numericPid), "/T", "/F"], {
      stderr: "pipe",
      stdout: "pipe",
      windowsHide: true,
    });
    const [output, exitCode] = await Promise.all([
      new Response(subprocess.stderr).text(),
      subprocess.exited,
    ]);
    if (exitCode !== 0 && processAlive(numericPid)) {
      throw new Error(`Failed to stop Tend pid ${numericPid}: ${output.trim() || `taskkill exited with code ${exitCode}`}`);
    }
    return;
  }
  try {
    process.kill(-numericPid, "SIGTERM");
  } catch {
    try {
      process.kill(numericPid, "SIGTERM");
    } catch {
      return;
    }
  }
}

async function recentLogs(): Promise<string> {
  if (!existsSync(logFile())) return "No Tend background log exists yet.";
  const contents = await readFile(logFile(), "utf8");
  return contents.trim().split("\n").slice(-100).join("\n") || "Tend background log is empty.";
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
