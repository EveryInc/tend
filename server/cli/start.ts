import path from "node:path";
import { attentionDataDir } from "../paths";
import { apiUrl, initRuntime, mcpUrl, print } from "./shared";

export async function startCommand(): Promise<void> {
  await initRuntime();
  process.env.ATTENTION_CLIENT_DIR ??= path.join(process.cwd(), "dist");
  print(`attention starting
UI:  ${apiUrl()}
API: ${apiUrl()}
MCP: ${mcpUrl()}
Data: ${attentionDataDir()}
`);
  await import("../../server");
}
