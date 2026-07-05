import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SQLITE_SCHEMA_VERSION } from "../server/sqlite";
import { APP_VERSION, CLI_CONTRACT_VERSION } from "../server/version";

const binaryPath = path.resolve(
  process.env.TEND_BINARY ?? path.join("dist-bin", "tend"),
);
const cwd = path.resolve(process.env.ATTENTION_SMOKE_CWD ?? process.cwd());
const port = process.env.ATTENTION_API_PORT ?? "4599";
const home = await mkdtemp(path.join(os.tmpdir(), "tend-smoke-"));
const statusUrl = `http://127.0.0.1:${port}/api/status`;

if (!existsSync(binaryPath)) {
  throw new Error(
    `Compiled binary not found: ${binaryPath}. Run pnpm tend:build first.`,
  );
}

const binaryVersion = await cliJson(["version"]);
if (binaryVersion.version !== APP_VERSION) {
  throw new Error(
    `Compiled binary reported version ${binaryVersion.version} instead of ${APP_VERSION}.`,
  );
}
if (binaryVersion.cliContractVersion !== CLI_CONTRACT_VERSION) {
  throw new Error(
    `Compiled binary reported CLI contract ${binaryVersion.cliContractVersion} instead of ${CLI_CONTRACT_VERSION}.`,
  );
}

const server = Bun.spawn([binaryPath, "start", "--foreground"], {
  cwd,
  env: runtimeEnv(),
  stderr: "inherit",
  stdout: "inherit",
});

try {
  const status = await waitForStatus();
  const schemaVersion = Number(status.sqlite?.schemaVersion ?? 0);
  if (status.ok !== true)
    throw new Error("/api/status did not report ok=true.");
  if (status.version?.version !== APP_VERSION)
    throw new Error(
      `/api/status reported version ${status.version?.version} instead of ${APP_VERSION}.`,
    );
  if (status.version?.cliContractVersion !== CLI_CONTRACT_VERSION) {
    throw new Error(
      `/api/status reported CLI contract ${status.version?.cliContractVersion} instead of ${CLI_CONTRACT_VERSION}.`,
    );
  }
  if (schemaVersion !== SQLITE_SCHEMA_VERSION) {
    throw new Error(
      `/api/status reported schema ${schemaVersion} instead of ${SQLITE_SCHEMA_VERSION}.`,
    );
  }
  const ui = await fetchUi();
  const cli = await validateCliContract();
  const runtime = await validateRuntimeLocation();
  console.log(
    JSON.stringify(
      {
        ok: true,
        statusUrl,
        version: status.version,
        schemaVersion,
        ui,
        cli,
        runtime,
        binaryVersion,
        binaryPath,
        cwd,
        home,
      },
      null,
      2,
    ),
  );
} finally {
  server.kill();
  await server.exited.catch(() => undefined);
  await rm(home, { recursive: true, force: true });
}

async function validateRuntimeLocation(): Promise<{
  appRoot: string;
  runtimeRoot: string;
}> {
  const runtime = (await cliJson(["cli", "runtime:where"])) as {
    appRoot?: string;
    runtimeRoot?: string;
  };
  const expectedAppRoot = path.dirname(binaryPath);
  if (path.resolve(runtime.appRoot ?? "") !== expectedAppRoot) {
    throw new Error(
      `CLI runtime reported app root ${runtime.appRoot} instead of ${expectedAppRoot}.`,
    );
  }
  if (path.resolve(runtime.runtimeRoot ?? "") !== home) {
    throw new Error(
      `CLI runtime reported home ${runtime.runtimeRoot} instead of ${home}.`,
    );
  }
  return { appRoot: expectedAppRoot, runtimeRoot: home };
}

