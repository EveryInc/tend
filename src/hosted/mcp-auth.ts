import { verifyJwsAccessToken } from "better-auth/oauth2";
import type { JWTPayload } from "jose";
import { authServerUrlFor, MCP_SCOPES, mcpResourceUrlFor } from "./auth";
import type { HostedEnv } from "./env";

type OpaqueAccessTokenRow = {
  clientId: string;
  userId: string | null;
  sessionId: string | null;
  scopes: string;
  expiresAt: string;
};

type SessionRow = {
  userId: string;
  expiresAt: string;
};

export class McpAuthError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly headers: HeadersInit = {},
  ) {
    super(message);
  }

  response(): Response {
    return new Response(this.message, { status: this.status, headers: this.headers });
  }
}

function accessTokenFrom(request: Request): string | undefined {
  const authorization = request.headers.get("authorization") ?? undefined;
  return authorization?.startsWith("Bearer ") ? authorization.replace("Bearer ", "") : authorization;
}

function parseTimestamp(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const numeric = Number(trimmed);
  const date = Number.isFinite(numeric) ? new Date(numeric) : new Date(trimmed);
  return Number.isFinite(date.getTime()) ? date : null;
}

function isExpired(value: string): boolean {
  const date = parseTimestamp(value);
  return !date || date.getTime() <= Date.now();
}

export function parseOAuthScopes(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.filter((scope): scope is string => typeof scope === "string");
  } catch {
    // Better Auth stores scopes as a space-delimited string in normal operation.
  }

  return value.split(/\s+/).filter(Boolean);
}

function assertRequiredScopes(scopes: string[]) {
  const grantedScopes = new Set(scopes);
  const missingScope = MCP_SCOPES.find((scope) => !grantedScopes.has(scope));
  if (missingScope) throw new McpAuthError(`missing required scope: ${missingScope}`, 403);
}

function unauthorized(env: HostedEnv, request: Request, message = "Unauthorized"): McpAuthError {
  const resource = mcpResourceUrlFor(env, request);
  const url = new URL(resource);
  const path = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  return new McpAuthError(message, 401, {
    "WWW-Authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource${path}"`,
  });
}

async function localJwks(env: HostedEnv): Promise<{ keys: JsonWebKey[] }> {
  const rows = await env.DB.prepare("SELECT id, publicKey FROM jwks ORDER BY createdAt DESC").all<{
    id: string;
    publicKey: string;
  }>();

  return {
    keys: rows.results.map((row) => ({
      ...JSON.parse(row.publicKey),
      kid: row.id,
      alg: "EdDSA",
    })),
  };
}

async function verifyJwtAccessToken(env: HostedEnv, request: Request, token: string): Promise<JWTPayload> {
  const authServerUrl = authServerUrlFor(env, request);
  const resourceUrl = mcpResourceUrlFor(env, request);

  const payload = await verifyJwsAccessToken(token, {
    jwksFetch: () => localJwks(env),
    verifyOptions: {
      issuer: authServerUrl,
      audience: resourceUrl,
    },
  });

  assertRequiredScopes(typeof payload.scope === "string" ? payload.scope.split(" ") : []);
  return payload;
}

export async function verifyOpaqueMcpAccessToken(env: HostedEnv, token: string): Promise<JWTPayload> {
  const accessToken = await env.DB.prepare(`
    SELECT clientId, userId, sessionId, scopes, expiresAt
    FROM oauthAccessToken
    WHERE token = ?
  `).bind(token).first<OpaqueAccessTokenRow>();

  if (!accessToken) throw new McpAuthError("invalid access token", 401);
  if (isExpired(accessToken.expiresAt)) throw new McpAuthError("access token expired", 401);
  if (!accessToken.userId) throw new McpAuthError("OAuth access token is missing a subject.", 401);

  const scopes = parseOAuthScopes(accessToken.scopes);
  assertRequiredScopes(scopes);

  if (accessToken.sessionId) {
    const session = await env.DB.prepare("SELECT userId, expiresAt FROM session WHERE id = ?").bind(accessToken.sessionId).first<SessionRow>();
    if (!session || session.userId !== accessToken.userId) throw new McpAuthError("OAuth access token session is invalid.", 401);
    if (isExpired(session.expiresAt)) throw new McpAuthError("OAuth access token session expired.", 401);
  }

  return {
    sub: accessToken.userId,
    azp: accessToken.clientId,
    client_id: accessToken.clientId,
    scope: scopes.join(" "),
  };
}

export async function verifyMcpAccessToken(env: HostedEnv, request: Request): Promise<JWTPayload> {
  const token = accessTokenFrom(request);
  if (!token) throw unauthorized(env, request, "missing authorization header");

  try {
    return await verifyJwtAccessToken(env, request, token);
  } catch {
    return verifyOpaqueMcpAccessToken(env, token);
  }
}
