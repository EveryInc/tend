import { Hono } from "hono";
import type { HostedEnv } from "../env";
import { callAccount, callFeed, requireSession } from "../identity";

export const apiRoutes = new Hono<{ Bindings: HostedEnv }>();

async function body(c: { req: { json: () => Promise<unknown> } }): Promise<string> {
  return JSON.stringify(await c.req.json().catch(() => ({})));
}

apiRoutes.get("/state", async (c) => {
  const session = await requireSession(c);
  return c.json(await callAccount(c.env, session, `/workspace?feed=${encodeURIComponent(c.req.query("feed") ?? "inbox")}`));
});

apiRoutes.get("/global-prompts", async (c) => {
  const session = await requireSession(c);
  return c.json(await callAccount(c.env, session, "/global-prompts"));
});

apiRoutes.post("/global-policy", async (c) => {
  const session = await requireSession(c);
  return c.json(await callAccount(c.env, session, "/global-policy", { method: "POST", body: await body(c) }));
});

apiRoutes.post("/global-prompts/:prompt", async (c) => {
  const session = await requireSession(c);
  return c.json(await callAccount(c.env, session, `/global-prompts/${encodeURIComponent(c.req.param("prompt"))}`, { method: "POST", body: await body(c) }));
});

apiRoutes.post("/feeds", async (c) => {
  const session = await requireSession(c);
  return c.json(await callAccount(c.env, session, "/feeds", { method: "POST", body: await body(c) }));
});

apiRoutes.get("/feeds/:feed/how", async (c) => c.json(await callFeed(c.env, await requireSession(c), c.req.param("feed"), "/how")));
apiRoutes.post("/feeds/:feed/bind", async (c) => c.json(await callFeed(c.env, await requireSession(c), c.req.param("feed"), "/bind", { method: "POST", body: await body(c) })));
apiRoutes.post("/feeds/:feed/heartbeat", async (c) => c.json(await callFeed(c.env, await requireSession(c), c.req.param("feed"), "/heartbeat", { method: "POST", body: await body(c) })));
apiRoutes.post("/feeds/:feed/sources", async (c) => c.json(await callFeed(c.env, await requireSession(c), c.req.param("feed"), "/sources", { method: "POST", body: await body(c) })));
apiRoutes.post("/feeds/:feed/sources/:source", async (c) => c.json(await callFeed(c.env, await requireSession(c), c.req.param("feed"), `/sources/${encodeURIComponent(c.req.param("source"))}`, { method: "POST", body: await body(c) })));
apiRoutes.post("/feeds/:feed/policy", async (c) => c.json(await callFeed(c.env, await requireSession(c), c.req.param("feed"), "/policy", { method: "POST", body: await body(c) })));
apiRoutes.post("/voice/target-change", async (c) => {
  const session = await requireSession(c);
  const input = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  return c.json(await callFeed(c.env, session, String(input.feedId ?? "inbox"), "/voice/target-change", { method: "POST", body: JSON.stringify(input) }));
});
apiRoutes.post("/voice/instructions", async (c) => {
  const session = await requireSession(c);
  const input = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  return c.json(await callFeed(c.env, session, String(input.feedId ?? "inbox"), "/voice/instructions", { method: "POST", body: JSON.stringify(input) }));
});
apiRoutes.post("/revision-proposals/:proposal/apply", async (c) => c.json(await callAccount(c.env, await requireSession(c), `/revision-proposals/${encodeURIComponent(c.req.param("proposal"))}/apply`, { method: "POST" })));
apiRoutes.post("/revision-proposals/:proposal/reject", async (c) => c.json(await callAccount(c.env, await requireSession(c), `/revision-proposals/${encodeURIComponent(c.req.param("proposal"))}/reject`, { method: "POST" })));
apiRoutes.post("/revision-proposals/:proposal", async (c) => c.json(await callAccount(c.env, await requireSession(c), `/revision-proposals/${encodeURIComponent(c.req.param("proposal"))}`, { method: "POST", body: await body(c) })));
apiRoutes.post("/revisions/:revision/revert", async (c) => c.json(await callAccount(c.env, await requireSession(c), `/revisions/${encodeURIComponent(c.req.param("revision"))}/revert`, { method: "POST" })));
apiRoutes.post("/feeds/:feed/recollect", async (c) => c.json(await callFeed(c.env, await requireSession(c), c.req.param("feed"), "/recollect", { method: "POST" })));
apiRoutes.post("/feeds/:feed/instructions", async (c) => c.json(await callFeed(c.env, await requireSession(c), c.req.param("feed"), "/instructions", { method: "POST", body: await body(c) })));
apiRoutes.post("/feeds/:feed/cards/:card/instructions", async (c) => c.json(await callFeed(c.env, await requireSession(c), c.req.param("feed"), `/cards/${encodeURIComponent(c.req.param("card"))}/instructions`, { method: "POST", body: await body(c) })));
apiRoutes.post("/feeds/:feed/cards/:card/actions/:action", async (c) => c.json(await callFeed(c.env, await requireSession(c), c.req.param("feed"), `/cards/${encodeURIComponent(c.req.param("card"))}/actions/${encodeURIComponent(c.req.param("action"))}`, { method: "POST" })));
apiRoutes.post("/feeds/:feed/cards/:card/approve", async (c) => c.json(await callFeed(c.env, await requireSession(c), c.req.param("feed"), `/cards/${encodeURIComponent(c.req.param("card"))}/approve`, { method: "POST" })));
apiRoutes.post("/feeds/:feed/cards/:card/dismiss", async (c) => c.json(await callFeed(c.env, await requireSession(c), c.req.param("feed"), `/cards/${encodeURIComponent(c.req.param("card"))}/dismiss`, { method: "POST" })));
apiRoutes.post("/feeds/:feed/cards/:card/undo-dismiss", async (c) => c.json(await callFeed(c.env, await requireSession(c), c.req.param("feed"), `/cards/${encodeURIComponent(c.req.param("card"))}/undo-dismiss`, { method: "POST" })));
apiRoutes.post("/feeds/:feed/cards/:card/blocks/:block", async (c) => c.json(await callFeed(c.env, await requireSession(c), c.req.param("feed"), `/cards/${encodeURIComponent(c.req.param("card"))}/blocks/${encodeURIComponent(c.req.param("block"))}`, { method: "POST", body: await body(c) })));
apiRoutes.post("/feeds/:feed/work/:work/cancel", async (c) => c.json(await callFeed(c.env, await requireSession(c), c.req.param("feed"), `/work/${encodeURIComponent(c.req.param("work"))}/cancel`, { method: "POST", body: await body(c) })));
apiRoutes.post("/feeds/:feed/work/:work/retry", async (c) => c.json(await callFeed(c.env, await requireSession(c), c.req.param("feed"), `/work/${encodeURIComponent(c.req.param("work"))}/retry`, { method: "POST" })));
apiRoutes.post("/feeds/:feed/routine-actions/:group/approve", async (c) => c.json(await callFeed(c.env, await requireSession(c), c.req.param("feed"), `/routine-actions/${encodeURIComponent(c.req.param("group"))}/approve`, { method: "POST" })));
apiRoutes.post("/feeds/:feed/next-pass", async (c) => c.json(await callFeed(c.env, await requireSession(c), c.req.param("feed"), "/next-pass", { method: "POST" })));
apiRoutes.post("/feeds/:feed/compound", async (c) => c.json(await callFeed(c.env, await requireSession(c), c.req.param("feed"), "/compound", { method: "POST" })));
