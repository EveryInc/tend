import { describe, expect, test } from "bun:test";
import type { HostedEnv } from "../src/hosted/env";
import { parseOAuthScopes, verifyOpaqueMcpAccessToken } from "../src/hosted/mcp-auth";

type TokenRow = {
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

function envForRows(tokenRow: TokenRow | null, sessionRow: SessionRow | null = null): HostedEnv {
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind() {
            return {
              first: async () => sql.includes("oauthAccessToken") ? tokenRow : sessionRow,
            };
          },
        };
      },
    },
  } as unknown as HostedEnv;
}

describe("hosted MCP auth", () => {
  test("parses Better Auth scope strings", () => {
    expect(parseOAuthScopes("attention:read attention:write offline_access")).toEqual([
      "attention:read",
      "attention:write",
      "offline_access",
    ]);
  });

  test("parses JSON scope arrays for compatibility", () => {
    expect(parseOAuthScopes(JSON.stringify(["attention:read", "attention:write"]))).toEqual(["attention:read", "attention:write"]);
  });

  test("accepts a valid opaque Better Auth access token", async () => {
    const payload = await verifyOpaqueMcpAccessToken(envForRows({
      clientId: "client-1",
      userId: "user-1",
      sessionId: "session-1",
      scopes: "attention:read attention:write offline_access",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, {
      userId: "user-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }), "opaque-token");

    expect(payload.sub).toBe("user-1");
    expect(payload.client_id).toBe("client-1");
    expect(payload.scope).toBe("attention:read attention:write offline_access");
  });

  test("rejects opaque tokens missing required MCP scopes", async () => {
    await expect(verifyOpaqueMcpAccessToken(envForRows({
      clientId: "client-1",
      userId: "user-1",
      sessionId: null,
      scopes: "attention:read",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }), "opaque-token")).rejects.toThrow("missing required scope: attention:write");
  });
});
