import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { name: string; version: string };
const binaryPath = path.resolve(process.env.ATTENTION_BINARY ?? path.join("dist-bin", "attention"));
const clientDir = path.resolve(process.env.ATTENTION_CLIENT_DIR ?? "dist");
const platform = process.env.ATTENTION_PACKAGE_PLATFORM ?? process.platform;
const arch = process.env.ATTENTION_PACKAGE_ARCH ?? process.arch;
const packageName = `${packageJson.name}-${packageJson.version}-${platform}-${arch}`;
const releaseDir = path.join(root, "dist-bin", "releases");
const stageRoot = path.join(releaseDir, ".stage");
const stageDir = path.join(stageRoot, packageName);
const archivePath = path.join(releaseDir, `${packageName}.tar.gz`);
const checksumPath = `${archivePath}.sha256`;

if (!existsSync(binaryPath)) {
  throw new Error(`Compiled binary not found: ${binaryPath}. Run pnpm attention:build first.`);
}
if (!existsSync(path.join(clientDir, "index.html"))) {
  throw new Error(`Built UI assets not found: ${clientDir}. Run pnpm build first.`);
}

await rm(stageRoot, { recursive: true, force: true });
await mkdir(stageDir, { recursive: true });
await cp(binaryPath, path.join(stageDir, "attention"));
await cp(clientDir, path.join(stageDir, "dist"), { recursive: true });
await cp(path.join(root, "README.md"), path.join(stageDir, "README.md"));
await cp(path.join(root, "CONTRIBUTING.md"), path.join(stageDir, "CONTRIBUTING.md"));
await copyDocs([
  "docs/INSTALL.md",
  "docs/AGENT_CONTRACT.md",
  "docs/DATA.md",
  "docs/SECURITY.md",
  "RUNBOOK.md",
  "CAPABILITY_MAP.md",
]);
await writeFile(path.join(stageDir, "manifest.json"), JSON.stringify({
  name: packageJson.name,
  version: packageJson.version,
  platform,
  arch,
  binary: "attention",
  uiAssets: "dist",
  createdAt: new Date().toISOString(),
}, null, 2));
await rm(archivePath, { force: true });
await rm(checksumPath, { force: true });
await tar(stageRoot, packageName, archivePath);
const checksum = createHash("sha256").update(await readFile(archivePath)).digest("hex");
await writeFile(checksumPath, `${checksum}  ${path.basename(archivePath)}\n`);
await rm(stageRoot, { recursive: true, force: true });

console.log(JSON.stringify({ ok: true, archivePath, checksumPath, checksum }, null, 2));

async function copyDocs(files: string[]): Promise<void> {
  for (const relative of files) {
    const source = path.join(root, relative);
    if (!existsSync(source)) continue;
    const target = path.join(stageDir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target);
  }
}

async function tar(cwd: string, directory: string, archive: string): Promise<void> {
  const subprocess = Bun.spawn(["tar", "-czf", archive, "-C", cwd, directory], {
    stderr: "inherit",
    stdout: "inherit",
  });
  const exitCode = await subprocess.exited;
  if (exitCode !== 0) throw new Error(`tar failed with exit code ${exitCode}`);
}
