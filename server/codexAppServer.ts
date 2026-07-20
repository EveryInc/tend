import { spawn } from "node:child_process";
import readline from "node:readline";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

declare const Bun: {
  spawn(command: string[], options?: Record<string, unknown>): {
    exited: Promise<number>;
    kill(signal?: number): void;
    stdin: { write(chunk: string): unknown; flush?: () => unknown; end(): unknown };
    stdout: ReadableStream<Uint8Array> | null;
    stderr: ReadableStream<Uint8Array> | null;
  };
};

export const DEFAULT_CONTROL_SOCKET = path.join(os.homedir(), ".codex", "app-server-control", "app-server-control.sock");

export interface AppServerDrainOptions {
  threadId: string;
  prompt: string;
  cwd: string;
  writableRoots?: string[];
  controlSocket?: string | null;
  timeoutMs?: number;
  log?: (line: string) => void | Promise<void>;
  argv?: string[];
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

type RuntimeEnvironment = Record<string, string | undefined>;

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

export function resolveLaunchCwd(requestedCwd: string, serviceCwd = process.cwd()): string {
  if (isDirectory(requestedCwd)) return requestedCwd;
  if (isDirectory(serviceCwd)) return serviceCwd;
  throw new Error(`Codex working directory is unavailable (requested: ${requestedCwd}, service: ${serviceCwd}).`);
}

export function resolveCodexCommand(
  environment: RuntimeEnvironment = process.env,
  home = os.homedir(),
  bundledCodex = "/Applications/ChatGPT.app/Contents/Resources/codex",
): string[] {
  if (environment.ATTENTION_CODEX_BIN) {
    return environment.ATTENTION_NODE_BIN
      ? [environment.ATTENTION_NODE_BIN, environment.ATTENTION_CODEX_BIN]
      : [environment.ATTENTION_CODEX_BIN];
  }
  if (existsSync(bundledCodex)) return [bundledCodex];
  const pathDirectories = (environment.PATH ?? "").split(path.delimiter).filter(Boolean);
  const nvmRoot = path.join(home, ".nvm", "versions", "node");
  const nvmDirectories = existsSync(nvmRoot)
    ? readdirSync(nvmRoot).sort((left, right) => right.localeCompare(left, undefined, { numeric: true })).map((version) => path.join(nvmRoot, version, "bin"))
    : [];
  const directories = [
    ...pathDirectories,
    ...nvmDirectories,
    path.join(home, ".volta", "bin"),
    path.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const directory of new Set(directories)) {
    const codex = path.join(directory, "codex");
    if (!existsSync(codex)) continue;
    const node = path.join(directory, "node");
    try {
      if (readFileSync(codex, "utf8").startsWith("#!/usr/bin/env node") && existsSync(node)) return [node, codex];
    } catch {
      // Native launchers are not UTF-8 scripts and can run directly.
    }
    return [codex];
  }
  throw new Error("Codex CLI was not found. Set ATTENTION_CODEX_BIN and, for JavaScript installs, ATTENTION_NODE_BIN before starting Tend.");
}

export function appServerArgv(
  controlSocket: string | null | undefined,
  environment: RuntimeEnvironment = process.env,
  home = os.homedir(),
  bundledCodex?: string,
): string[] {
  const command = resolveCodexCommand(environment, home, bundledCodex);
  const socket = controlSocket === null ? null : controlSocket ?? DEFAULT_CONTROL_SOCKET;
  if (socket && existsSync(socket)) return [...command, "app-server", "proxy", "--sock", socket];
  return [...command, "app-server"];
}

export async function runAppServerDrain(options: AppServerDrainOptions): Promise<number> {
  const log = options.log ?? (() => {});
  const timeoutMs = options.timeoutMs ?? Number(process.env.ATTENTION_DRAIN_TIMEOUT_MS ?? 15 * 60_000);
  const argv = options.argv ?? appServerArgv(options.controlSocket);
  await log(`[app-server] launching: ${argv.join(" ")}`);
  const cwd = resolveLaunchCwd(options.cwd);
  const child = Bun.spawn(argv, { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let settled = false;
  let exitCode = 1;

  const finish = (code: number, reason: string) => {
    if (settled) return;
    settled = true;
    exitCode = code;
    void log(`[app-server] ${reason}`);
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  };

  const send = (message: Record<string, unknown>) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.flush?.();
  };

  const request = (method: string, params?: unknown): Promise<unknown> => {
    const id = nextId++;
    const promise = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }));
    send({ method, id, ...(params === undefined ? {} : { params }) });
    return promise;
  };

  const answerServerRequest = (id: unknown, method: string) => {
    void log(`[app-server] declining server request ${method}`);
    const result = method === "execCommandApproval" || method === "applyPatchApproval"
      ? { decision: "denied" }
      : { decision: "decline" };
    send({ id, result } as Record<string, unknown>);
  };

  const pipeStderr = (async () => {
    if (!child.stderr) return;
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr as unknown as AsyncIterable<Uint8Array>) {
      await log(`[app-server:err] ${decoder.decode(chunk).trimEnd()}`);
    }
  })();

  const turnDone = new Promise<void>((resolveTurn) => {
    void (async () => {
      if (!child.stdout) return;
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of child.stdout as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk);
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (!line) continue;
          let message: Record<string, unknown>;
          try {
            message = JSON.parse(line) as Record<string, unknown>;
          } catch {
            await log(`[app-server:raw] ${line.slice(0, 400)}`);
            continue;
          }
          if (message.id !== undefined && message.method === undefined) {
            const entry = pending.get(message.id as number);
            if (!entry) continue;
            pending.delete(message.id as number);
            if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error).slice(0, 500)));
            else entry.resolve(message.result);
            continue;
          }
          if (message.id !== undefined && typeof message.method === "string") {
            answerServerRequest(message.id, message.method);
            continue;
          }
          if (message.method === "turn/completed") {
            const params = message.params as { threadId?: string; turn?: { status?: string } } | undefined;
            if (params?.threadId === options.threadId) {
              const status = params.turn?.status ?? "unknown";
              finish(status === "completed" ? 0 : 1, `turn finished with status ${status}`);
              resolveTurn();
            }
          }
        }
      }
      resolveTurn();
    })();
  });

  const timeout = setTimeout(() => {
    finish(1, `drain timed out after ${Math.round(timeoutMs / 1000)}s`);
  }, timeoutMs);

  try {
    await request("initialize", { clientInfo: { name: "tend_dispatcher", title: "Tend auto-drain", version: "0.1.0" } });
    send({ method: "initialized" });
    await request("thread/resume", {
      threadId: options.threadId,
      cwd,
      approvalPolicy: "never",
      persistExtendedHistory: false,
    });
    await request("turn/start", {
      threadId: options.threadId,
      input: [{ type: "text", text: options.prompt }],
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: options.writableRoots ?? [],
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    });
    await turnDone;
  } catch (error) {
    finish(1, `protocol failure: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
    try {
      child.stdin.end();
    } catch {
      // Already closed.
    }
    try {
      child.kill();
    } catch {
      // Already gone.
    }
    await Promise.race([child.exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    await pipeStderr.catch(() => {});
    if (!settled) finish(1, "app-server exited before the turn completed");
  }
  return exitCode;
}

export interface StartedCodexThread {
  threadId: string;
  deepLink: string;
}

export interface StartCodexThreadOptions {
  argv?: string[];
  serviceCwd?: string;
}

export function startCodexThread(prompt: string, cwd: string, options: StartCodexThreadOptions = {}): Promise<StartedCodexThread> {
  return new Promise((resolve, reject) => {
    const argv = options.argv ?? appServerArgv(undefined);
    const launchCwd = resolveLaunchCwd(cwd, options.serviceCwd);
    const child = spawn(argv[0], argv.slice(1), { cwd: launchCwd, stdio: ["pipe", "pipe", "pipe"] });
    const lines = readline.createInterface({ input: child.stdout });
    let threadId = "";
    let settled = false;
    let stderr = "";
    const timeout = setTimeout(() => fail(new Error("Codex did not start the conversation in time.")), 20_000);
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const finish = () => {
      clearTimeout(timeout);
      lines.close();
      child.stdin.end();
      child.kill();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      finish();
      reject(error);
    };

    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4_000); });
    child.on("error", fail);
    child.on("exit", (code) => {
      if (!settled) fail(new Error(stderr.trim() || `Codex app-server exited before starting the conversation (${code ?? "unknown"}).`));
    });
    lines.on("line", (line) => {
      let message: { id?: number; method?: string; result?: any; error?: { message?: string } };
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.error) return fail(new Error(message.error.message || "Codex rejected the conversation."));
      if (message.method === "turn/completed" && settled) return finish();
      if (message.id === 0) {
        send({ method: "initialized", params: {} });
        send({ method: "thread/start", id: 1, params: { cwd: launchCwd, approvalPolicy: "never", sandbox: "workspace-write" } });
      } else if (message.id === 1) {
        threadId = String(message.result?.thread?.id ?? "");
        if (!threadId) return fail(new Error("Codex did not return a conversation ID."));
        send({
          method: "turn/start",
          id: 2,
          params: { threadId, input: [{ type: "text", text: prompt, text_elements: [] }] },
        });
      } else if (message.id === 2 && !settled) {
        settled = true;
        clearTimeout(timeout);
        resolve({ threadId, deepLink: `codex://threads/${encodeURIComponent(threadId)}` });
        // Keep app-server attached while the autonomous first turn runs.
        child.unref();
      }
    });
    send({
      method: "initialize",
      id: 0,
      params: { clientInfo: { name: "tend", title: "Tend", version: "0.2.0" } },
    });
  });
}
