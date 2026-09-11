import path from "node:path";
import { CliError } from "./errors";
import { apiUrl } from "./shared";

const RUNTIME_INSPECTION_COMMANDS = new Set(["help", "help:internal", "runtime:where"]);

interface LiveStatus {
  dataDir?: string;
}

export async function assertCliRuntimeMatchesLive(
  command: string,
  runtimeRoot: string,
  options: {
    explicitRuntime?: boolean;
    fetchStatus?: () => Promise<LiveStatus | null>;
  } = {},
): Promise<void> {
  if (options.explicitRuntime || RUNTIME_INSPECTION_COMMANDS.has(command)) return;
  const status = await (options.fetchStatus ?? fetchLiveStatus)();
  if (!status?.dataDir) return;

  const liveRuntimeRoot = path.resolve(status.dataDir, "..");
  if (path.resolve(runtimeRoot) === liveRuntimeRoot) return;

  throw new CliError(
    `Tend CLI runtime mismatch: this command resolved ${runtimeRoot}, but the running Tend service uses ${liveRuntimeRoot}.`,
    {
      code: "runtime_mismatch",
      hint: "Run the CLI from the canonical checkout or set ATTENTION_HOME explicitly for isolated validation.",
    },
  );
}

async function fetchLiveStatus(): Promise<LiveStatus | null> {
  try {
    const response = await fetch(`${apiUrl()}/api/status`, { signal: AbortSignal.timeout(500) });
    if (!response.ok) return null;
    return await response.json() as LiveStatus;
  } catch {
    return null;
  }
}
