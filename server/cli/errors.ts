import { cliCommandUsage } from "./contract";

type CliErrorOptions = {
  code: string;
  hint: string;
};

export class CliError extends Error {
  code: string;
  hint: string;

  constructor(message: string, options: CliErrorOptions) {
    super(message);
    this.name = "CliError";
    this.code = options.code;
    this.hint = options.hint;
  }
}

export class MissingFlagError extends CliError {
  constructor(command: string, flag: string) {
    const usage = cliCommandUsage(command);
    super(`Missing --${flag}`, {
      code: "missing_flag",
      hint: usage ? `Usage: attention cli ${usage}` : `Run attention cli help and retry ${command} with --${flag}.`,
    });
  }
}

export function formatCliError(error: unknown): { ok: false; error: string; code?: string; hint: string } {
  if (error instanceof CliError) {
    return { ok: false, error: error.message, code: error.code, hint: error.hint };
  }

  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: message, hint: hintForDomainError(message) };
}

function hintForDomainError(message: string): string {
  if (message.includes("does not own the feed")) return "Use the feed's bound home thread id, or pass --cross-feed only for explicit cross-feed operation.";
  if (message.includes("Invalid scoped work capability token")) return "Use the capabilityToken returned by the latest successful work:claim for this work item.";
  if (message.includes("Approved action must pass action:verify")) return "Call attention cli action:verify immediately before the external mutation, then complete with the same token.";
  if (message.includes("Approval stale")) return "Reread the current card or routine group, then return it to review or ask the user to approve the current snapshot.";
  if (message.includes("Source recipe not found")) return "Inspect the feed sources with attention cli inspect --feed <id>, then use a configured source id.";
  return "Run attention cli help for the command contract and retry with current feed/work state.";
}
