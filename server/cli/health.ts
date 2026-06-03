import { existsSync } from "node:fs";
import { attentionDataDir, attentionDbPath, attentionHome } from "../paths";
import { apiUrl, initRuntime, localPaths, mcpUrl, print } from "./shared";

type DoctorCheck = { name: string; ok: boolean; detail: string };

export async function statusCommand(): Promise<void> {
  const sqlite = await initRuntime();
  print({ ...localPaths(), sqlite: sqlite.status() });
  sqlite.close();
}

export async function doctorCommand(): Promise<void> {
  const sqlite = await initRuntime();
  const status = sqlite.status();
  const checks = [
    { name: "home", ok: existsSync(attentionHome()), detail: attentionHome() },
    { name: "data directory", ok: existsSync(attentionDataDir()), detail: attentionDataDir() },
    { name: "sqlite database", ok: existsSync(attentionDbPath()) && status.schemaVersion >= 1, detail: `${attentionDbPath()} schema=${status.schemaVersion}` },
    await checkApiStatus(),
  ];
  print({ ok: checks.every((check) => check.ok), checks });
  sqlite.close();
}

async function checkApiStatus(): Promise<DoctorCheck> {
  const url = `${apiUrl()}/api/status`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return { name: "local api", ok: false, detail: `${url} returned HTTP ${response.status}` };
    const status = await response.json() as { ok?: boolean; mcpUrl?: string; sqlite?: { schemaVersion?: number } };
    const ok = status.ok === true && status.mcpUrl === mcpUrl() && Number(status.sqlite?.schemaVersion ?? 0) >= 1;
    return { name: "local api", ok, detail: ok ? `${url} reachable; MCP ${mcpUrl()}` : `${url} returned an unexpected status payload` };
  } catch (error) {
    const reason = error instanceof Error && error.name === "AbortError" ? "timed out" : "not reachable";
    return { name: "local api", ok: false, detail: `${url} ${reason}. Run attention start, then rerun doctor.` };
  } finally {
    clearTimeout(timeout);
  }
}
