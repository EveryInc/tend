import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type {
  MobileCommand,
  MobileCommandProgress,
  MobileCommandState,
  MobileWorkspaceSnapshot,
} from "../../shared/mobile";

export interface MobileCloudConfig {
  url: string;
  secretKey: string;
  userId: string;
  workerId: string;
}

export interface MobileCloudClient {
  replaceSnapshot(snapshot: MobileWorkspaceSnapshot): Promise<void>;
  claimCommands(limit?: number): Promise<MobileCommand[]>;
  completeCommand(
    commandId: string,
    state: Extract<MobileCommandState, "applied" | "rejected">,
    result: { workId?: string; error?: string },
  ): Promise<void>;
  syncCommandProgress(progress: MobileCommandProgress[]): Promise<void>;
}

const mobileEnvKeys = [
  "TEND_MOBILE_SUPABASE_URL",
  "TEND_MOBILE_SUPABASE_SECRET_KEY",
  "TEND_MOBILE_USER_ID",
  "TEND_MOBILE_WORKER_ID",
] as const;

export function loadMobileCloudEnvFile(env: NodeJS.ProcessEnv = process.env): void {
  const configuredPath = env.TEND_MOBILE_ENV_FILE?.trim();
  const configRoot = env.XDG_CONFIG_HOME?.trim() || path.join(homedir(), ".config");
  const envFile = configuredPath || path.join(configRoot, "tend", "mobile.env");
  if (!existsSync(envFile)) return;

  const metadata = statSync(envFile);
  if (!metadata.isFile()) throw new Error(`Tend mobile config is not a regular file: ${envFile}`);
  if (process.platform !== "win32") {
    const mode = metadata.mode & 0o777;
    if (mode !== 0o400 && mode !== 0o600) {
      throw new Error(`Refusing Tend mobile config with permissions ${mode.toString(8)}; expected 400 or 600: ${envFile}`);
    }
    const currentUserId = process.getuid?.();
    if (currentUserId !== undefined && metadata.uid !== currentUserId) {
      throw new Error(`Refusing Tend mobile config not owned by the current user: ${envFile}`);
    }
  }

  const seen = new Set<string>();
  const lines = readFileSync(envFile, "utf8").split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error(`Invalid Tend mobile config at line ${index + 1}: ${envFile}`);
    const key = line.slice(0, separator).trim();
    if (!mobileEnvKeys.includes(key as (typeof mobileEnvKeys)[number])) {
      throw new Error(`Unsupported Tend mobile config key ${key || "(empty)"}: ${envFile}`);
    }
    if (seen.has(key)) throw new Error(`Duplicate Tend mobile config key ${key}: ${envFile}`);
    seen.add(key);
    env[key] ??= line.slice(separator + 1);
  }
}

export function mobileCloudConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MobileCloudConfig | null {
  const url = env.TEND_MOBILE_SUPABASE_URL?.trim();
  const secretKey = env.TEND_MOBILE_SUPABASE_SECRET_KEY?.trim();
  const userId = env.TEND_MOBILE_USER_ID?.trim();
  const workerId = env.TEND_MOBILE_WORKER_ID?.trim();
  if (!url && !secretKey && !userId && !workerId) return null;
  if (!url || !secretKey || !userId || !workerId) {
    throw new Error("Tend mobile sync needs TEND_MOBILE_SUPABASE_URL, TEND_MOBILE_SUPABASE_SECRET_KEY, TEND_MOBILE_USER_ID, and TEND_MOBILE_WORKER_ID together.");
  }
  return {
    url: url.replace(/\/+$/, ""),
    secretKey,
    userId,
    workerId,
  };
}

export class SupabaseMobileCloudClient implements MobileCloudClient {
  constructor(private readonly config: MobileCloudConfig) {}

  async replaceSnapshot(snapshot: MobileWorkspaceSnapshot): Promise<void> {
    await this.rpc("replace_mobile_snapshot", {
      p_user_id: this.config.userId,
      p_worker_id: this.config.workerId,
      p_snapshot: snapshot,
    });
  }