async function validateCliContract(): Promise<{
  commands: string[];
  workspace: boolean;
  inspect: boolean;
  claimIdle: boolean;
  chronicleSetup: boolean;
}> {
  const help = (await cliJson(["cli", "help"])) as { commands?: string[] };
  const commands = help.commands ?? [];
  const requiredCommands = [
    "state [--feed inbox]",
    "context:bind --thread <Chronicle thread id> [--replace]",
    "context:publish --thread <Chronicle thread id> --context-file <path>",
    "context:status",
    "context:for-feed --feed <id>",
    "feed:bind --feed <id> (--thread <Codex thread id> | --agent claude [--replace])",
    "work:list --feed <id> --thread <id> [--cross-feed]",
    "work:claim --feed <id> --thread <id> [--cross-feed] [--session <id>]",
    "work:release --feed <id> --work <id> --token <token> [--session <id>]",
    "agent:presence --agent claude --session <id> [--label <text>]",
    "feed:drain-agent --feed <id> --agent <codex|claude>",
    "work:complete --feed <id> --work <id> --token <token> --result <json>",
    "card:upsert --feed <id> (--card <json> | --card-file <path>)",
    "source:record-run --feed <id> --source <id> --snapshots <json> --judgments <json> --checkpoint <json> [--work <recollection-work-id>] [--context-use <json> | --context-use-file <path>]",
    "sweep:record-batch --feed <id> --runs <json-array> [--work <recollection-work-id>] [--context <mind-update-id>]",
    "learning:request --feed <id>",
  ];
  const missingCommands = requiredCommands.filter(
    (command) => !commands.includes(command),
  );
  if (missingCommands.length > 0)
    throw new Error(
      `CLI help is missing required commands: ${missingCommands.join(", ")}`,
    );

  const workspace = (await cliJson(["cli", "state", "--feed", "inbox"])) as {
    active?: { config?: { name?: string } };
  };
  if (workspace.active?.config?.name !== "Inbox")
    throw new Error("CLI state did not return the Inbox workspace.");

  const inspect = (await cliJson(["cli", "inspect", "--feed", "inbox"])) as {
    feed?: { name?: string };
  };
  if (inspect.feed?.name !== "Inbox")
    throw new Error("CLI inspect did not return the Inbox feed.");

  await cliJson([
    "cli",
    "feed:bind",
    "--feed",
    "inbox",
    "--thread",
    "smoke-thread",
  ]);
  const claim = (await cliJson([
    "cli",
    "work:claim",
    "--feed",
    "inbox",
    "--thread",
    "smoke-thread",
  ])) as { status?: string };
  if (claim.status !== "idle")
    throw new Error(
      "CLI work:claim did not return the idle handshake for an empty smoke queue.",
    );

  const chronicleSetup = await cliText(["setup", "codex", "--chronicle"]);
  if (
    !chronicleSetup.includes(
      "one dedicated Chronicle Pulse thread for the entire Tend workspace",
    )
  ) {
    throw new Error(
      "Chronicle setup prompt did not describe the workspace-level publisher.",
    );
  }
  if (
    !chronicleSetup.includes(
      "cli context:bind --thread <current-codex-thread-id>",
    )
  ) {
    throw new Error(
      "Chronicle setup prompt did not include publisher binding.",
    );
  }

  return {
    commands,
    workspace: true,
    inspect: true,
    claimIdle: true,
    chronicleSetup: true,
  };
}

async function cliJson(args: string[]): Promise<any> {
  return JSON.parse(await cliText(args));
}

async function cliText(args: string[]): Promise<string> {
  const subprocess = Bun.spawn([binaryPath, ...args], {
    cwd,
    env: runtimeEnv(),
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(
      `tend ${args.join(" ")} failed with exit code ${exitCode}: ${stderr}`,
    );
  return stdout;
}

function runtimeEnv() {
  return { ...process.env, ATTENTION_HOME: home, ATTENTION_API_PORT: port };
}

async function waitForStatus(): Promise<{
  ok?: boolean;
  version?: { version?: string; cliContractVersion?: string };
  sqlite?: { schemaVersion?: number };
}> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(statusUrl);
      if (response.ok)
        return (await response.json()) as {
          ok?: boolean;
          version?: { version?: string; cliContractVersion?: string };
          sqlite?: { schemaVersion?: number };
        };
    } catch {
      await Bun.sleep(100);
    }
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${statusUrl}`);
}

async function fetchUi(): Promise<{ url: string; title: string }> {
  const url = `http://127.0.0.1:${port}/`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`UI returned HTTP ${response.status}.`);
  const html = await response.text();
  if (!html.includes("<title>Tend</title>"))
    throw new Error("UI did not serve the built Tend document.");
  return { url, title: "Tend" };
}
