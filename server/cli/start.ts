import { attentionDataDir } from "../paths";
import { versionInfo } from "../version";
import { resolveClientDir } from "./executable";
import { startBackgroundCommand } from "./service";
import { apiUrl, initRuntime, print } from "./shared";

export async function startCommand(args: string[] = []): Promise<void> {
  if (!args.includes("--foreground")) {
    await startBackgroundCommand();
    return;
  }
  await initRuntime();
  process.env.ATTENTION_CLIENT_DIR ??= resolveClientDir();
  const version = versionInfo();
  print(`Tend starting
Version: ${version.version}
UI:  ${apiUrl()}
API: ${apiUrl()}
Data: ${attentionDataDir()}
`);
  await import("../../server");
}
