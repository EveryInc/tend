import type { FeedConfig } from "../../types";
import type { HostedEnv, HostedSession } from "../env";
import { isoNow } from "../util";

const DEFAULT_FEEDS = [
  { id: "inbox", name: "Inbox" },
  { id: "company-attention", name: "Company Attention" },
];

function feedDoName(accountId: string, feedId: string): string {
  return `account:${accountId}:feed:${feedId}`;
}

export async function ensureControlPlane(env: HostedEnv, session: HostedSession): Promise<void> {
  for (const feed of DEFAULT_FEEDS) {
    await registerFeed(env, session.accountId, feed);
  }
}

export async function registerFeed(env: HostedEnv, accountId: string, feed: Pick<FeedConfig, "id" | "name">): Promise<void> {
  const now = isoNow();
  await env.DB.prepare(`
    INSERT INTO feeds (id, owner_user_id, do_name, name, archived_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, ?, ?)
    ON CONFLICT(owner_user_id, id) DO UPDATE SET
      do_name = excluded.do_name,
      name = excluded.name,
      archived_at = NULL,
      updated_at = excluded.updated_at
  `).bind(feed.id, accountId, feedDoName(accountId, feed.id), feed.name, now, now).run();
}

export async function archiveFeed(env: HostedEnv, accountId: string, feedId: string): Promise<void> {
  const now = isoNow();
  await env.DB.prepare(`
    UPDATE feeds
    SET archived_at = ?, updated_at = ?
    WHERE owner_user_id = ? AND id = ?
  `).bind(now, now, accountId, feedId).run();
}
