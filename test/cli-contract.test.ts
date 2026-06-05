import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { CLI_COMMANDS, INTERNAL_CLI_COMMANDS, cliCommandName } from "../server/cli/contract";
import { MissingFlagError, formatCliError } from "../server/cli/errors";

describe("CLI contract", () => {
  test("keeps public help focused on the v0 agent surface", () => {
    const commandNames = new Set(CLI_COMMANDS.map(cliCommandName));

    expect(commandNames).toContain("feed:bind");
    expect(commandNames).toContain("work:list");
    expect(commandNames).toContain("work:claim");
    expect(commandNames).toContain("action:verify");
    expect(commandNames).toContain("work:complete");
    expect(commandNames).toContain("source:record-run");
    expect(commandNames).toContain("card:upsert");
    expect(commandNames).toContain("learning:request");

    for (const command of INTERNAL_CLI_COMMANDS) {
      expect(commandNames).not.toContain(cliCommandName(command));
    }
  });

  test("documents only implemented public commands", async () => {
    const contract = await readFile("docs/AGENT_CONTRACT.md", "utf8");
    const documented = [...contract.matchAll(/`attention cli ([^`\s]+)/g)].map((match) => match[1]);
    const commandNames = new Set(CLI_COMMANDS.map(cliCommandName));

    expect(documented.length).toBeGreaterThan(10);
    for (const command of documented) expect(commandNames).toContain(command);
  });

  test("formats command-owned usage hints for missing flags", () => {
    const error = formatCliError(new MissingFlagError("work:claim", "thread"));

    expect(error).toEqual({
      ok: false,
      error: "Missing --thread",
      code: "missing_flag",
      hint: "Usage: attention cli work:claim --feed <id> --thread <id> [--cross-feed]",
    });
  });
});
