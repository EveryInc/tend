import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appServerArgv,
  resolveCodexCommand,
  resolveLaunchCwd,
  runAppServerDrain,
  startCodexThread,
} from "../server/codexAppServer";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function appServerStub(root: string): Promise<string> {
  const script = path.join(root, "app-server-stub.mjs");
  await writeFile(script, `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\\n");
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      console.log(JSON.stringify({ id: message.id, result: {} }));
    } else if (message.method === "thread/resume") {
      console.log(JSON.stringify({ id: message.id, error: { message: "resume-cwd=" + message.params.cwd + ";spawn-cwd=" + process.cwd() } }));
    } else if (message.method === "thread/start") {
      console.log(JSON.stringify({ id: message.id, error: { message: "start-cwd=" + message.params.cwd + ";spawn-cwd=" + process.cwd() } }));
    }
  }
});
`);
  return script;
}

test("resolves an NVM Codex install without depending on the service PATH", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "tend-codex-runtime-"));
  roots.push(home);
  const bin = path.join(home, ".nvm", "versions", "node", "v24.13.0", "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "node"), "runtime");
  await writeFile(path.join(bin, "codex"), "#!/usr/bin/env node\nconsole.log('codex');\n");
  await chmod(path.join(bin, "node"), 0o755);
  await chmod(path.join(bin, "codex"), 0o755);

  const unavailableBundledCodex = path.join(home, "missing-codex");
  expect(resolveCodexCommand({ PATH: "/usr/bin:/bin" }, home, unavailableBundledCodex)).toEqual([
    path.join(bin, "node"),
    path.join(bin, "codex"),
  ]);
  expect(appServerArgv(null, { PATH: "/usr/bin:/bin" }, home, unavailableBundledCodex)).toEqual([
    path.join(bin, "node"),
    path.join(bin, "codex"),
    "app-server",
  ]);
});

test("prefers the native Codex desktop runtime over a user-managed Node install", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tend-codex-desktop-"));
  roots.push(root);
  const home = path.join(root, "home");
  const bundledCodex = path.join(root, "ChatGPT.app", "Contents", "Resources", "codex");
  const nvmBin = path.join(home, ".nvm", "versions", "node", "v24.13.0", "bin");
  await mkdir(path.dirname(bundledCodex), { recursive: true });
  await mkdir(nvmBin, { recursive: true });
  await writeFile(bundledCodex, "native codex");
  await writeFile(path.join(nvmBin, "node"), "runtime");
  await writeFile(path.join(nvmBin, "codex"), "#!/usr/bin/env node\n");
  await chmod(bundledCodex, 0o755);
  await chmod(path.join(nvmBin, "node"), 0o755);
  await chmod(path.join(nvmBin, "codex"), 0o755);

  expect(resolveCodexCommand({ PATH: "/usr/bin:/bin" }, home, bundledCodex)).toEqual([bundledCodex]);
});

test("honors explicit Codex and Node runtime paths for packaged installs", () => {
  expect(resolveCodexCommand({ ATTENTION_CODEX_BIN: "/opt/codex/bin/codex.js", ATTENTION_NODE_BIN: "/opt/node/bin/node" }, "/unused")).toEqual([
    "/opt/node/bin/node",
    "/opt/codex/bin/codex.js",
  ]);
});

test("replaces a packaged Bun virtual cwd with a real service cwd", async () => {
  const serviceCwd = await mkdtemp(path.join(os.tmpdir(), "tend-codex-cwd-"));
  roots.push(serviceCwd);

  expect(resolveLaunchCwd("/$bunfs/root", serviceCwd)).toBe(serviceCwd);
});

test("preserves a valid explicitly requested Codex workspace", async () => {
  const requestedCwd = await mkdtemp(path.join(os.tmpdir(), "tend-codex-workspace-"));
  const serviceCwd = await mkdtemp(path.join(os.tmpdir(), "tend-codex-service-"));
  roots.push(requestedCwd, serviceCwd);

  expect(resolveLaunchCwd(requestedCwd, serviceCwd)).toBe(requestedCwd);
});

test("reports unavailable working directories before spawning Codex", () => {
  expect(() => resolveLaunchCwd("/$bunfs/root", "/missing/tend-service-cwd")).toThrow(
    "Codex working directory is unavailable",
  );
});

test("sends the resolved service cwd to the app-server drain resume request", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tend-codex-drain-cwd-"));
  roots.push(root);
  const script = await appServerStub(root);
  const logs: string[] = [];
  const resolvedCwd = resolveLaunchCwd("/$bunfs/root");

  const exitCode = await runAppServerDrain({
    threadId: "thread-drain",
    prompt: "Drain the inbox.",
    cwd: "/$bunfs/root",
    argv: [process.execPath, script],
    timeoutMs: 2_000,
    log: (line) => logs.push(line),
  });

  expect(exitCode).toBe(1);
  expect(logs.join("\n")).toContain(`resume-cwd=${resolvedCwd};`);
  expect(logs.join("\n")).not.toContain("resume-cwd=/$bunfs/root");
});

test("sends the resolved service cwd to the app-server thread start request", async () => {
  const serviceCwd = await mkdtemp(path.join(os.tmpdir(), "tend-codex-thread-cwd-"));
  roots.push(serviceCwd);
  const script = await appServerStub(serviceCwd);

  await expect(startCodexThread("Investigate this email.", "/$bunfs/root", {
    argv: [process.execPath, script],
    serviceCwd,
  })).rejects.toThrow(`start-cwd=${serviceCwd};`);
});
