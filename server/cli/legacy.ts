export async function runLegacyCli(args: string[]): Promise<void> {
  process.argv = [process.argv[0] ?? "bun", "cli.ts", ...args];
  await import("../../cli");
}
