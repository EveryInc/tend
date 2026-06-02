import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { withCloudflare } from "better-auth-cloudflare";
import type { CloudflareGeolocation } from "better-auth-cloudflare";
import type { HostedEnv } from "./env";

export const MCP_SCOPES = ["attention:read", "attention:write"] as const;

export function baseUrlFor(env: HostedEnv, request?: Request): string {
  if (env.BETTER_AUTH_URL) return env.BETTER_AUTH_URL;
  if (request) return new URL(request.url).origin;
  return "http://127.0.0.1:8787";
}

export function authServerUrlFor(env: HostedEnv, request?: Request): string {
  return `${baseUrlFor(env, request)}/api/auth`;
}

export function mcpResourceUrlFor(env: HostedEnv, request?: Request): string {
  return `${baseUrlFor(env, request)}/mcp`;
}

function cloudflareGeolocation(request?: Request): CloudflareGeolocation | null {
  const cf = (request as (Request & { cf?: Record<string, unknown> }) | undefined)?.cf;
  if (!cf) return null;

  const stringField = (key: string) => (typeof cf[key] === "string" ? cf[key] : null);
  return {
    timezone: stringField("timezone"),
    city: stringField("city"),
    country: stringField("country"),
    region: stringField("region"),
    regionCode: stringField("regionCode"),
    colo: stringField("colo"),
    latitude: stringField("latitude"),
    longitude: stringField("longitude"),
  };
}

export function createAuth(env: HostedEnv, request?: Request) {
  const baseURL = baseUrlFor(env, request);

  return betterAuth({
    ...withCloudflare(
      {
        d1Native: env.DB,
        cf: cloudflareGeolocation(request),
        geolocationTracking: false,
      },
      {
        emailAndPassword: {
          enabled: true,
        },
        plugins: [
          jwt(),
          oauthProvider({
            loginPage: "/sign-in",
            consentPage: "/oauth/consent",
            scopes: ["openid", "profile", "email", "offline_access", ...MCP_SCOPES],
            validAudiences: [baseURL, `${baseURL}/mcp`],
            allowDynamicClientRegistration: true,
            allowUnauthenticatedClientRegistration: true,
            allowPublicClientPrelogin: true,
          }),
        ],
      },
    ),
    secret: env.BETTER_AUTH_SECRET || "local-development-secret-change-me",
    baseURL,
  });
}