  async claimCommands(limit = 20): Promise<MobileCommand[]> {
    const rows = await this.rpc<Record<string, unknown>[]>("claim_mobile_commands", {
      p_user_id: this.config.userId,
      p_worker_id: this.config.workerId,
      p_limit: limit,
    });
    return rows.map(normalizeMobileCommand);
  }

  async completeCommand(
    commandId: string,
    state: "applied" | "rejected",
    result: { workId?: string; error?: string },
  ): Promise<void> {
    await this.rpc("complete_mobile_command", {
      p_command_id: commandId,
      p_worker_id: this.config.workerId,
      p_state: state,
      p_work_id: result.workId ?? null,
      p_error: result.error ?? null,
    });
  }

  async syncCommandProgress(progress: MobileCommandProgress[]): Promise<void> {
    if (!progress.length) return;
    await this.rpc("sync_mobile_command_progress", {
      p_user_id: this.config.userId,
      p_worker_id: this.config.workerId,
      p_progress: progress,
    });
  }

  private async rpc<T = unknown>(name: string, payload: unknown): Promise<T> {
    const response = await fetch(`${this.config.url}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: this.config.secretKey,
        authorization: `Bearer ${this.config.secretKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Supabase ${name} failed (${response.status}): ${text || response.statusText}`);
    }
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }
}

export function normalizeMobileCommand(row: Record<string, unknown>): MobileCommand {
  const payload = isRecord(row.payload) ? row.payload : {};
  return {
    id: requiredString(row.id, "mobile command id"),
    userId: requiredString(row.user_id, "mobile command user"),
    clientRequestId: requiredString(row.client_request_id, "mobile command request"),
    deviceId: requiredString(row.device_id, "mobile command device"),
    feedId: requiredString(row.feed_id, "mobile command feed"),
    cardId: requiredString(row.card_id, "mobile command card"),
    feedGeneration: requiredString(row.feed_generation, "mobile command feed generation"),
    expectedCardDigest: requiredString(row.expected_card_digest, "mobile command card digest"),
    kind: requiredString(row.kind, "mobile command kind") as MobileCommand["kind"],
    ...(optionalString(payload.actionId) ? { actionId: optionalString(payload.actionId) } : {}),
    ...(optionalString(payload.expectedActionDigest) ? { expectedActionDigest: optionalString(payload.expectedActionDigest) } : {}),
    ...(optionalString(payload.routineActionGroupId) ? { routineActionGroupId: optionalString(payload.routineActionGroupId) } : {}),
    ...(optionalString(payload.instruction) ? { instruction: optionalString(payload.instruction) } : {}),
    ...(payload.edits === undefined ? {} : { edits: requiredStringRecord(payload.edits) }),
    ...(optionalString(payload.targetWorkId) ? { targetWorkId: optionalString(payload.targetWorkId) } : {}),
    ...(optionalString(payload.expectedWorkDigest) ? { expectedWorkDigest: optionalString(payload.expectedWorkDigest) } : {}),
    ...(isRiskConfirmation(payload.riskConfirmation) ? { riskConfirmation: payload.riskConfirmation } : {}),
    state: requiredString(row.state, "mobile command state") as MobileCommand["state"],
    createdAt: requiredString(row.created_at, "mobile command createdAt"),
    availableAt: requiredString(row.available_at, "mobile command availableAt"),
    ...(optionalString(row.claimed_at) ? { claimedAt: optionalString(row.claimed_at) } : {}),
    ...(optionalString(row.lease_expires_at) ? { leaseExpiresAt: optionalString(row.lease_expires_at) } : {}),
  };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Invalid ${label} from Supabase.`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== "string")) {
    throw new Error("Invalid mobile command edits from Supabase.");
  }
  return value as Record<string, string>;
}

function isRiskConfirmation(value: unknown): value is NonNullable<MobileCommand["riskConfirmation"]> {
  return isRecord(value)
    && value.kind === "external_recipient"
    && Array.isArray(value.recipients)
    && value.recipients.every((item) => typeof item === "string");
}
