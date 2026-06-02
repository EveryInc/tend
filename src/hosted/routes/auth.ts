import { Hono } from "hono";
import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider";
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { MCP_SCOPES, authServerUrlFor, mcpResourceUrlFor } from "../auth";
import type { HostedEnv } from "../env";
import { createAuth } from "../auth";

export const authRoutes = new Hono<{ Bindings: HostedEnv }>();

async function authResponse(c: { env: HostedEnv; req: { raw: Request; method: string } }) {
  const response = await createAuth(c.env, c.req.raw).handler(await normalizeAuthRequest(c.env, c.req.raw));
  if (c.req.method !== "GET" || !response.headers.get("content-type")?.includes("application/json")) return response;

  const body = await response.clone().json().catch(() => null) as { redirect?: boolean; url?: string } | null;
  if (!body?.redirect || !body.url) return response;

  return Response.redirect(new URL(body.url, c.req.raw.url).href, 302);
}

export async function normalizeAuthRequest(env: HostedEnv, request: Request): Promise<Request> {
  const url = new URL(request.url);
  if (request.method !== "POST" || !url.pathname.endsWith("/oauth2/token")) return request;
  if (!request.headers.get("content-type")?.includes("application/x-www-form-urlencoded")) return request;

  const params = new URLSearchParams(await request.clone().text());
  const grantType = params.get("grant_type");
  if (!["authorization_code", "refresh_token"].includes(grantType ?? "") || params.has("resource")) return request;

  params.set("resource", mcpResourceUrlFor(env, request));

  const headers = new Headers(request.headers);
  headers.set("content-type", "application/x-www-form-urlencoded");

  return new Request(request.url, {
    method: request.method,
    headers,
    body: params.toString(),
    redirect: request.redirect,
  });
}

authRoutes.get("/api/auth/jwks/", (c) => {
  const url = new URL(c.req.raw.url);
  url.pathname = url.pathname.replace(/\/+$/, "");
  return createAuth(c.env, c.req.raw).handler(new Request(url, c.req.raw));
});
authRoutes.all("/api/auth/*", authResponse);
authRoutes.get("/.well-known/oauth-authorization-server", (c) =>
  oauthProviderAuthServerMetadata(createAuth(c.env, c.req.raw))(c.req.raw),
);
authRoutes.get("/.well-known/oauth-authorization-server/api/auth", (c) =>
  oauthProviderAuthServerMetadata(createAuth(c.env, c.req.raw))(c.req.raw),
);
authRoutes.get("/.well-known/oauth-authorization-server/mcp", (c) =>
  oauthProviderAuthServerMetadata(createAuth(c.env, c.req.raw))(c.req.raw),
);
authRoutes.get("/.well-known/openid-configuration", (c) =>
  oauthProviderOpenIdConfigMetadata(createAuth(c.env, c.req.raw))(c.req.raw),
);
authRoutes.get("/.well-known/openid-configuration/api/auth", (c) =>
  oauthProviderOpenIdConfigMetadata(createAuth(c.env, c.req.raw))(c.req.raw),
);
authRoutes.get("/.well-known/openid-configuration/mcp", (c) =>
  oauthProviderOpenIdConfigMetadata(createAuth(c.env, c.req.raw))(c.req.raw),
);
authRoutes.get("/mcp/.well-known/openid-configuration", (c) =>
  oauthProviderOpenIdConfigMetadata(createAuth(c.env, c.req.raw))(c.req.raw),
);
authRoutes.get("/mcp/.well-known/oauth-authorization-server", (c) =>
  oauthProviderAuthServerMetadata(createAuth(c.env, c.req.raw))(c.req.raw),
);

async function protectedResourceMetadata(c: { env: HostedEnv; req: { raw: Request } }) {
  const auth = createAuth(c.env, c.req.raw);
  const { getProtectedResourceMetadata } = oauthProviderResourceClient(auth).getActions();
  return Response.json(await getProtectedResourceMetadata({
    resource: mcpResourceUrlFor(c.env, c.req.raw),
    authorization_servers: [authServerUrlFor(c.env, c.req.raw)],
    scopes_supported: [...MCP_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Attention MCP",
  }));
}

authRoutes.get("/.well-known/oauth-protected-resource", protectedResourceMetadata);
authRoutes.get("/.well-known/oauth-protected-resource/mcp", protectedResourceMetadata);
