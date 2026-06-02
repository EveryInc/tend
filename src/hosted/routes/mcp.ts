import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { HostedEnv } from "../env";
import { sessionFromMcpToken } from "../identity";
import { McpAuthError, verifyMcpAccessToken } from "../mcp-auth";
import { mcpResponse } from "../mcp";

export const mcpRoutes = new Hono<{ Bindings: HostedEnv }>();

function responseForAuthError(error: unknown): Response {
  if (error instanceof McpAuthError) return error.response();
  if (error instanceof HTTPException) return error.getResponse();
  if (typeof error === "object" && error && "statusCode" in error) {
    const apiError = error as ResponseInit & { message?: string; statusCode?: number };
    return new Response(apiError.message ?? "Unauthorized", {
      ...apiError,
      status: apiError.statusCode,
    });
  }
  return new Response(error instanceof Error ? error.message : "Unauthorized", { status: 401 });
}

mcpRoutes.all("/mcp", async (c) => {
  try {
    const jwt = await verifyMcpAccessToken(c.env, c.req.raw);
    const session = await sessionFromMcpToken(c.env, jwt);
    return mcpResponse(c.req.raw, c.env, c.executionCtx as unknown as ExecutionContext, session);
  } catch (error) {
    return responseForAuthError(error);
  }
});
