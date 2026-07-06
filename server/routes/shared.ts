import { timingSafeEqual } from "node:crypto";
import type { AttentionDomain } from "../domain";
import type { LocalSqliteStore } from "../sqlite";
import type { AttentionStore } from "../store";
import type { MobileSyncStatus } from "../../shared/mobile";

export type Notify = (data: unknown) => void;

export type LocalRouteContext = {
  artifactsDir: string;
  dataDir: string;
  domain: AttentionDomain;
  notify: Notify;
  port: number;
  root: string;
  sqlite: LocalSqliteStore;
  store: AttentionStore;
  mobileStatus?: () => MobileSyncStatus;
  mutationToken: string;
};

export async function body(c: any): Promise<Record<string, unknown>> {
  const value = await c.req.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function isAllowedLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    // Require an explicit dev-server port so ambient localhost origins do not get mutation rights.
    return (url.hostname === "127.0.0.1" || url.hostname === "localhost") && Boolean(url.port);
  } catch {
    return false;
  }
}

export async function mutation(c: any, notify: Notify, callback: () => Promise<unknown>, shouldNotify: (result: unknown) => boolean = () => true) {
  const origin = c.req.header("origin");
  if (origin && !isAllowedLocalOrigin(origin)) {
    return c.json({ error: "Mutating requests are only accepted from localhost origins." }, 403);
  }
  try {
    const result = await callback();
    if (shouldNotify(result)) notify({ changedAt: new Date().toISOString() });
    return c.json(redactBrowserMutationResult(result));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
}

function redactBrowserMutationResult(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactBrowserMutationResult);

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "capabilityToken") continue;
    output[key] = redactBrowserMutationResult(item);
  }
  return output;
}

export function mutationAccessError(c: any, expectedToken: string): Response | null {
  if (c.req.method !== "POST") return null;
  const contentType = c.req.header("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return c.json({ error: "Mutation requests require application/json." }, 415);
  }
  const origin = c.req.header("origin");
  if (!origin) return null;
  if (origin && !isLoopbackOrigin(origin)) {
    return c.json({ error: "Cross-origin mutation requests are not allowed." }, 403);
  }
  const suppliedToken = c.req.header("x-attention-mutation-token") ?? "";
  if (!tokensMatch(suppliedToken, expectedToken)) {
    return c.json({ error: "A current local mutation token is required." }, 403);
  }
  return null;
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:")
      && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
  } catch {
    return false;
  }
}

function tokensMatch(left: string, right: string): boolean {
  if (!right) return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
