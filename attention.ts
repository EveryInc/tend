#!/usr/bin/env bun
import { runAttentionCli } from "./server/cli";

try {
  await runAttentionCli(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ ok: false, error: message, hint: "Run tend help for available commands." }, null, 2)}\n`);
  process.exit(1);
}
