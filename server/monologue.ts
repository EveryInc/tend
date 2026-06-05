import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DictationCapability } from "../shared/types";
import { isoNow } from "./util";

const DEFAULT_APP_PATH = "/Applications/Monologue.app";
const DEFAULT_SETTINGS_PATH = path.join(os.homedir(), "Library/Containers/com.zeitalabs.jottleai/Data/Documents/jottle_settings.json");

const modifierCodes: Record<string, { code: string; label: string }> = {
  leftCommand: { code: "MetaLeft", label: "Left Command" },
  rightCommand: { code: "MetaRight", label: "Right Command" },
  leftControl: { code: "ControlLeft", label: "Left Control" },
  rightControl: { code: "ControlRight", label: "Right Control" },
  leftOption: { code: "AltLeft", label: "Left Option" },
  rightOption: { code: "AltRight", label: "Right Option" },
  leftShift: { code: "ShiftLeft", label: "Left Shift" },
  rightShift: { code: "ShiftRight", label: "Right Shift" },
};

export function defaultDictationCapability(): DictationCapability {
  return {
    provider: null,
    status: "not_checked",
    activationCode: "AltRight",
    activationLabel: "Right Option",
    source: "fallback",
    detectedAt: null,
    note: "Codex has not checked for a local dictation app yet. The dock keeps the Inbox Sweep Right Option fallback.",
  };
}

function configuredModifierNames(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(configuredModifierNames);
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
    ...(key in modifierCodes ? [key] : []),
    ...configuredModifierNames(child),
  ]);
}

export async function detectMonologue(options: { appPath?: string; settingsPath?: string } = {}): Promise<DictationCapability> {
  const appPath = options.appPath ?? DEFAULT_APP_PATH;
  const settingsPath = options.settingsPath ?? DEFAULT_SETTINGS_PATH;
  const detectedAt = isoNow();
  if (!existsSync(appPath)) {
    return {
      ...defaultDictationCapability(),
      status: "not_installed",
      detectedAt,
      note: "Codex did not find Monologue. The dock keeps the Inbox Sweep Right Option fallback.",
    };
  }
  if (!existsSync(settingsPath)) {
    return {
      provider: "monologue",
      status: "detected_default",
      activationCode: "AltRight",
      activationLabel: "Right Option",
      source: "monologue_default",
      detectedAt,
      note: "Codex found Monologue but not its local settings file, so the dock uses Monologue's documented Right Option default.",
    };
  }
  const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { hotkey?: unknown };
  const names = [...new Set(configuredModifierNames(settings.hotkey))];
  if (names.length === 1) {
    const configured = modifierCodes[names[0]];
    return {
      provider: "monologue",
      status: "detected_configured",
      activationCode: configured.code,
      activationLabel: configured.label,
      source: "monologue_settings",
      detectedAt,
      note: `Codex found Monologue and configured the dock to follow its ${configured.label} recording shortcut.`,
    };
  }
  return {
    provider: "monologue",
    status: "detected_unsupported",
    activationCode: "AltRight",
    activationLabel: "Right Option",
    source: "fallback",
    detectedAt,
    note: "Codex found Monologue, but its recording shortcut is not a supported single modifier. The dock keeps the Right Option fallback until Codex adds support.",
  };
}
