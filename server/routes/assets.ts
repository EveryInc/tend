import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import path from "node:path";

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

export function assetRoutes(clientDir: string): Hono {
  const app = new Hono();

  app.get("*", async (c) => {
    const url = new URL(c.req.url);
    const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (requested.includes("..")) return c.text("Not found", 404);

    const filePath = path.join(clientDir, requested);
    try {
      const contents = await readFile(filePath);
      return c.body(contents, 200, { "content-type": contentTypes[path.extname(filePath)] ?? "application/octet-stream" });
    } catch {
      try {
        const contents = await readFile(path.join(clientDir, "index.html"));
        return c.body(contents, 200, { "content-type": "text/html; charset=utf-8" });
      } catch {
        return c.text("UI assets not built. Run pnpm build or use pnpm start for the Vite dev server.", 404);
      }
    }
  });

  return app;
}
