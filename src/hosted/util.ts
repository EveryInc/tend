export { digest, isoNow, makeId, makeToken, slugify } from "../../server/util";

export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  return request.json().catch(() => ({})) as Promise<Record<string, unknown>>;
}

export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

export function errorResponse(error: unknown, status = 400): Response {
  return json({ error: error instanceof Error ? error.message : String(error) }, status);
}

export function notFound(): Response {
  return json({ error: "Not found" }, 404);
}
