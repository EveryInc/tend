import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { CLI_COMMANDS, INTERNAL_CLI_COMMANDS, cliCommandName } from "../server/cli/contract";
import { MissingFlagError, formatCliError } from "../server/cli/errors";
import { assertCliRuntimeMatchesLive } from "../server/cli/runtimeGuard";
import { setupCodexPrompt } from "../server/cli/setup";

describe("CLI contract", () => {
  test("keeps public help focused on the v0 agent surface", () => {
    const commandNames = new Set(CLI_COMMANDS.map(cliCommandName));

    expect(commandNames).toContain("feed:bind");
    expect(commandNames).toContain("work:list");
    expect(commandNames).toContain("work:claim");
    expect(commandNames).toContain("action:verify");
    expect(commandNames).toContain("work:complete");
    expect(commandNames).toContain("work:reconcile-approved");
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

  test("prints a self-contained Codex setup prompt for binary installs", () => {
    const prompt = setupCodexPrompt({
      binaryPath: "/tmp/attention install/attention",
      skillPath: "/tmp/attention install/docs/SKILL.md",
      attentionHome: "/tmp/attention home",
    });

    expect(prompt).toContain("Local Attention binary: /tmp/attention install/attention");
    expect(prompt).toContain("Skill/reference: /tmp/attention install/docs/SKILL.md");
    expect(prompt).toContain("CLI prefix: ATTENTION_HOME='/tmp/attention home' '/tmp/attention install/attention'");
    expect(prompt).toContain("Use the local Attention CLI contract, not a hosted Attention or MCP setup.");
    expect(prompt).toContain("Do setup sequentially: bind first and wait for it to finish, then propose/install the heartbeat.");
    expect(prompt).toContain("ATTENTION_HOME='/tmp/attention home' '/tmp/attention install/attention' cli feed:bind --feed inbox --thread <current-codex-thread-id>");
  });

  test("refuses an implicit CLI runtime that differs from healthy tend-live", async () => {
    const mismatch = assertCliRuntimeMatchesLive("card:upsert", "/tmp/quiet-runtime", {
      fetchStatus: async () => ({ dataDir: "/tmp/live-runtime/data" }),
    });
    await expect(mismatch).rejects.toMatchObject({
      code: "runtime_mismatch",
      hint: "Run the CLI from the canonical checkout or set ATTENTION_HOME explicitly for isolated validation.",
    });

    await expect(assertCliRuntimeMatchesLive("card:upsert", "/tmp/quiet-runtime", {
      explicitRuntime: true,
      fetchStatus: async () => ({ dataDir: "/tmp/live-runtime/data" }),
    })).resolves.toBeUndefined();
  });
});
