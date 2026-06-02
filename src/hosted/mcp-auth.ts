import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import type { JWTPayload } from "jose";
import { authServerUrlFor, createAuth, MCP_SCOPES, mcpResourceUrlFor } from "./auth";
import type { HostedEnv } from "./env";

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

export async function verifyMcpAccessToken(env: HostedEnv, request: Request): Promise<JWTPayload> {
  const token = accessTokenFrom(request);
  if (!token) throw unauthorized(env, request, "missing authorization header");

  const authServerUrl = authServerUrlFor(env, request);
  const resourceUrl = mcpResourceUrlFor(env, request);
  const { verifyAccessToken } = oauthProviderResourceClient(createAuth(env, request)).getActions();

  return verifyAccessToken(token, {
    jwksUrl: `${authServerUrl}/jwks`,
    verifyOptions: {
      issuer: authServerUrl,
      audience: resourceUrl,
    },
    scopes: [...MCP_SCOPES],
  });
}
