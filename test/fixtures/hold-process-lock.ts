import { withProcessLock } from "../../server/processLock";

await withProcessLock(process.argv[2]!, async () => {
  console.log("locked");
  await Bun.sleep(60_000);
});
