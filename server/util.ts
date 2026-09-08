import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withProcessLock } from "./processLock";

export const isoNow = () => new Date().toISOString();
export const makeId = (prefix: string) => `${prefix}_${randomUUID()}`;
export const makeToken = () => randomBytes(24).toString("hex");
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function safeIdentifier(value: string, label: string): string {
  if (!SAFE_IDENTIFIER_PATTERN.test(value) || value === "." || value === "..") {
    throw new Error(`${label} must use only letters, numbers, dots, underscores, and hyphens.`);
  }
  return value;
}

export async function withMutationLock<T>(dataDir: string, callback: () => Promise<T>): Promise<T> {
  return withProcessLock(join(dataDir, ".mutation-lock"), callback);
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, value.endsWith("\n") ? value : `${value}\n`, "utf8");
  await rename(temporary, path);
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 56) || "new-feed";
}

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
