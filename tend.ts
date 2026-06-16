#!/usr/bin/env bun
import { formatCliError } from "./server/cli/errors";
import { runTendCli } from "./server/cli";

const args = process.argv.slice(2);
try {
  await runTendCli(args);
} catch (error) {
  const output =
    args[0] === "cli"
      ? formatCliError(error)
      : {
          ok: false as const,
          error: error instanceof Error ? error.message : String(error),
          hint: "Run tend help for available commands.",
        };
  process.stderr.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exitCode = 1;
}
