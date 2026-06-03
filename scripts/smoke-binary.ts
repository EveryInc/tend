import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const binaryPath = path.resolve(process.env.ATTENTION_BINARY ?? path.join("dist-bin", "attention"));
const port = process.env.ATTENTION_API_PORT ?? "4599";
const home = await mkdtemp(path.join(os.tmpdir(), "attention-smoke-"));
const statusUrl = `http://127.0.0.1:${port}/api/status`;
const mcpUrl = `http://127.0.0.1:${port}/mcp`;

if (!existsSync(binaryPath)) {
  throw new Error(`Compiled binary not found: ${binaryPath}. Run pnpm attention:build first.`);
}

const server = Bun.spawn([binaryPath, "start"], {
  env: { ...process.env, ATTENTION_HOME: home, ATTENTION_API_PORT: port },
  stderr: "inherit",
  stdout: "inherit",
});

try {
  const status = await waitForStatus();
  const schemaVersion = Number(status.sqlite?.schemaVersion ?? 0);
  if (status.ok !== true) throw new Error("/api/status did not report ok=true.");
  if (status.mcpUrl !== mcpUrl) throw new Error(`/api/status reported ${status.mcpUrl} instead of ${mcpUrl}.`);
  if (schemaVersion !== 11) throw new Error(`/api/status reported schema ${schemaVersion} instead of 11.`);
  const ui = await fetchUi();
  console.log(JSON.stringify({ ok: true, statusUrl, mcpUrl, schemaVersion, ui, home }, null, 2));
} finally {
  server.kill();
  await server.exited.catch(() => undefined);
  await rm(home, { recursive: true, force: true });
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

async function waitForStatus(): Promise<{ ok?: boolean; mcpUrl?: string; sqlite?: { schemaVersion?: number } }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(statusUrl);
      if (response.ok) return await response.json() as { ok?: boolean; mcpUrl?: string; sqlite?: { schemaVersion?: number } };
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
