import { Hono } from "hono";
import type { AttentionDomain } from "../domain";
import type { AttentionStore } from "../store";
import { McpFault, workEventDefinition, type TendMcpEvents } from "../mcpEvents";
import { tokensMatch, type Notify } from "./shared";
import { mcpWorkTools, TendMcpWork } from "../mcpWork";

export function mcpRoutes(context: { domain: AttentionDomain; store: AttentionStore; events: TendMcpEvents; token: () => string; notify: Notify }) {
  const app = new Hono();
  const work = new TendMcpWork(context);
  // This owner-bearer adapter does not advertise OAuth. Keep metadata probes
  // and unsupported streaming GETs out of the UI's HTML fallback.
  app.get("/.well-known/*", c => c.json({ error: "Metadata not available." }, 404));
  app.get("/mcp", c => {
    c.header("allow", "POST");
    return c.json({ error: "Use JSON-RPC POST." }, 405);
  });
  app.post("/mcp", async c => {
    c.header("cache-control", "no-store");
    if (!context.token() || c.req.header("origin") || !tokensMatch(c.req.header("authorization") ?? "", `Bearer ${context.token()}`)) return c.json({ error: "MCP authentication required." }, 401);
    if (!c.req.header("content-type")?.startsWith("application/json")) return c.json({ error: "JSON required." }, 415);
    if (Number(c.req.header("content-length") ?? 0) > 65_536) return c.json({ error: "Request too large." }, 413);
    let request: any;
    try { const raw = await c.req.text(); if (Buffer.byteLength(raw) > 65_536) return c.json({ error: "Request too large." }, 413); request = JSON.parse(raw); }
    catch { return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON." } }); }
    const id = typeof request?.id === "string" || typeof request?.id === "number" ? request.id : null;
    try {
      if (!request || Array.isArray(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string") throw new McpFault(-32600, "Invalid request.");
      if (request.method === "notifications/initialized") return c.body(null, 202);
      if (id === null) throw new McpFault(-32600, "Request ID required.");
      const params = request.params ?? {};
      let result: unknown;
      switch (request.method) {
        case "server/discover": result = { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {}, events: {} } }; break;
        case "initialize": result = { protocolVersion: "2026-07-28", capabilities: { tools: {}, events: {} }, serverInfo: { name: "tend", version: "0.2.0" } }; break;
        case "ping": result = {}; break;
        case "events/list": result = { events: [workEventDefinition] }; break;
        case "events/subscribe": result = await context.events.subscribe(params); break;
        case "events/unsubscribe": result = await context.events.unsubscribe(params); break;
        case "tools/list": result = { tools: mcpWorkTools }; break;
        case "tools/call": {
          const output = await work.call(params);
          result = { content: [{ type: "text", text: JSON.stringify(output) }] }; break;
        }
        default: throw new McpFault(-32601, "Unknown method.");
      }
      return c.json({ jsonrpc: "2.0", id, result });
    } catch (error) {
      const fault = error instanceof McpFault ? error : new McpFault(-32000, "Tend operation could not complete. Check the local work state.");
      return c.json({ jsonrpc: "2.0", id, error: { code: fault.code, message: fault.message, ...(fault.data ? { data: fault.data } : {}) } });
    }
  });
  return app;
}
