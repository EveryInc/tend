import { Hono } from "hono";
import { mcpHandler as oauthMcpHandler } from "@better-auth/oauth-provider";
import { authServerUrlFor, MCP_SCOPES, mcpResourceUrlFor } from "../auth";
import type { HostedEnv } from "../env";
import { sessionFromMcpToken } from "../identity";
import { mcpResponse } from "../mcp";

export const mcpRoutes = new Hono<{ Bindings: HostedEnv }>();

mcpRoutes.all("/mcp", async (c) => {
  return oauthMcpHandler(
    {
      jwksUrl: `${authServerUrlFor(c.env, c.req.raw)}/jwks`,
      scopes: [...MCP_SCOPES],
      verifyOptions: {
        issuer: authServerUrlFor(c.env, c.req.raw),
        audience: mcpResourceUrlFor(c.env, c.req.raw),
      },
    },
    async (request, jwt) => {
      const session = await sessionFromMcpToken(c.env, jwt);
      return mcpResponse(request, c.env, c.executionCtx as unknown as ExecutionContext, session);
    },
  )(c.req.raw);
});
