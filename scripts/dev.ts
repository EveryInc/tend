export {};

const commands = [
  [process.execPath, "server.ts"],
  [process.execPath, "node_modules/vite/bin/vite.js", "--host", "127.0.0.1"],
];

const processes = commands.map((command) => Bun.spawn(command, {
  cwd: process.cwd(),
  env: process.env,
  stderr: "inherit",
  stdin: "inherit",
  stdout: "inherit",
}));

let stopping = false;
let requestedSignal: NodeJS.Signals | null = null;

function stop(signal: NodeJS.Signals = "SIGTERM"): void {
  if (stopping) return;
  stopping = true;
  for (const subprocess of processes) {
    try {
      subprocess.kill(signal);
    } catch {
      // The process may already have exited.
    }
  }
}

process.on("SIGINT", () => {
  requestedSignal = "SIGINT";
  stop("SIGINT");
});
process.on("SIGTERM", () => {
  requestedSignal = "SIGTERM";
  stop("SIGTERM");
});

const firstExit = await Promise.race(processes.map(async (subprocess) => ({
  exitCode: await subprocess.exited,
  pid: subprocess.pid,
})));
stop();
await Promise.all(processes.map((subprocess) => subprocess.exited));

if (!requestedSignal && firstExit.exitCode !== 0) {
  console.error(`Development process ${firstExit.pid} exited with code ${firstExit.exitCode}.`);
}
process.exit(requestedSignal === "SIGINT" ? 0 : requestedSignal === "SIGTERM" ? 143 : firstExit.exitCode);
