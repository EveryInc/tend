import { existsSync } from "node:fs";
import path from "node:path";

export function currentCliCommand(): string[] {
  const scriptPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
  if (scriptPath.endsWith(".ts") && existsSync(scriptPath)) return [process.argv[0], scriptPath];
  return [process.execPath];
}

export function resolveClientDir(): string {
  for (const candidate of clientDirCandidates()) {
    if (existsSync(path.join(candidate, "index.html"))) return candidate;
  }
  return path.join(process.cwd(), "dist");
}

function clientDirCandidates(): string[] {
  const executablePaths = [
    process.argv[0],
    process.argv[1],
    process.execPath,
  ].filter((value): value is string => Boolean(value));
  const candidates = executablePaths.flatMap((value) => {
    const executableDir = path.dirname(path.resolve(value));
    return [path.join(executableDir, "dist"), path.join(executableDir, "..", "dist")];
  });
  candidates.unshift(process.env.ATTENTION_CLIENT_DIR ?? "");
  candidates.push(path.join(process.cwd(), "dist"));
  return [...new Set(candidates.filter(Boolean).map((candidate) => path.resolve(candidate)))];
}
