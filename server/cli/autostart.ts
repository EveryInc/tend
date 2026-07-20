import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { attentionHome } from "../paths";
import { currentCliCommand, resolveClientDir } from "./executable";
import { apiPort, print } from "./shared";

export const AUTOSTART_LABEL = "com.every.tend";

type LaunchctlResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type LaunchctlRunner = (args: string[]) => Promise<LaunchctlResult>;

export type AutostartOptions = {
  platform?: NodeJS.Platform;
  userHome?: string;
  uid?: number;
  runtimeHome?: string;
  port?: number;
  command?: string[];
  clientDir?: string;
  runLaunchctl?: LaunchctlRunner;
};

export type AutostartStatus = {
  supported: true;
  installed: boolean;
  loaded: boolean;
  label: string;
  plistPath: string;
};

type AutostartIdentity = Pick<AutostartStatus, "label" | "plistPath"> & {
  domainTarget: string;
  serviceTarget: string;
};

type AutostartConfig = AutostartIdentity & {
  command: string[];
  runtimeHome: string;
  clientDir: string;
  port: number;
  logPath: string;
};

export async function autostartCommand(args: string[]): Promise<void> {
  const [subcommand = "status", ...rest] = args;
  if (rest.length > 0) throw new Error(`Unexpected autostart argument: ${rest[0]}`);
  switch (subcommand) {
    case "install": {
      const status = await installAutostart();
      print(`Tend will start automatically when you log in.\nLaunchAgent: ${status.plistPath}\nUI: http://127.0.0.1:${apiPort()}`);
      return;
    }
    case "uninstall": {
      const status = await uninstallAutostart();
      print(`Tend login startup is disabled.\nLaunchAgent: ${status.plistPath}\nThe currently running Tend service was not stopped.`);
      return;
    }
    case "status":
      print(await autostartStatus());
      return;
    default:
      throw new Error("Expected: tend autostart install, tend autostart status, or tend autostart uninstall");
  }
}

export async function installAutostart(options: AutostartOptions = {}): Promise<AutostartStatus> {
  const identity = resolveAutostartIdentity(options);
  const config = resolveAutostartConfig(options, identity);
  const runLaunchctl = options.runLaunchctl ?? runLaunchctlCommand;
  await mkdir(path.dirname(config.plistPath), { recursive: true });
  await mkdir(path.dirname(config.logPath), { recursive: true });
  const previousPlist = existsSync(config.plistPath) ? await readFile(config.plistPath, "utf8") : null;
  const wasLoaded = (await runLaunchctl(["print", config.serviceTarget])).exitCode === 0;
  const candidatePath = `${config.plistPath}.${process.pid}.candidate`;
  await writeFile(candidatePath, renderLaunchAgentPlist(config), { mode: 0o644 });
  let launchdMutationAttempted = false;
  let candidateInstalled = false;

  try {
    const enabled = await runLaunchctl(["enable", config.serviceTarget]);
    if (enabled.exitCode !== 0) throw launchctlError("enable", enabled);
    if (wasLoaded) {
      launchdMutationAttempted = true;
      const result = await runLaunchctl(["bootout", config.serviceTarget]);
      if (result.exitCode !== 0) throw launchctlError("bootout", result);
    }
    await rename(candidatePath, config.plistPath);
    candidateInstalled = true;
    launchdMutationAttempted = true;
    const bootstrapped = await runLaunchctl(["bootstrap", config.domainTarget, config.plistPath]);
    if (bootstrapped.exitCode !== 0) throw launchctlError("bootstrap", bootstrapped);
  } catch (error) {
    const rollbackError = await rollbackAutostartInstall({
      launchdMutationAttempted,
      candidateInstalled,
      config,
      previousPlist,
      runLaunchctl,
      wasLoaded,
    });
    if (rollbackError) {
      throw new Error(`${errorMessage(error)} Rollback also failed: ${errorMessage(rollbackError)}`, { cause: error });
    }
    throw error;
  } finally {
    await rm(candidatePath, { force: true });
  }

  return statusFor(identity, true, true);
}

export async function uninstallAutostart(options: AutostartOptions = {}): Promise<AutostartStatus> {
  const identity = resolveAutostartIdentity(options);
  const runLaunchctl = options.runLaunchctl ?? runLaunchctlCommand;
  const loaded = (await runLaunchctl(["print", identity.serviceTarget])).exitCode === 0;
  if (loaded) {
    const bootedOut = await runLaunchctl(["bootout", identity.serviceTarget]);
    if (bootedOut.exitCode !== 0) throw launchctlError("bootout", bootedOut);
  }
  await rm(identity.plistPath, { force: true });
  return statusFor(identity, false, false);
}

