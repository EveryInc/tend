import { existsSync } from "node:fs";
import path from "node:path";
import { attentionDataDir } from "../paths";
import { versionInfo } from "../version";
import { startBackgroundCommand } from "./service";
import { apiUrl, initRuntime, print } from "./shared";

export async function startCommand(args: string[] = []): Promise<void> {
  if (!args.includes("--foreground")) {
    await startBackgroundCommand();
    return;
  }
  await initRuntime();
  process.env.ATTENTION_CLIENT_DIR ??= defaultClientDir();
  const version = versionInfo();
  print(`attention starting
Version: ${version.version}
UI:  ${apiUrl()}
API: ${apiUrl()}
Data: ${attentionDataDir()}
`);
  await import("../../server");
}

function defaultClientDir(): string {
  for (const candidate of clientDirCandidates()) {
    if (existsSync(path.join(candidate, "index.html"))) return candidate;
  }
  return path.join(process.cwd(), "dist");
}

function clientDirCandidates(): string[] {
  const paths = [
    process.argv[0],
    process.argv[1],
    process.execPath,
  ].filter((value): value is string => Boolean(value));
  const candidates = paths.map((value) => path.join(path.dirname(path.resolve(value)), "dist"));
  candidates.push(path.join(process.cwd(), "dist"));
  return [...new Set(candidates)];
}
