import type { AttentionDomain } from "../domain";
import type { LocalSqliteStore } from "../sqlite";
import type { AttentionStore } from "../store";

export type Notify = (data: unknown) => void;

export type LocalRouteContext = {
  dataDir: string;
  domain: AttentionDomain;
  notify: Notify;
  port: number;
  root: string;
  sqlite: LocalSqliteStore;
  store: AttentionStore;
};

export async function body(c: any): Promise<Record<string, unknown>> {
  return c.req.json().catch(() => ({}));
}

export async function mutation(c: any, notify: Notify, callback: () => Promise<unknown>) {
  try {
    const result = await callback();
    notify({ changedAt: new Date().toISOString() });
    return c.json(result);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
}
