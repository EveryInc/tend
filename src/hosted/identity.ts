import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { createAuth } from "./auth";
import type { HostedEnv, HostedSession } from "./env";
import { ensureControlPlane } from "./services/control-plane-service";

interface OAuthTokenPayload {
  sub?: string;
}

export async function requireSession(c: Context<{ Bindings: HostedEnv }>): Promise<HostedSession> {
  const authSession = await createAuth(c.env, c.req.raw).api.getSession({ headers: c.req.raw.headers });
  if (!authSession) {
    throw new HTTPException(401, { message: "Sign in to use hosted Attention." });
  }
  const session = {
    userId: authSession.user.id,
    accountId: authSession.user.id,
    email: authSession.user.email,
  };
  await ensureControlPlane(c.env, session);
  return session;
}

export async function sessionFromMcpToken(env: HostedEnv, payload: OAuthTokenPayload): Promise<HostedSession> {
  if (!payload.sub) {
    throw new HTTPException(401, { message: "OAuth access token is missing a subject." });
  }

  const user = await env.DB.prepare("SELECT id, email FROM user WHERE id = ?").bind(payload.sub).first<{ id: string; email: string }>();
  if (!user) {
    throw new HTTPException(401, { message: "OAuth access token subject no longer maps to a user." });
  }

  const session = {
    userId: user.id,
    accountId: user.id,
    email: user.email,
  };
  await ensureControlPlane(env, session);
  return session;
}

export function accountObject(env: HostedEnv, accountId: string): DurableObjectStub {
  return env.ACCOUNT_DO.get(env.ACCOUNT_DO.idFromName(`account:${accountId}`));
}

export function feedObject(env: HostedEnv, accountId: string, feedId: string): DurableObjectStub {
  return env.FEED_DO.get(env.FEED_DO.idFromName(feedDoName(accountId, feedId)));
}

export function feedDoName(accountId: string, feedId: string): string {
  return `account:${accountId}:feed:${feedId}`;
}

export async function callJson<T>(stub: DurableObjectStub, path: string, init: RequestInit = {}): Promise<T> {
  const request = new Request(`https://attention.internal${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const response = await stub.fetch(request);
  const value = await response.json();
  if (!response.ok) throw new Error((value as { error?: string }).error ?? `Durable Object request failed: ${response.status}`);
  return value as T;
}

export function callAccount<T>(env: HostedEnv, session: HostedSession, path: string, init: RequestInit = {}): Promise<T> {
  return callJson(accountObject(env, session.accountId), path, {
    ...init,
    headers: { "x-attention-account-id": session.accountId, ...(init.headers ?? {}) },
  });
}

export function callFeed<T>(env: HostedEnv, session: HostedSession, feedId: string, path: string, init: RequestInit = {}): Promise<T> {
  return callJson(feedObject(env, session.accountId, feedId), path, {
    ...init,
    headers: { "x-attention-feed-id": feedId, ...(init.headers ?? {}) },
  });
}
