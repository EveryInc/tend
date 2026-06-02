import { decodeProtectedHeader, importJWK, jwtVerify, type JWTPayload } from "jose";
import { authServerUrlFor, MCP_SCOPES, mcpResourceUrlFor } from "./auth";
import type { HostedEnv } from "./env";

interface JwksRow {
  id: string;
  publicKey: string;
}

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

function unauthorized(env: HostedEnv, request: Request, message = "Unauthorized"): McpAuthError {
  const resource = mcpResourceUrlFor(env, request);
  const url = new URL(resource);
  const path = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  return new McpAuthError(message, 401, {
    "WWW-Authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource${path}"`,
  });
}

function scopesFrom(payload: JWTPayload): string[] {
  const scope = payload.scope;
  if (typeof scope === "string") return scope.split(/\s+/).filter(Boolean);

  const scopes = (payload as { scopes?: unknown }).scopes;
  if (Array.isArray(scopes)) return scopes.filter((value): value is string => typeof value === "string");
  if (typeof scopes === "string") return scopes.split(/\s+/).filter(Boolean);

  return [];
}

export async function verifyMcpAccessToken(env: HostedEnv, request: Request): Promise<JWTPayload> {
  const token = accessTokenFrom(request);
  if (!token) throw unauthorized(env, request, "missing authorization header");

  let kid: string | undefined;
  try {
    kid = decodeProtectedHeader(token).kid;
  } catch {
    throw unauthorized(env, request, "invalid access token");
  }
  if (!kid) throw unauthorized(env, request, "invalid access token");

  const row = await env.DB.prepare("SELECT id, publicKey FROM jwks WHERE id = ?").bind(kid).first<JwksRow>();
  if (!row) throw unauthorized(env, request, "invalid access token");

  try {
    const jwk = JSON.parse(row.publicKey) as JsonWebKey & { alg?: string; kid?: string };
    jwk.alg ??= "EdDSA";
    jwk.kid ??= row.id;
    const key = await importJWK(jwk, jwk.alg);
    const { payload } = await jwtVerify(token, key, {
      issuer: authServerUrlFor(env, request),
      audience: mcpResourceUrlFor(env, request),
    });

    const grantedScopes = new Set(scopesFrom(payload));
    if (!MCP_SCOPES.every((scope) => grantedScopes.has(scope))) {
      throw new McpAuthError("insufficient scope", 403);
    }

    return payload;
  } catch (error) {
    if (error instanceof McpAuthError) throw error;
    throw unauthorized(env, request, "invalid access token");
  }
}
