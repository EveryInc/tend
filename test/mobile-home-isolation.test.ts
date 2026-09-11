import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadMobileCloudEnvFile, mobileCloudConfigFromEnv } from "../server/mobile/client";

test("isolated homes require explicit mobile sync opt-in", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tend-mobile-config-"));
  try {
    const file = path.join(root, "tend", "mobile.env");
    await mkdir(path.dirname(file));
    await writeFile(file, "TEND_MOBILE_SUPABASE_URL=https://fixture.invalid\nTEND_MOBILE_SUPABASE_SECRET_KEY=fixture\nTEND_MOBILE_USER_ID=user\nTEND_MOBILE_WORKER_ID=worker\n", { mode: 0o600 });
    const canonical: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: root };
    loadMobileCloudEnvFile(canonical);
    expect(mobileCloudConfigFromEnv(canonical)?.userId).toBe("user");
    expect(mobileCloudConfigFromEnv({ ...canonical, ATTENTION_HOME: "" })).toBeNull();
    const isolated: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: root, ATTENTION_HOME: path.join(root, "home") };
    loadMobileCloudEnvFile(isolated);
    expect(mobileCloudConfigFromEnv(isolated)).toBeNull();
    Object.assign(isolated, canonical);
    expect(mobileCloudConfigFromEnv(isolated)).toBeNull();
    isolated.TEND_MOBILE_SYNC = "1";
    isolated.TEND_MOBILE_ENV_FILE = file;
    loadMobileCloudEnvFile(isolated);
    expect(mobileCloudConfigFromEnv(isolated)?.userId).toBe("user");
    isolated.TEND_MOBILE_SYNC = "0";
    expect(mobileCloudConfigFromEnv(isolated)).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
