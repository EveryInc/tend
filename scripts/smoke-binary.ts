import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { APP_VERSION, MCP_CONTRACT_VERSION } from "../server/version";

const binaryPath = path.resolve(process.env.ATTENTION_BINARY ?? path.join("dist-bin", "attention"));
const cwd = path.resolve(process.env.ATTENTION_SMOKE_CWD ?? process.cwd());
const port = process.env.ATTENTION_API_PORT ?? "4599";
const home = await mkdtemp(path.join(os.tmpdir(), "attention-smoke-"));
const statusUrl = `http://127.0.0.1:${port}/api/status`;
const mcpUrl = `http://127.0.0.1:${port}/mcp`;

if (!existsSync(binaryPath)) {
  throw new Error(`Compiled binary not found: ${binaryPath}. Run pnpm attention:build first.`);
}

const binaryVersion = await readBinaryVersion();
if (binaryVersion.version !== APP_VERSION) {
  throw new Error(`Compiled binary reported version ${binaryVersion.version} instead of ${APP_VERSION}.`);
}
if (binaryVersion.mcpContractVersion !== MCP_CONTRACT_VERSION) {
  throw new Error(`Compiled binary reported MCP contract ${binaryVersion.mcpContractVersion} instead of ${MCP_CONTRACT_VERSION}.`);
}

const server = Bun.spawn([binaryPath, "start"], {
  cwd,
  env: { ...process.env, ATTENTION_HOME: home, ATTENTION_API_PORT: port },
  stderr: "inherit",
  stdout: "inherit",
});

try {
  const status = await waitForStatus();
  const schemaVersion = Number(status.sqlite?.schemaVersion ?? 0);
  if (status.ok !== true) throw new Error("/api/status did not report ok=true.");
  if (status.mcpUrl !== mcpUrl) throw new Error(`/api/status reported ${status.mcpUrl} instead of ${mcpUrl}.`);
  if (status.version?.version !== APP_VERSION) throw new Error(`/api/status reported version ${status.version?.version} instead of ${APP_VERSION}.`);
  if (status.version?.mcpContractVersion !== MCP_CONTRACT_VERSION) {
    throw new Error(`/api/status reported MCP contract ${status.version?.mcpContractVersion} instead of ${MCP_CONTRACT_VERSION}.`);
  }
  if (schemaVersion !== 11) throw new Error(`/api/status reported schema ${schemaVersion} instead of 11.`);
  const ui = await fetchUi();
  const mcp = await validateMcp();
  console.log(JSON.stringify({ ok: true, statusUrl, mcpUrl, version: status.version, schemaVersion, ui, mcp, binaryVersion, binaryPath, cwd, home }, null, 2));
} finally {
  server.kill();
  await server.exited.catch(() => undefined);
  await rm(home, { recursive: true, force: true });
}

async function readBinaryVersion(): Promise<{ version?: string; mcpContractVersion?: string }> {
  const subprocess = Bun.spawn([binaryPath, "version"], {
    cwd,
    env: { ...process.env, ATTENTION_HOME: home, ATTENTION_API_PORT: port },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  if (exitCode !== 0) throw new Error(`attention version failed with exit code ${exitCode}: ${stderr}`);
  return JSON.parse(stdout) as { version?: string; mcpContractVersion?: string };
}

async function validateMcp(): Promise<{ tools: string[]; prompts: string[]; firstToolCount: number; inspectFeed: boolean }> {
  const first = await connectMcpClient("first");
  const firstTools = await first.listTools();
  await first.close();

  const second = await connectMcpClient("second");
  try {
    const tools = await second.listTools();
    const prompts = await second.listPrompts();
    const inspect = await second.callTool({ name: "inspect_feed", arguments: { feedId: "inbox" } });
    const inspectContent = inspect.content as Array<{ type: string; text?: string }>;
    const inspectText = inspectContent.find((item) => item.type === "text")?.text ?? "";
    const toolNames = tools.tools.map((tool) => tool.name);
    const requiredTools = ["inspect_feed", "bind_feed_thread", "list_work", "claim_work", "complete_work", "upsert_card"];
    const missingTools = requiredTools.filter((tool) => !toolNames.includes(tool));
    if (missingTools.length > 0) throw new Error(`MCP is missing required tools: ${missingTools.join(", ")}`);
    if (!inspectText.includes("Inbox")) throw new Error("MCP inspect_feed did not return the Inbox feed.");
    return {
      tools: toolNames,
      prompts: prompts.prompts.map((prompt) => prompt.name),
      firstToolCount: firstTools.tools.length,
      inspectFeed: true,
    };
  } finally {
    await second.close();
  }
}

async function connectMcpClient(label: string): Promise<Client> {
  const client = new Client({ name: `attention-smoke-${label}`, version: APP_VERSION });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
  await client.connect(transport);
  return client;
}

async function fetchUi(): Promise<{ url: string; title: string }> {
  const url = `http://127.0.0.1:${port}/`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  const html = await response.text();
  if (!html.includes("<title>Attention</title>") || !html.includes('<div id="root"></div>')) {
    throw new Error(`${url} did not return the built Attention UI.`);
  }
  return { url, title: "Attention" };
}

async function waitForStatus(): Promise<{ ok?: boolean; mcpUrl?: string; version?: { version?: string; mcpContractVersion?: string }; sqlite?: { schemaVersion?: number } }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(statusUrl);
      if (response.ok) return await response.json() as { ok?: boolean; mcpUrl?: string; version?: { version?: string; mcpContractVersion?: string }; sqlite?: { schemaVersion?: number } };
      lastError = new Error(`${statusUrl} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${statusUrl}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
