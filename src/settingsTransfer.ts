import { mergeWithDefaults } from "./settings";
import type { Settings } from "./types";

const EXPORT_FORMAT = "tabkit-settings";
const EXPORT_VERSION = 1;

interface SettingsExport {
  format: typeof EXPORT_FORMAT;
  version: number;
  exportedAt: string;
  settings: Settings;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function serializeSettings(
  settings: Settings,
  now: Date = new Date(),
): string {
  const payload: SettingsExport = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: now.toISOString(),
    settings,
  };
  return JSON.stringify(payload, null, 2);
}

function requireSection(settings: JsonRecord, key: string): JsonRecord | null {
  const section = settings[key];
  if (section === undefined) return null;
  if (!isRecord(section)) throw new Error(`"${key}" must be an object.`);
  return section;
}

function requireStringList(list: unknown, path: string): void {
  if (list === undefined) return;
  if (!Array.isArray(list) || list.some((v) => typeof v !== "string")) {
    throw new Error(`"${path}" must be a list of strings.`);
  }
}

function requireRuleList(
  list: unknown,
  path: string,
  stringFields: string[],
): void {
  if (list === undefined) return;
  if (!Array.isArray(list)) throw new Error(`"${path}" must be a list.`);
  for (const rule of list) {
    const ok =
      isRecord(rule) &&
      stringFields.every(
        (field) => rule[field] === undefined || typeof rule[field] === "string",
      );
    if (!ok) throw new Error(`"${path}" contains an invalid rule.`);
  }
}

/**
 * Parse a file produced by `serializeSettings`. Throws an Error with a
 * user-facing message when the file isn't a TabKit export or a field has the
 * wrong type. Missing fields are filled from defaults; field values (patterns,
 * intervals) are left for the options page's validation.
 */
export function parseSettingsImport(text: string): Settings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("File is not valid JSON.");
  }
  if (!isRecord(parsed) || parsed.format !== EXPORT_FORMAT) {
    throw new Error("File is not a TabKit settings export.");
  }
  if (typeof parsed.version !== "number" || parsed.version > EXPORT_VERSION) {
    throw new Error(`Unsupported export version: ${String(parsed.version)}.`);
  }
  if (!isRecord(parsed.settings)) {
    throw new Error("Export has no settings object.");
  }

  const settings = parsed.settings;
  const autoClose = requireSection(settings, "autoClose");
  const uniqueness = requireSection(settings, "uniqueness");
  const autoGroup = requireSection(settings, "autoGroup");
  const prStatus = requireSection(settings, "prStatus");

  requireStringList(autoClose?.allowlist, "autoClose.allowlist");
  requireRuleList(uniqueness?.rules, "uniqueness.rules", [
    "id",
    "name",
    "matchPattern",
    "keyStrategy",
    "keyRegex",
  ]);
  requireRuleList(autoGroup?.rules, "autoGroup.rules", [
    "id",
    "name",
    "color",
    "matchPattern",
  ]);
  if (prStatus?.groupColors !== undefined && !isRecord(prStatus.groupColors)) {
    throw new Error(`"prStatus.groupColors" must be an object.`);
  }
  if (prStatus?.groupTitles !== undefined && !isRecord(prStatus.groupTitles)) {
    throw new Error(`"prStatus.groupTitles" must be an object.`);
  }

  return mergeWithDefaults(settings as Partial<Settings>);
}
