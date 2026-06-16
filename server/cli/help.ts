import { print } from "./shared";

export function helpCommand(): void {
  print({
    commands: [
      "tend version",
      "tend start [--foreground]",
      "tend stop",
      "tend restart",
      "tend health",
      "tend logs",
      "tend status",
      "tend doctor",
      "tend setup codex [--feed <id>]",
      "tend backup export [path]",
      "tend backup import <path>",
      "tend cli <existing-low-level-command> [...args]",
    ],
    compatibility: "The legacy attention command remains an alias for Tend.",
  });
}
