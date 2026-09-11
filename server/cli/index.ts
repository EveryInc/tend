import path from "node:path";
import { attentionHome } from "../paths";
import { backupExportCommand, backupImportCommand } from "./backup";
import { doctorCommand, statusCommand } from "./health";
import { helpCommand } from "./help";
import { runOperatorCli } from "./operator";
import { healthCommand, logsCommand, restartCommand, stopCommand } from "./service";
import { setupCodexCommand } from "./setup";
import { startCommand } from "./start";
import { versionCommand } from "./version";

export async function runTendCli(rawArgs: string[]): Promise<void> {
  const args = [...rawArgs];
  if (args[0] === "--") args.shift();
  const [command = "help", subcommand, ...rest] = args;

  switch (command) {
    case "--version":
    case "-v":
    case "version":
      versionCommand();
      break;
    case "start":
      await startCommand([subcommand, ...rest].filter((value): value is string => Boolean(value)));
      break;
    case "stop":
      await stopCommand();
      break;
    case "restart":
      await restartCommand();
      break;
    case "health":
      await healthCommand();
      break;
    case "logs":
      await logsCommand();
      break;
    case "status":
      await statusCommand();
      break;
    case "doctor":
      await doctorCommand();
      break;
    case "setup":
      if (subcommand !== "codex") throw new Error("Expected: tend setup codex [--feed <id> | --chronicle]");
      setupCodexCommand(rest);
      break;
    case "backup":
      if (subcommand === "export") await backupExportCommand(rest[0] ?? path.join(attentionHome(), "exports", `attention-${Date.now()}`));
      else if (subcommand === "import") await backupImportCommand(rest[0] ?? "");
      else throw new Error("Expected: tend backup export [path] or tend backup import <path>");
      break;
    case "--help":
    case "-h":
    case "help":
      helpCommand();
      break;
    case "cli":
      await runOperatorCli([subcommand, ...rest].filter((value): value is string => Boolean(value)));
      break;
    default:
      throw new Error(`Unknown Tend command "${command}". Run tend help.`);
  }
}
