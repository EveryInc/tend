import { print } from "./shared";

export function helpCommand(): void {
  print({
    commands: [
      "attention start",
      "attention status",
      "attention doctor",
      "attention setup codex",
      "attention backup export [path]",
      "attention backup import <path>",
      "attention cli <existing-low-level-command> [...args]",
    ],
  });
}
