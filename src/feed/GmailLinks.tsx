import type { Card } from "../../shared/types";
import { DetachedLink } from "../ui/DetachedLink";

export function gmailHref(href: string, mailbox?: string): string | null {
  if (!mailbox?.trim()) return null;
  try {
    const url = new URL(href);
    if (url.origin !== "https://mail.google.com" || !url.pathname.startsWith("/mail/")) return null;
    url.pathname = "/mail/u/";
    url.searchParams.set("authuser", mailbox.trim());
    return url.href;
  } catch {
    return null;
  }
}

export function gmailLinks(card: Card): string[] {
  const mailbox = card.sourceMailbox?.trim();
  if (!mailbox) return [];
  const links = new Set<string>();
  const gmailReceipt = card.blocks.some(block => block.type === "receipt" && /\bGmail\b/i.test(block.text ?? ""));
  const addIds = (text: string) => {
    for (const match of text.matchAll(/\b[0-9a-f]{12,20}\b/gi)) {
      links.add(`https://mail.google.com/mail/u/?authuser=${encodeURIComponent(mailbox)}#all/${match[0].toLowerCase()}`);
    }
  };
  for (const block of card.blocks) {
    if (block.type === "receipt" && gmailReceipt) {
      for (const match of (block.text ?? "").matchAll(/\b(?:Gmail\s+)?thread\s+IDs?\s*:\s*([^.;\n]+)/gi)) addIds(match[1]);
    }
    if (block.type !== "evidence") continue;
    for (const item of block.items ?? []) {
      if (typeof item === "string") continue;
      if (/^Gmail\s+thread(?:\s+IDs?)?$/i.test(item.label.trim())
        || (gmailReceipt && /^thread(?:\s+IDs?)?$/i.test(item.label.trim()))) addIds(item.detail ?? "");
      const href = item.href && gmailHref(item.href, mailbox);
      if (!href) continue;
      const hash = new URL(href).hash;
      const thread = hash.match(/^#(?:inbox|all|sent|trash|spam)\/([0-9a-f]{12,20})$/i);
      if (thread) addIds(thread[1]);
      else if (hash.includes("/") || hash.startsWith("#thread-f:")) links.add(href);
    }
  }
  return [...links];
}

export function GmailLinks({ card }: { card: Card }) {
  const links = gmailLinks(card);
  if (!links.length) return null;
  return <div className="gmail-links">{links.map((href, index) => (
    <DetachedLink key={href} href={href}>
      {links.length === 1 ? "Open in Gmail" : `Open email ${index + 1} in Gmail`}
    </DetachedLink>
  ))}</div>;
}
