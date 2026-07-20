import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AUTOSTART_LABEL,
  autostartStatus,
  installAutostart,
  renderLaunchAgentPlist,
  uninstallAutostart,
} from "../server/cli/autostart";

describe("macOS autostart", () => {
  test("renders an escaped one-shot login launcher with an explicit runtime", () => {
    const plist = renderLaunchAgentPlist({
      label: AUTOSTART_LABEL,
      command: ["/Applications/Tend & Mail/tend"],
      runtimeHome: "/Users/me/.attention",
      clientDir: "/Applications/Tend & Mail/dist",
      port: 4332,
      logPath: "/Users/me/.attention/logs/autostart.log",
    });

    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("/Applications/Tend &amp; Mail/tend");
    expect(plist).toContain("<string>start</string>");
    expect(plist).toContain("<key>ATTENTION_HOME</key>");
    expect(plist).toContain("<key>ATTENTION_CLIENT_DIR</key>");
    expect(plist).not.toContain("<key>KeepAlive</key>");
  });

  test("installs, reports, and uninstalls the per-user LaunchAgent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tend-autostart-"));
    const clientDir = path.join(root, "Tend & Mail", "dist");
    const runtimeHome = path.join(root, "attention home");
    await mkdir(clientDir, { recursive: true });
    await writeFile(path.join(clientDir, "index.html"), "<!doctype html>");
    const calls: string[][] = [];
    let loaded = false;
    const runLaunchctl = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "bootstrap") loaded = true;
      if (args[0] === "bootout") loaded = false;
      return {
        exitCode: args[0] === "print" && !loaded ? 113 : 0,
        stdout: "",
        stderr: "",
      };
    };
    const options = {
      platform: "darwin" as const,
      userHome: root,
      uid: 503,
      runtimeHome,
      port: 4332,
      command: [path.join(root, "Tend & Mail", "tend")],
      clientDir,
      runLaunchctl,
    };

    try {
      const installed = await installAutostart(options);
      const plist = await readFile(installed.plistPath, "utf8");
      expect(installed).toMatchObject({ installed: true, loaded: true });
      expect(plist).toContain("Tend &amp; Mail");
      expect(calls).toEqual([
        ["print", `gui/503/${AUTOSTART_LABEL}`],
        ["enable", `gui/503/${AUTOSTART_LABEL}`],
        ["bootstrap", "gui/503", installed.plistPath],
      ]);

      expect(await autostartStatus(options)).toMatchObject({ installed: true, loaded: true });
      expect(await uninstallAutostart(options)).toMatchObject({ installed: false, loaded: false });
      expect(await Bun.file(installed.plistPath).exists()).toBe(false);
      expect(await uninstallAutostart(options)).toMatchObject({ installed: false, loaded: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const failedOperation of ["enable", "bootout", "bootstrap"] as const) {
    test(`restores a working LaunchAgent when ${failedOperation} fails`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), `tend-autostart-${failedOperation}-`));
      const clientDir = path.join(root, "new", "dist");
      const plistPath = path.join(root, "Library", "LaunchAgents", `${AUTOSTART_LABEL}.plist`);
      const previousPlist = "previous working plist\n";
      await mkdir(clientDir, { recursive: true });
      await mkdir(path.dirname(plistPath), { recursive: true });
      await writeFile(path.join(clientDir, "index.html"), "<!doctype html>");
      await writeFile(plistPath, previousPlist);
      let loaded = true;
      let failed = false;
      const runLaunchctl = async (args: string[]) => {
        if (args[0] === failedOperation && !failed) {
          failed = true;
          return { exitCode: 5, stdout: "", stderr: "injected failure" };
        }
        if (args[0] === "bootout") loaded = false;
        if (args[0] === "bootstrap") loaded = true;
        return {
          exitCode: args[0] === "print" && !loaded ? 113 : 0,
          stdout: "",
          stderr: "",
        };
      };

      try {
        await expect(installAutostart({
          platform: "darwin",
          userHome: root,
          uid: 503,
          runtimeHome: path.join(root, "attention"),
          command: [path.join(root, "new", "tend")],
          clientDir,
          runLaunchctl,
        })).rejects.toThrow(`launchctl ${failedOperation} failed`);
        expect(await readFile(plistPath, "utf8")).toBe(previousPlist);
        expect(loaded).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  test("reloads the prior LaunchAgent when bootout unloads it before failing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tend-autostart-partial-bootout-"));
    const clientDir = path.join(root, "new", "dist");
    const plistPath = path.join(root, "Library", "LaunchAgents", `${AUTOSTART_LABEL}.plist`);
    const previousPlist = "previous working plist\n";
    await mkdir(clientDir, { recursive: true });
    await mkdir(path.dirname(plistPath), { recursive: true });
    await writeFile(path.join(clientDir, "index.html"), "<!doctype html>");
    await writeFile(plistPath, previousPlist);
    const calls: string[][] = [];
    let loaded = true;
    let failed = false;
    const runLaunchctl = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "bootout") {
        loaded = false;
        if (!failed) {
          failed = true;
          return { exitCode: 5, stdout: "", stderr: "injected failure" };
        }
      }
      if (args[0] === "bootstrap") loaded = true;
      return {
        exitCode: args[0] === "print" && !loaded ? 113 : 0,
        stdout: "",
        stderr: "",
      };
    };

    try {
      await expect(installAutostart({
        platform: "darwin",
        userHome: root,
        uid: 503,
        runtimeHome: path.join(root, "attention"),
        command: [path.join(root, "new", "tend")],
        clientDir,
        runLaunchctl,
      })).rejects.toThrow("launchctl bootout failed");
      expect(await readFile(plistPath, "utf8")).toBe(previousPlist);
      expect(loaded).toBe(true);
      expect(calls).toEqual([
        ["print", `gui/503/${AUTOSTART_LABEL}`],
        ["enable", `gui/503/${AUTOSTART_LABEL}`],
        ["bootout", `gui/503/${AUTOSTART_LABEL}`],
        ["print", `gui/503/${AUTOSTART_LABEL}`],
        ["bootstrap", "gui/503", plistPath],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("removes a first-install candidate when bootstrap loads it before failing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tend-autostart-partial-bootstrap-"));
    const clientDir = path.join(root, "new", "dist");
    const plistPath = path.join(root, "Library", "LaunchAgents", `${AUTOSTART_LABEL}.plist`);
    await mkdir(clientDir, { recursive: true });
    await writeFile(path.join(clientDir, "index.html"), "<!doctype html>");
    const calls: string[][] = [];
    let loaded = false;
    let failed = false;
    const runLaunchctl = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "bootstrap") {
        loaded = true;
        if (!failed) {
          failed = true;
          return { exitCode: 5, stdout: "", stderr: "injected failure" };
        }
      }
      if (args[0] === "bootout") loaded = false;
      return {
        exitCode: args[0] === "print" && !loaded ? 113 : 0,
        stdout: "",
        stderr: "",
      };
    };

    try {
      await expect(installAutostart({
        platform: "darwin",
        userHome: root,
        uid: 503,
        runtimeHome: path.join(root, "attention"),
        command: [path.join(root, "new", "tend")],
        clientDir,
        runLaunchctl,
      })).rejects.toThrow("launchctl bootstrap failed");
      expect(await Bun.file(plistPath).exists()).toBe(false);
      expect(loaded).toBe(false);
      expect(calls).toEqual([
        ["print", `gui/503/${AUTOSTART_LABEL}`],
        ["enable", `gui/503/${AUTOSTART_LABEL}`],
        ["bootstrap", "gui/503", plistPath],
        ["print", `gui/503/${AUTOSTART_LABEL}`],
        ["bootout", `gui/503/${AUTOSTART_LABEL}`],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("status and uninstall recover an orphaned LaunchAgent without UI assets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tend-autostart-orphan-"));
    const plistPath = path.join(root, "Library", "LaunchAgents", `${AUTOSTART_LABEL}.plist`);
    await mkdir(path.dirname(plistPath), { recursive: true });
    await writeFile(plistPath, "orphaned plist\n");
    const runLaunchctl = async () => ({ exitCode: 113, stdout: "", stderr: "not loaded" });
    const options = {
      platform: "darwin" as const,
      userHome: root,
      uid: 503,
      clientDir: path.join(root, "missing-dist"),
      runLaunchctl,
    };

    try {
      const status = await autostartStatus(options);
      expect(status).toEqual({
        supported: true,
        installed: true,
        loaded: false,
        label: AUTOSTART_LABEL,
        plistPath,
      });
      expect(await uninstallAutostart(options)).toMatchObject({ installed: false, loaded: false });
      expect(await Bun.file(plistPath).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects unsupported operating systems", async () => {
    await expect(autostartStatus({ platform: "linux" })).rejects.toThrow(
      "supports macOS LaunchAgents only",
    );
  });
});
