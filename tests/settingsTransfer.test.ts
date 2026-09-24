import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS } from "../src/settings";
import {
  parseSettingsImport,
  serializeSettings,
} from "../src/settingsTransfer";

function exportWith(settings: unknown, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    format: "tabkit-settings",
    version: 1,
    settings,
    ...extra,
  });
}

describe("serializeSettings / parseSettingsImport", () => {
  it("round-trips settings", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.autoClose.enabled = true;
    settings.autoClose.allowlist = ["https://example.com/*"];

    expect(parseSettingsImport(serializeSettings(settings))).toEqual(settings);
  });

  it("records the export time", () => {
    const json = serializeSettings(
      DEFAULT_SETTINGS,
      new Date("2026-01-02T03:04:05Z"),
    );

    expect(JSON.parse(json).exportedAt).toBe("2026-01-02T03:04:05.000Z");
  });

  it("fills missing sections and fields from defaults", () => {
    const imported = parseSettingsImport(
      exportWith({ autoClose: { idleMinutes: 30 } }),
    );

    expect(imported.autoClose.idleMinutes).toBe(30);
    expect(imported.autoClose.minTabsOpen).toBe(
      DEFAULT_SETTINGS.autoClose.minTabsOpen,
    );
    expect(imported.autoGroup).toEqual(DEFAULT_SETTINGS.autoGroup);
  });
});

describe("parseSettingsImport rejects", () => {
  it("invalid JSON", () => {
    expect(() => parseSettingsImport("{nope")).toThrow("not valid JSON");
  });

  it("JSON that isn't a TabKit export", () => {
    expect(() => parseSettingsImport(JSON.stringify({ a: 1 }))).toThrow(
      "not a TabKit settings export",
    );
  });

  it("a newer export version", () => {
    expect(() => parseSettingsImport(exportWith({}, { version: 2 }))).toThrow(
      "Unsupported export version",
    );
  });

  it("a section that isn't an object", () => {
    expect(() => parseSettingsImport(exportWith({ autoClose: [] }))).toThrow(
      '"autoClose" must be an object',
    );
  });

  it("an allowlist with non-string entries", () => {
    expect(() =>
      parseSettingsImport(exportWith({ autoClose: { allowlist: [1] } })),
    ).toThrow('"autoClose.allowlist" must be a list of strings');
  });

  it("a rule with a non-string match pattern", () => {
    expect(() =>
      parseSettingsImport(
        exportWith({ autoGroup: { rules: [{ matchPattern: 42 }] } }),
      ),
    ).toThrow('"autoGroup.rules" contains an invalid rule');
  });
});
