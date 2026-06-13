import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { attentionHome } from "../server/paths";
import { resolveRuntimeRoot } from "../server/runtime";

describe("runtime resolution", () => {
  test("uses the shared workbench for a canonical source checkout", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "attention-runtime-"));
    const appRoot = path.join(parent, "attention");
    const previous = process.env.ATTENTION_HOME;
    delete process.env.ATTENTION_HOME;
    try {
      await mkdir(path.join(appRoot, ".git"), { recursive: true });
      await mkdir(path.join(appRoot, "bin"), { recursive: true });
      await writeFile(path.join(appRoot, ".git", "HEAD"), "ref: refs/heads/main\n");
      await writeFile(path.join(appRoot, "bin", "tend-live"), "#!/bin/zsh\n");
      expect(resolveRuntimeRoot(appRoot)).toBe(path.join(parent, ".attention-workbench"));
    } finally {
      if (previous === undefined) delete process.env.ATTENTION_HOME;
      else process.env.ATTENTION_HOME = previous;
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("does not attach a feature branch checkout to the shared runtime", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "attention-runtime-"));
    const appRoot = path.join(parent, "attention");
    const previous = process.env.ATTENTION_HOME;
    delete process.env.ATTENTION_HOME;
    try {
      await mkdir(path.join(appRoot, ".git"), { recursive: true });
      await mkdir(path.join(appRoot, "bin"), { recursive: true });
      await writeFile(path.join(appRoot, ".git", "HEAD"), "ref: refs/heads/feat/runtime-test\n");
      await writeFile(path.join(appRoot, "bin", "tend-live"), "#!/bin/zsh\n");
      expect(resolveRuntimeRoot(appRoot)).toBe(attentionHome());
    } finally {
      if (previous === undefined) delete process.env.ATTENTION_HOME;
      else process.env.ATTENTION_HOME = previous;
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("honors an explicit isolated runtime", () => {
    const previous = process.env.ATTENTION_HOME;
    process.env.ATTENTION_HOME = "/tmp/attention-isolated";
    try {
      expect(resolveRuntimeRoot("/tmp/attention-worktree")).toBe("/tmp/attention-isolated");
    } finally {
      if (previous === undefined) delete process.env.ATTENTION_HOME;
      else process.env.ATTENTION_HOME = previous;
    }
  });
});
