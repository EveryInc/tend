import { existsSync } from "node:fs";
import { attentionDataDir, attentionDbPath, attentionHome } from "../paths";
import { versionInfo } from "../version";
import { apiUrl, initRuntime, localPaths, print } from "./shared";

type DoctorCheck = { name: string; ok: boolean; detail: string };

export async function statusCommand(): Promise<void> {
  const sqlite = await initRuntime();
  print({ version: versionInfo(), ...localPaths(), sqlite: sqlite.status() });
  sqlite.close();
}

export async function doctorCommand(): Promise<void> {
  const sqlite = await initRuntime();
  const status = sqlite.status();
  const checks = [
    { name: "app version", ok: true, detail: `${versionInfo().name} ${versionInfo().version}; CLI contract ${versionInfo().cliContractVersion}` },
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
    const status = await response.json() as { ok?: boolean; version?: { version?: string; cliContractVersion?: string }; sqlite?: { schemaVersion?: number } };
    const expected = versionInfo();
    const ok = status.ok === true &&
      status.version?.version === expected.version &&
      status.version?.cliContractVersion === expected.cliContractVersion &&
      Number(status.sqlite?.schemaVersion ?? 0) >= 1;
    return { name: "local api", ok, detail: ok ? `${url} reachable` : `${url} returned an unexpected status payload` };
  } catch (error) {
    const reason = error instanceof Error && error.name === "AbortError" ? "timed out" : "not reachable";
    return { name: "local api", ok: false, detail: `${url} ${reason}. Run tend start, then rerun doctor.` };
  } finally {
    clearTimeout(timeout);
  }
}
