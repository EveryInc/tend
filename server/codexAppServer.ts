import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { nativeQuestions, type NativeApprovalRequest, type NativeToolCall } from "./nativeApprovals";

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
  onNativeApproval?: (request: NativeApprovalRequest, signal: AbortSignal) => Promise<unknown>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export function appServerArgv(controlSocket: string | null | undefined): string[] {
  const socket = controlSocket === null ? null : controlSocket ?? DEFAULT_CONTROL_SOCKET;
  if (socket && existsSync(socket)) return ["codex", "app-server", "proxy", "--sock", socket];
  return ["codex", "app-server"];
}

export async function runAppServerDrain(options: AppServerDrainOptions): Promise<number> {
  const log = options.log ?? (() => {});
  const timeoutMs = options.timeoutMs ?? Number(process.env.ATTENTION_DRAIN_TIMEOUT_MS ?? 15 * 60_000);
  const argv = options.argv ?? appServerArgv(options.controlSocket);
  await log(`[app-server] launching: ${argv.join(" ")}`);

  const child = Bun.spawn(argv, { cwd: options.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let settled = false;
  let exitCode = 1;
  let startingTurn = false;
  let turnId: string | undefined;
  const toolCalls = new Map<string, NativeToolCall>();
  const nativeRequests = new Map<string | number, { controller: AbortController; itemId: string }>();
  const seenRequests = new Set<string | number>();

  const cancelNative = (id: string | number) => {
    const request = nativeRequests.get(id);
    nativeRequests.delete(id);
    request?.controller.abort();
  };

  const finish = (code: number, reason: string) => {
    if (settled) return;
    settled = true;
    exitCode = code;
    for (const id of nativeRequests.keys()) cancelNative(id);
    for (const entry of pending.values()) entry.reject(new Error(reason));
    pending.clear();
    void log(`[app-server] ${reason}`);
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  };

  const send = (message: Record<string, unknown>) => {
    if (settled) throw new Error("App-server transport is closed.");
    child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.flush?.();
  };

  const request = (method: string, params?: unknown): Promise<unknown> => {
    const id = nextId++;
    const promise = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }));
    send({ method, id, ...(params === undefined ? {} : { params }) });
    return promise;
  };

  const answerServerRequest = (id: string | number, method: string, params: Record<string, unknown>) => {
    if (seenRequests.has(id)) return;
    seenRequests.add(id);
    if (method === "item/tool/requestUserInput" || method === "tool/requestUserInput") {
      const tool = typeof params.itemId === "string" ? toolCalls.get(params.itemId) : undefined;
      // Only the host's explicit item/thread/turn identity can associate a question with a tool.
      if (options.onNativeApproval && tool && tool.threadId === params.threadId
        && tool.turnId === params.turnId && tool.turnId === turnId) {
        try {
          const questions = nativeQuestions(params);
          const controller = new AbortController();
          nativeRequests.set(id, { controller, itemId: tool.id });
          void options.onNativeApproval({ requestId: id, method, tool, questions }, controller.signal)
            .catch(() => {
              void log("[app-server] native confirmation could not be safely presented");
              return { answers: {} };
            })
            .then((result) => {
              if (settled || nativeRequests.get(id)?.controller !== controller) return;
              nativeRequests.delete(id);
              try { send({ id, result }); } catch { finish(1, "native confirmation transport failed"); }
            });
          return;
        } catch {
          cancelNative(id);
          void log("[app-server] unsupported native confirmation questions");
        }
      } else {
        void log("[app-server] native question has no exact active tool association");
      }
    }
    void log(`[app-server] declining server request ${method}`);
    const reply = declinedServerReply(method);
    send({ id, ...reply });
  };

  void child.exited.then(() => finish(1, "app-server exited before the turn completed"));

  const pipeStderr = (async () => {
    if (!child.stderr) return;
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr as unknown as AsyncIterable<Uint8Array>) {
      await log(`[app-server:err] ${decoder.decode(chunk, { stream: true }).trimEnd()}`);
    }
  })();

  const turnDone = new Promise<void>((resolveTurn) => {
    void (async () => {
      if (!child.stdout) return;
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of child.stdout as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
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
            if (typeof message.id === "string" || typeof message.id === "number") {
              answerServerRequest(message.id, message.method, (message.params ?? {}) as Record<string, unknown>);
            }
            continue;
          }
          const params = message.params as Record<string, any> | undefined;
          if (params?.threadId !== options.threadId) continue;
          if (message.method === "turn/started" && startingTurn && !turnId && typeof params.turn?.id === "string") {
            turnId = params.turn.id;
          }
          if (message.method === "item/started" && turnId && params.turnId === turnId) {
            const item = params.item;
            if (item?.type === "mcpToolCall" && typeof item.id === "string"
              && typeof item.server === "string" && typeof item.tool === "string") {
              const existing = toolCalls.get(item.id);
              if (existing) {
                for (const [id, request] of nativeRequests) if (request.itemId === item.id) cancelNative(id);
              }
              toolCalls.set(item.id, { id: item.id, threadId: options.threadId, turnId,
                server: item.server, tool: item.tool, arguments: structuredClone(item.arguments) });
            }
          }
          if (message.method === "serverRequest/resolved"
            && (typeof params.requestId === "string" || typeof params.requestId === "number")) cancelNative(params.requestId);
          if (message.method === "item/completed" && params.turnId === turnId && typeof params.item?.id === "string") {
            toolCalls.delete(params.item.id);
            for (const [id, request] of nativeRequests) if (request.itemId === params.item.id) cancelNative(id);
          }
          if (message.method === "turn/completed") {
            if (turnId && params.turn?.id === turnId) {
              const status = params.turn?.status ?? "unknown";
              finish(status === "completed" ? 0 : 1, `turn finished with status ${status}`);
              resolveTurn();
            }
          }
        }
      }
      resolveTurn();
    })().catch(() => {
      finish(1, "app-server response stream failed");
      resolveTurn();
    });
  });

  const timeout = setTimeout(() => {
    finish(1, `drain timed out after ${Math.round(timeoutMs / 1000)}s`);
  }, timeoutMs);

  try {
    await request("initialize", { clientInfo: { name: "tend_dispatcher", title: "Tend auto-drain", version: "0.1.0" } });
    send({ method: "initialized" });
    await request("thread/resume", {
      threadId: options.threadId,
      cwd: options.cwd,
      persistExtendedHistory: false,
    });
    startingTurn = true;
    const started = await request("turn/start", {
      threadId: options.threadId,
      input: [{ type: "text", text: options.prompt }],
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: options.writableRoots ?? [],
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    }) as { turn?: { id?: string } };
    turnId ??= started.turn?.id;
    await turnDone;
  } catch (error) {
    finish(1, `protocol failure: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
    for (const id of nativeRequests.keys()) cancelNative(id);
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

export function declinedServerReply(method: string): Record<string, unknown> {
  if (method === "mcpServer/elicitation/request") return { result: { action: "decline", content: null } };
  if (method === "item/tool/requestUserInput" || method === "tool/requestUserInput") return { result: { answers: {} } };
  if (method === "execCommandApproval" || method === "applyPatchApproval") return { result: { decision: "denied" } };
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") return { result: { decision: "decline" } };
  if (method === "item/permissions/requestApproval") return { result: { permissions: {}, scope: "turn" } };
  return { error: { code: -32601, message: "Tend does not support this server request." } };
}
