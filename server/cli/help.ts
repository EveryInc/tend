import { print } from "./shared";

export const CLI_HELP_COMMANDS = [
  "tend version",
  "tend start [--foreground]",
  "tend stop",
  "tend restart",
  "tend health",
  "tend logs",
  "tend status",
  "tend doctor",
  "tend autostart install",
  "tend autostart status",
  "tend autostart uninstall",
  "tend setup codex [--feed <id> | --chronicle]",
  "tend backup export [path]",
  "tend backup import <path>",
  "tend cli <existing-low-level-command> [...args]",
];

export function helpCommand(): void {
  print({
    commands: CLI_HELP_COMMANDS,
  });
}
