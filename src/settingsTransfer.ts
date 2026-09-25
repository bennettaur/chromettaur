import { mergeWithDefaults } from "./settings";
import {
  GROUP_COLORS,
  KEY_STRATEGIES,
  type GroupColor,
  type Settings,
} from "./types";

const EXPORT_FORMAT = "chromettaur-settings";
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

function readOptionalSection(
  settings: JsonRecord,
  key: string,
): JsonRecord | null {
  const section = settings[key];
  if (section === undefined) return null;
  if (!isRecord(section)) throw new Error(`"${key}" must be an object.`);
  return section;
}

function assertBooleansIfPresent(
  section: JsonRecord | null,
  sectionName: string,
  fields: string[],
): void {
  for (const field of fields) {
    const value = section?.[field];
    if (value !== undefined && typeof value !== "boolean") {
      throw new Error(`"${sectionName}.${field}" must be true or false.`);
    }
  }
}

function assertStringListIfPresent(list: unknown, path: string): void {
  if (list === undefined) return;
  if (!Array.isArray(list) || list.some((v) => typeof v !== "string")) {
    throw new Error(`"${path}" must be a list of strings.`);
  }
}

interface RuleShape {
  requiredStrings: string[];
  optionalStrings?: string[];
  allowedValues?: Record<string, readonly string[]>;
}

function assertRuleListIfPresent(
  list: unknown,
  path: string,
  shape: RuleShape,
): void {
  if (list === undefined) return;
  if (!Array.isArray(list)) throw new Error(`"${path}" must be a list.`);
  for (const rule of list) {
    const ok =
      isRecord(rule) &&
      shape.requiredStrings.every((f) => typeof rule[f] === "string") &&
      (shape.optionalStrings ?? []).every(
        (f) => rule[f] === undefined || typeof rule[f] === "string",
      ) &&
      Object.entries(shape.allowedValues ?? {}).every(([f, allowed]) =>
        allowed.includes(rule[f] as string),
      );
    if (!ok) throw new Error(`"${path}" contains an invalid rule.`);
  }
}

function assertRecordOfIfPresent(
  value: unknown,
  path: string,
  allowed: (v: unknown) => boolean,
): void {
  if (value === undefined) return;
  if (!isRecord(value) || !Object.values(value).every(allowed)) {
    throw new Error(`"${path}" has an invalid value.`);
  }
}

/**
 * Parse a file produced by `serializeSettings`. Throws an Error with a
 * user-facing message when the file isn't a Chromettaur export, or when a section,
 * list, rule, flag or choice has the wrong shape. Missing fields are filled
 * from defaults. Numbers and patterns are checked when the options page saves
 * the import.
 */
export function parseSettingsImport(text: string): Settings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("File is not valid JSON.");
  }
  if (!isRecord(parsed) || parsed.format !== EXPORT_FORMAT) {
    throw new Error("File is not a Chromettaur settings export.");
  }
  if (typeof parsed.version !== "number" || parsed.version > EXPORT_VERSION) {
    throw new Error(`Unsupported export version: ${String(parsed.version)}.`);
  }
  if (!isRecord(parsed.settings)) {
    throw new Error("Export has no settings object.");
  }

  const settings = parsed.settings;
  const autoClose = readOptionalSection(settings, "autoClose");
  const uniqueness = readOptionalSection(settings, "uniqueness");
  const autoGroup = readOptionalSection(settings, "autoGroup");
  const prStatus = readOptionalSection(settings, "prStatus");
  const repoSwitcher = readOptionalSection(settings, "repoSwitcher");

  assertBooleansIfPresent(autoClose, "autoClose", [
    "enabled",
    "protectPinned",
    "protectAudible",
    "protectGrouped",
  ]);
  assertBooleansIfPresent(uniqueness, "uniqueness", ["enabled"]);
  assertBooleansIfPresent(autoGroup, "autoGroup", [
    "enabled",
    "respectUserOverride",
  ]);
  assertBooleansIfPresent(prStatus, "prStatus", ["enabled"]);

  const action = autoClose?.action;
  if (action !== undefined && action !== "close" && action !== "discard") {
    throw new Error(`"autoClose.action" must be "close" or "discard".`);
  }

  assertStringListIfPresent(autoClose?.allowlist, "autoClose.allowlist");
  assertStringListIfPresent(repoSwitcher?.owners, "repoSwitcher.owners");
  assertRuleListIfPresent(uniqueness?.rules, "uniqueness.rules", {
    requiredStrings: ["id", "name", "matchPattern", "keyStrategy"],
    optionalStrings: ["keyRegex"],
    allowedValues: { keyStrategy: KEY_STRATEGIES },
  });
  assertRuleListIfPresent(autoGroup?.rules, "autoGroup.rules", {
    requiredStrings: ["id", "name", "matchPattern", "color"],
    allowedValues: { color: GROUP_COLORS },
  });
  assertRecordOfIfPresent(prStatus?.groupColors, "prStatus.groupColors", (v) =>
    GROUP_COLORS.includes(v as GroupColor),
  );
  assertRecordOfIfPresent(
    prStatus?.groupTitles,
    "prStatus.groupTitles",
    (v) => typeof v === "string",
  );

  return mergeWithDefaults(settings as Partial<Settings>);
}
