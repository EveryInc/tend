import path from "node:path";
import { CliError } from "./errors";

/** Readers run in Tend's existing host process, not the calling agent's sandbox. */
export async function readersApi(
  dataDir: string,
  route: string,
  value?: unknown,
  options: { fetcher?: typeof fetch; ports?: number[] } = {},
): Promise<unknown> {
  const fetcher = options.fetcher ?? fetch;
  const configuredPort = process.env.ATTENTION_API_PORT;
  const ports = options.ports ?? (configuredPort ? [Number(configuredPort)] : [4332, 4333]);
  for (const port of new Set(ports)) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("ATTENTION_API_PORT must be a valid local port.");
    const base = `http://127.0.0.1:${port}`;
    let status: { dataDir?: string };
    try {
      const response = await fetcher(`${base}/api/status`, { signal: AbortSignal.timeout(2000) });
      if (!response.ok) continue;
      status = await response.json() as { dataDir?: string };
    } catch {
      continue;
    }
    if (typeof status.dataDir !== "string" || path.resolve(status.dataDir) !== path.resolve(dataDir)) continue;
    const headers: Record<string, string> = {};
    if (value !== undefined) {
      const session = await fetcher(`${base}/api/session`, { signal: AbortSignal.timeout(2000) });
      if (!session.ok) throw new Error("Could not obtain the local Tend session.");
      const sessionValue = await session.json() as { mutationToken?: unknown };
      if (typeof sessionValue.mutationToken !== "string" || !sessionValue.mutationToken.trim()) {
        throw new Error("The local Tend session did not return a valid mutation token. No reader request was sent.");
      }
      headers["content-type"] = "application/json";
      headers["x-attention-mutation-token"] = sessionValue.mutationToken;
    }
    const response = await fetcher(`${base}${route}`, {
      method: value === undefined ? "GET" : "POST",
      headers,
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      signal: AbortSignal.timeout(30000),
    });
    const result = await response.json() as { error?: string; code?: string };
    if (!response.ok) throw new CliError(result.error ?? `Tend returned ${response.status}.`, {
      code: result.code ?? "reader_request_failed",
      hint: "Read the current source run and its reader status before retrying. A different packet or reader configuration needs a new source run.",
    });
    return result;
  }
  throw new CliError("No running Tend service owns this runtime.", {
    code: "reader_service_unavailable",
    hint: "Use the canonical running Tend instance, or start an isolated validation server with ATTENTION_HOME and ATTENTION_API_PORT set explicitly. No reader was launched.",
  });
}
