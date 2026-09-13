import { withProcessLock } from "../../server/processLock";

// Holds the lock at argv[2] until killed; the parent test SIGKILLs this process to simulate a crash.
await withProcessLock(process.argv[2]!, async () => {
  console.log("locked");
  await Bun.sleep(60_000);
});
