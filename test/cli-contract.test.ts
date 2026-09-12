import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runTendCli } from "../server/cli";
import { CLI_COMMANDS, INTERNAL_CLI_COMMANDS, cliCommandName } from "../server/cli/contract";
import { MissingFlagError, formatCliError } from "../server/cli/errors";
import { assertCliRuntimeMatchesLive } from "../server/cli/runtimeGuard";
import { setupChroniclePrompt, setupCodexPrompt } from "../server/cli/setup";
import { CLI_CONTRACT_VERSION } from "../server/version";
import { AttentionStore } from "../server/store";
import { AttentionDomain } from "../server/domain";

describe("CLI contract", () => {
  test("keeps public help focused on the v0 agent surface", () => {
    const commandNames = new Set(CLI_COMMANDS.map(cliCommandName));

    expect(commandNames).toContain("feed:bind");
    expect(commandNames).toContain("context:bind");
    expect(commandNames).toContain("context:publish");
    expect(commandNames).toContain("context:status");
    expect(commandNames).toContain("context:for-feed");
    expect(commandNames).toContain("agent:presence");
    expect(commandNames).toContain("work:list");
    expect(commandNames).toContain("work:claim");
    expect(commandNames).toContain("work:assign");
    expect(commandNames).toContain("feed:drain-agent");
    expect(commandNames).toContain("action:verify");
    expect(commandNames).toContain("work:complete");
    expect(commandNames).toContain("work:reconcile-approved");
    expect(commandNames).toContain("source:record-run");
    expect(commandNames).toContain("card:upsert");
    expect(commandNames).toContain("card:dismiss");
    expect(commandNames).toContain("card:cleanup-source");
    expect(commandNames).toContain("card:undo-cleanup-source");
    expect(commandNames).not.toContain("card:dismiss-local");
    expect(commandNames).not.toContain("card:undo-dismiss");
    expect(commandNames).toContain("learning:request");

    for (const command of INTERNAL_CLI_COMMANDS) {
      expect(commandNames).not.toContain(cliCommandName(command));
    }
  });

  test("exposes native readers and exact-version feedback without edition commands", () => {
    expect(CLI_CONTRACT_VERSION).toBe("0.8");
    expect(CLI_COMMANDS).toContain("readers:run --feed <id> --run <source-run-id> --packet-file <path> --readers-file <path> [--prompt-sha256 <hash>]");
    expect(CLI_COMMANDS).toContain("readers:status --feed <id> --run <source-run-id>");
    expect(CLI_COMMANDS).toContain("readers:output --feed <id> --run <source-run-id> --reader <id>");
    expect(CLI_COMMANDS).toContain("readers:compare --feed <id> --comparison-file <path>");
    expect(CLI_COMMANDS).toContain("card:react --feed <id> --card <id> --feedback-file <path>");
    expect(CLI_COMMANDS).toContain("card:prefer --feed <id> --preference-file <path>");
    expect(CLI_COMMANDS.some((command) => command.startsWith("edition:"))).toBe(false);
  });

  test("documents only implemented public commands", async () => {
    const contract = await readFile("docs/AGENT_CONTRACT.md", "utf8");
    const documented = [...contract.matchAll(/`tend cli ([^`\s]+)/g)].map((match) => match[1]);
    const commandNames = new Set(CLI_COMMANDS.map(cliCommandName));

    expect(documented.length).toBeGreaterThan(10);
    for (const command of documented) expect(commandNames).toContain(command);
  });

  test("source:record-run supports file-backed full-sweep manifests", async () => {
    const command = CLI_COMMANDS.find((candidate) => cliCommandName(candidate) === "source:record-run");
    expect(command).toContain("--snapshots-file <path>");
    expect(command).toContain("--judgments-file <path>");
    expect(command).toContain("--checkpoint-file <path>");

    const operator = await readFile("server/cli/operator.ts", "utf8");
    expect(operator).toContain('await structured("snapshots")');
    expect(operator).toContain('await structured("judgments")');
    expect(operator).toContain('await structured("checkpoint")');
  });

  test("supports file-backed completion receipts", async () => {
    expect(CLI_COMMANDS.find((command) => cliCommandName(command) === "work:complete")).toContain("--result-file <path>");
    expect(CLI_COMMANDS.find((command) => cliCommandName(command) === "work:reconcile-approved")).toContain("--result-file <path>");

    const operator = await readFile("server/cli/operator.ts", "utf8");
    expect(operator).toContain('case "work:complete"');
    expect(operator).toContain('case "work:reconcile-approved"');
    expect(operator.match(/await structured\("result"\)/g)).toHaveLength(2);
  });

  test("completes work from a file-backed result end to end", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "tend-cli-result-file-"));
    const run = async (args: string[]) => {
      const subprocess = Bun.spawn({
        cmd: [process.execPath, "tend.ts", "cli", ...args],
        cwd: process.cwd(),
        env: { ...process.env, ATTENTION_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(subprocess.stdout).text(), new Response(subprocess.stderr).text(), subprocess.exited,
      ]);
      if (exitCode !== 0) throw new Error(stderr || `CLI exited ${exitCode}`);
      return JSON.parse(stdout);
    };
    try {
      const store = new AttentionStore(path.join(home, "data"));
      await store.init();
      const domain = new AttentionDomain(store);
      await domain.bindFeed("inbox", "thread-inbox");
      const queued = await domain.queueFeedInstruction("inbox", "Summarize this synthetic fixture.");
      const claimed = await run(["work:claim", "--feed", "inbox", "--thread", "thread-inbox"]);
      expect(claimed.id).toBe(queued.id);
      const resultFile = path.join(home, "completion.json");
      await writeFile(resultFile, JSON.stringify({ response: "Synthetic fixture summarized.", done: true }));

      const completed = await run([
        "work:complete", "--feed", "inbox", "--work", queued.id,
        "--token", claimed.capabilityToken, "--result-file", resultFile,
      ]);
      expect(completed).toMatchObject({ id: queued.id, status: "completed", response: "Synthetic fixture summarized." });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("formats command-owned usage hints for missing flags", () => {
    const error = formatCliError(new MissingFlagError("work:claim", "thread"));

    expect(error).toEqual({
      ok: false,
      error: "Missing --thread",
      code: "missing_flag",
      hint: "Usage: tend cli work:claim --feed <id> --thread <id> [--cross-feed] [--session <id>]",
    });
    expect(CLI_COMMANDS.find((command) => command.startsWith("feed:bind "))).toContain("--agent claude [--replace]");
  });

  test("prints a self-contained Codex setup prompt for binary installs", () => {
    const prompt = setupCodexPrompt({
      binaryPath: "/tmp/tend install/tend",
      skillPath: "/tmp/tend install/docs/SKILL.md",
      attentionHome: "/tmp/tend home",
      feedId: "model-watch",
    });

    expect(prompt).toContain("Tend is Codex-native.");
    expect(prompt).toContain('This prompt connects the current thread to "model-watch"');
    expect(prompt).toContain("Local Tend entry point: /tmp/tend install/tend");
    expect(prompt).toContain("Skill/reference: /tmp/tend install/docs/SKILL.md");
    expect(prompt).toContain("CLI prefix: ATTENTION_HOME='/tmp/tend home' '/tmp/tend install/tend'");
    expect(prompt).toContain("Use the local Tend CLI contract, not a hosted Tend or MCP setup.");
    expect(prompt).toContain("Do setup sequentially: bind first and wait for it to finish, then propose/install the heartbeat.");
    expect(prompt).toContain("ATTENTION_HOME='/tmp/tend home' '/tmp/tend install/tend' cli feed:bind --feed model-watch --thread <current-codex-thread-id>");
    expect(prompt).toContain('says "go deal with the feed"');
  });

  test("prints a self-contained Chronicle Pulse setup prompt", () => {
    const prompt = setupChroniclePrompt({
      binaryPath: "/tmp/tend install/tend",
      skillPath: "/tmp/tend install/docs/SKILL.md",
      attentionHome: "/tmp/tend home",
    });

    expect(prompt).toContain("one dedicated Chronicle Pulse thread for the entire Tend workspace");
    expect(prompt).toContain("Tend does not capture the screen itself.");
    expect(prompt).toContain("Agent contract: /tmp/tend install/docs/AGENT_CONTRACT.md");
    expect(prompt).toContain("Security reference: /tmp/tend install/docs/SECURITY.md");
    expect(prompt).toContain("ATTENTION_HOME='/tmp/tend home' '/tmp/tend install/tend' cli context:bind --thread <current-codex-thread-id>");
    expect(prompt).toContain("refreshes the pulse every two hours");
    expect(prompt).toContain("one coherent window of ten minutes or less");
    expect(prompt).toContain("cli context:publish --thread <current-codex-thread-id> --context-file <local-json-file>");
    expect(prompt).toContain('says "refresh the pulse"');
  });

  test("keeps agent commands under the explicit cli namespace", async () => {
    await expect(runTendCli(["work:list", "--feed", "inbox", "--thread", "thread"]))
      .rejects.toThrow('Unknown Tend command "work:list". Run tend help.');
  });

  test("refuses an implicit CLI runtime that differs from the running service", async () => {
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

  test("records file-backed source inputs and requires an explicit reader configuration before launch", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "tend-cli-readers-"));
    const run = async (args: string[]) => {
      const subprocess = Bun.spawn({
        cmd: [process.execPath, "tend.ts", "cli", ...args],
        cwd: process.cwd(),
        env: { ...process.env, ATTENTION_HOME: home },
        stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(subprocess.stdout).text(), new Response(subprocess.stderr).text(), subprocess.exited,
      ]);
      return { stdout, stderr, code };
    };
    try {
      const snapshots = [{ transcript: "Complete synthetic source text.", synthetic: true }];
      const files = Object.fromEntries(["snapshots", "judgments", "checkpoint"].map((key) => [key, path.join(home, `${key}.json`)]));
      await writeFile(files.snapshots, JSON.stringify(snapshots));
      await writeFile(files.judgments, "[]");
      await writeFile(files.checkpoint, JSON.stringify({ synthetic: true }));
      const recorded = await run([
        "source:record-run", "--feed", "company-attention", "--source", "company-attention",
        "--snapshots-file", files.snapshots, "--judgments-file", files.judgments, "--checkpoint-file", files.checkpoint,
      ]);
      expect(recorded.code).toBe(0);
      const runId = JSON.parse(recorded.stdout) as string;
      const store = new AttentionStore(path.join(home, "data"));
      expect(await store.readRun("company-attention", runId)).toMatchObject({ snapshots: 1, judgments: [] });
      const saved = JSON.parse(await readFile(store.feedPath("company-attention", "raw", runId, "company-attention", "snapshot-1.json"), "utf8"));
      expect(saved).toEqual(snapshots[0]);
      const missing = await run(["readers:run", "--feed", "company-attention", "--run", runId, "--packet-file", "unused.txt"]);
      expect(missing.code).not.toBe(0);
      expect(missing.stderr).toContain("Missing --readers-file");
      expect((await store.readRun("company-attention", runId)).readers).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("executes the renamed local-dismiss and source-cleanup commands end to end", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "tend-cli-disposition-"));
    const run = async (args: string[]) => {
      const subprocess = Bun.spawn({
        cmd: [process.execPath, "tend.ts", "cli", ...args],
        cwd: process.cwd(),
        env: { ...process.env, ATTENTION_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
        subprocess.exited,
      ]);
      if (exitCode !== 0) throw new Error(stderr || `CLI exited ${exitCode}`);
      return JSON.parse(stdout);
    };

    try {
      const card = {
        id: "cli-disposition",
        title: "Choose the disposition.",
        why: "The CLI must distinguish local dismissal from source cleanup.",
        blocks: [{ id: "memo", type: "memo", text: "Routine notice." }],
      };
      await run(["card:upsert", "--feed", "inbox", "--card", JSON.stringify(card)]);

      const dismissed = await run(["card:dismiss", "--feed", "inbox", "--card", card.id]);
      expect(dismissed).toMatchObject({ status: "done", completionDisposition: "dismissed" });

      await run(["card:return-to-review", "--feed", "inbox", "--card", card.id]);
      await run([
        "card:upsert",
        "--feed",
        "inbox",
        "--card",
        JSON.stringify({ ...card, actions: [{ id: "archive-source", label: "Archive", behavior: "default_cleanup" }] }),
      ]);
      const cleanup = await run(["card:cleanup-source", "--feed", "inbox", "--card", card.id]);
      expect(cleanup).toMatchObject({ kind: "default_cleanup", status: "queued" });
      expect(cleanup.approvalDigest).toBeTruthy();

      const restored = await run(["card:undo-cleanup-source", "--feed", "inbox", "--card", card.id]);
      expect(restored).toMatchObject({ status: "to_review_updated" });
      expect(restored.completionDisposition).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
