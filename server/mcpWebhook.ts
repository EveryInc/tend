import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { createHmac } from "node:crypto";
import type { LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";

export function signingKey(secret: string): Buffer {
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new Error("Invalid webhook signing secret.");
  const key = Buffer.from(secret.slice(6), "base64");
  if (key.length < 24 || key.length > 64 || key.toString("base64") !== secret.slice(6)) throw new Error("Invalid webhook signing secret.");
  return key;
}
export function publicIPv4(address: string): boolean {
  if (isIP(address) !== 4) return false; // Fail closed for IPv6 until its full reserved-address policy is supported.
  const [a,b,c] = address.split(".").map(Number);
  return a !== 0 && a !== 10 && a !== 127 && a < 224 && a !== 255
    && !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254)
    && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
    && !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    && !(a === 203 && b === 0 && c === 113);
}
export function callbackUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")) throw new Error("HTTPS callback required.");
  if (isIP(url.hostname) && !publicIPv4(url.hostname)) throw new Error("Non-public callback address.");
  return url;
}
export type WebhookResult = { status: number; body: string };
export type WebhookSender = (url: string, headers: Record<string,string>, body: string) => Promise<WebhookResult>;

/** Bun and modern Node request all addresses when selecting a socket family. */
export function pinnedLookup(addresses: LookupAddress[]): LookupFunction {
  if (!addresses.length || addresses.some(item => item.family !== 4 || !publicIPv4(item.address))) throw new Error("Non-public callback address.");
  return (_host, options, callback) => {
    if (options.all) {
      // net.LookupFunction's legacy callback type omits dns.lookup's all-address overload.
      const all = callback as unknown as (error: Error | null, addresses: LookupAddress[]) => void;
      all(null, addresses);
    } else callback(null, addresses[0].address, 4);
  };
}

/** Resolve again on each delivery; pin the actual socket while preserving hostname/TLS. */
export const sendWebhook: WebhookSender = async (value, headers, body) => {
  const url = callbackUrl(value);
  const addresses = await Promise.race([
    lookup(url.hostname, { all: true, family: 4 }),
    new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("Callback DNS timeout.")), 3_000); timer.unref(); }),
  ]);
  if (!addresses.length || addresses.some(item => !publicIPv4(item.address))) throw new Error("Non-public callback address.");
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "POST", headers, agent: false, rejectUnauthorized: true,
      servername: isIP(url.hostname) ? undefined : url.hostname,
      lookup: pinnedLookup(addresses),
    }, response => {
      let size = 0; const chunks: Buffer[] = [];
      response.on("data", chunk => { size += chunk.length; if (size > 16_384) req.destroy(new Error("Callback response too large.")); else chunks.push(chunk); });
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    const timeout = setTimeout(() => req.destroy(new Error("Callback timeout.")), 10_000);
    req.on("close", () => clearTimeout(timeout)); req.on("error", reject); req.end(body);
  });
};
export function webhookHeaders(id: string, subscription: string, body: string, secrets: string[], now = Date.now()) {
  const timestamp = String(Math.floor(now / 1000));
  return { "Content-Type": "application/json", "webhook-id": id, "webhook-timestamp": timestamp,
    "X-MCP-Subscription-Id": subscription,
    "webhook-signature": secrets.map(secret => `v1,${createHmac("sha256", signingKey(secret)).update(`${id}.${timestamp}.${body}`).digest("base64")}`).join(" "),
  };
}
