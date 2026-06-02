import { describe, expect, test } from "bun:test";
import type { HostedEnv } from "../src/hosted/env";
import { normalizeAuthRequest } from "../src/hosted/routes/auth";

const env = {
  BETTER_AUTH_URL: "https://attention.example.com",
} as HostedEnv;

async function normalizedParams(body: URLSearchParams) {
  const request = new Request("https://attention.example.com/api/auth/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const normalized = await normalizeAuthRequest(env, request);
  return new URLSearchParams(await normalized.text());
}

describe("hosted OAuth token normalization", () => {
  test("adds the MCP resource to authorization-code token exchanges", async () => {
    const params = await normalizedParams(new URLSearchParams({
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: "http://127.0.0.1:61626/callback",
    }));

    expect(params.get("resource")).toBe("https://attention.example.com/mcp");
  });

  test("adds the MCP resource to refresh-token exchanges", async () => {
    const params = await normalizedParams(new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
    }));

    expect(params.get("resource")).toBe("https://attention.example.com/mcp");
  });

  test("preserves an explicit resource from the OAuth client", async () => {
    const params = await normalizedParams(new URLSearchParams({
      grant_type: "authorization_code",
      code: "code-1",
      resource: "https://custom.example.com/mcp",
    }));

    expect(params.get("resource")).toBe("https://custom.example.com/mcp");
  });
});