export async function autostartStatus(options: AutostartOptions = {}): Promise<AutostartStatus> {
  const identity = resolveAutostartIdentity(options);
  const runLaunchctl = options.runLaunchctl ?? runLaunchctlCommand;
  return statusFor(
    identity,
    existsSync(identity.plistPath),
    (await runLaunchctl(["print", identity.serviceTarget])).exitCode === 0,
  );
}

export function renderLaunchAgentPlist(config: Pick<AutostartConfig,
  "label" | "command" | "runtimeHome" | "clientDir" | "port" | "logPath"
>): string {
  const argumentsXml = [...config.command, "start"]
    .map((argument) => `      <string>${escapeXml(argument)}</string>`)
    .join("\n");
  const workingDirectory = path.dirname(config.clientDir);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(config.label)}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ATTENTION_HOME</key>
    <string>${escapeXml(config.runtimeHome)}</string>
    <key>ATTENTION_API_PORT</key>
    <string>${config.port}</string>
    <key>ATTENTION_CLIENT_DIR</key>
    <string>${escapeXml(config.clientDir)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(config.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(config.logPath)}</string>
</dict>
</plist>
`;
}

function resolveAutostartIdentity(options: AutostartOptions): AutostartIdentity {
  if ((options.platform ?? process.platform) !== "darwin") {
    throw new Error("Tend autostart currently supports macOS LaunchAgents only.");
  }
  const userHome = path.resolve(options.userHome ?? homedir());
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) throw new Error("Tend could not determine the current macOS user id.");
  return {
    label: AUTOSTART_LABEL,
    plistPath: path.join(userHome, "Library", "LaunchAgents", `${AUTOSTART_LABEL}.plist`),
    domainTarget: `gui/${uid}`,
    serviceTarget: `gui/${uid}/${AUTOSTART_LABEL}`,
  };
}

function resolveAutostartConfig(options: AutostartOptions, identity: AutostartIdentity): AutostartConfig {
  const runtimeHome = path.resolve(options.runtimeHome ?? attentionHome());
  const clientDir = path.resolve(options.clientDir ?? resolveClientDir());
  const command = options.command ?? currentCliCommand();
  if (command.length === 0) throw new Error("Tend could not resolve an executable command for autostart.");
  if (!existsSync(path.join(clientDir, "index.html"))) {
    throw new Error(`Built Tend UI assets were not found at ${clientDir}. Run the UI build before installing autostart.`);
  }
  return {
    ...identity,
    command,
    runtimeHome,
    clientDir,
    port: options.port ?? apiPort(),
    logPath: path.join(runtimeHome, "logs", "autostart.log"),
  };
}

function statusFor(identity: AutostartIdentity, installed: boolean, loaded: boolean): AutostartStatus {
  return {
    supported: true,
    installed,
    loaded,
    label: identity.label,
    plistPath: identity.plistPath,
  };
}

async function rollbackAutostartInstall(options: {
  launchdMutationAttempted: boolean;
  candidateInstalled: boolean;
  config: AutostartConfig;
  previousPlist: string | null;
  runLaunchctl: LaunchctlRunner;
  wasLoaded: boolean;
}): Promise<Error | null> {
  const { launchdMutationAttempted, candidateInstalled, config, previousPlist, runLaunchctl, wasLoaded } = options;
  if (!launchdMutationAttempted && !candidateInstalled) return null;
  try {
    const loaded = (await runLaunchctl(["print", config.serviceTarget])).exitCode === 0;
    if (loaded) {
      const bootedOut = await runLaunchctl(["bootout", config.serviceTarget]);
      if (bootedOut.exitCode !== 0
        && (await runLaunchctl(["print", config.serviceTarget])).exitCode === 0) {
        throw launchctlError("bootout during rollback", bootedOut);
      }
    }
    if (candidateInstalled) await restorePlist(config.plistPath, previousPlist);
    if (wasLoaded && previousPlist !== null) {
      const restored = await runLaunchctl(["bootstrap", config.domainTarget, config.plistPath]);
      if (restored.exitCode !== 0
        && (await runLaunchctl(["print", config.serviceTarget])).exitCode !== 0) {
        throw launchctlError("bootstrap previous LaunchAgent", restored);
      }
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

async function restorePlist(plistPath: string, contents: string | null): Promise<void> {
  if (contents === null) {
    await rm(plistPath, { force: true });
    return;
  }
  const temporaryPath = `${plistPath}.${process.pid}.rollback`;
  try {
    await writeFile(temporaryPath, contents, { mode: 0o644 });
    await rename(temporaryPath, plistPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function runLaunchctlCommand(args: string[]): Promise<LaunchctlResult> {
  const subprocess = Bun.spawn(["launchctl", ...args], { stderr: "pipe", stdout: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

function launchctlError(operation: string, result: LaunchctlResult): Error {
  return new Error(`launchctl ${operation} failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
