import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS, mergeWithDefaults } from "../src/settings";
import {
  parseSettingsImport,
  serializeSettings,
} from "../src/settingsTransfer";

function exportWith(settings: unknown, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    format: "chromettaur-settings",
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
    expect(imported.repoSwitcher).toEqual(DEFAULT_SETTINGS.repoSwitcher);
  });
});

describe("mergeWithDefaults", () => {
  it("returns lists that can be edited without changing the defaults", () => {
    const settings = mergeWithDefaults({});

    settings.repoSwitcher.owners.push("someone");
    settings.autoGroup.rules.pop();

    expect(DEFAULT_SETTINGS.repoSwitcher.owners).not.toContain("someone");
    expect(DEFAULT_SETTINGS.autoGroup.rules).toHaveLength(2);
  });
});

describe("parseSettingsImport rejects", () => {
  it("invalid JSON", () => {
    expect(() => parseSettingsImport("{nope")).toThrow("not valid JSON");
  });

  it("JSON that isn't a Chromettaur export", () => {
    expect(() => parseSettingsImport(JSON.stringify({ a: 1 }))).toThrow(
      "not a Chromettaur settings export",
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

  it("repo switcher owners that aren't strings", () => {
    expect(() =>
      parseSettingsImport(exportWith({ repoSwitcher: { owners: [null] } })),
    ).toThrow('"repoSwitcher.owners" must be a list of strings');
  });

  it("a rule with no match pattern", () => {
    expect(() =>
      parseSettingsImport(
        exportWith({
          autoGroup: { rules: [{ id: "x", name: "X", color: "grey" }] },
        }),
      ),
    ).toThrow('"autoGroup.rules" contains an invalid rule');
  });

  it("a uniqueness rule with an unknown key strategy", () => {
    const rule = {
      id: "x",
      name: "X",
      matchPattern: "https://example.com/*",
      keyStrategy: "bogus",
    };

    expect(() =>
      parseSettingsImport(exportWith({ uniqueness: { rules: [rule] } })),
    ).toThrow('"uniqueness.rules" contains an invalid rule');
  });

  it("a rule list that isn't a list", () => {
    expect(() =>
      parseSettingsImport(exportWith({ uniqueness: { rules: {} } })),
    ).toThrow('"uniqueness.rules" must be a list');
  });

  it("a non-boolean enabled flag", () => {
    expect(() =>
      parseSettingsImport(exportWith({ autoClose: { enabled: "false" } })),
    ).toThrow('"autoClose.enabled" must be true or false');
  });

  it("an unknown auto-close action", () => {
    expect(() =>
      parseSettingsImport(exportWith({ autoClose: { action: "explode" } })),
    ).toThrow('"autoClose.action" must be "close" or "discard"');
  });

  it("an invalid PR status group color", () => {
    expect(() =>
      parseSettingsImport(
        exportWith({ prStatus: { groupColors: { draft: "magenta" } } }),
      ),
    ).toThrow('"prStatus.groupColors" has an invalid value');
  });

  it("a rule with a non-string match pattern", () => {
    expect(() =>
      parseSettingsImport(
        exportWith({ autoGroup: { rules: [{ matchPattern: 42 }] } }),
      ),
    ).toThrow('"autoGroup.rules" contains an invalid rule');
  });
});

describe("reviewer group settings", () => {
  it("fills new group defaults into settings stored before they existed", () => {
    const merged = mergeWithDefaults({
      prStatus: {
        ...DEFAULT_SETTINGS.prStatus,
        groupTitles: {
          draft: "D",
          ready: "R",
          blocked: "B",
          merged: "M",
          closed: "C",
        },
      },
    } as never);
    expect(merged.prStatus.groupTitles.reviewer).toBe("PR: Reviewer");
    expect(merged.prStatus.groupTitles.needsAttention).toBe(
      "PR: Needs attention",
    );
    expect(merged.prStatus.groupColors.needsAttention).toBe("orange");
    expect(merged.prStatus.groupColors.reviewer).toBe("yellow");
    expect(merged.prStatus.groupTitles.draft).toBe("D");
  });

  it("round-trips a customised reviewer group", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.prStatus.groupTitles.reviewer = "Review me";
    settings.prStatus.groupColors.reviewer = "orange";
    expect(parseSettingsImport(serializeSettings(settings))).toEqual(settings);
  });
});

describe("autoOpen settings", () => {
  it("defaults to off with a cap of 10", () => {
    expect(mergeWithDefaults({}).autoOpen).toEqual({
      enabled: false,
      maxOpen: 10,
    });
  });

  it("round-trips", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.autoOpen = { enabled: true, maxOpen: 3 };
    expect(parseSettingsImport(serializeSettings(settings))).toEqual(settings);
  });

  it("rejects a non-boolean enabled", () => {
    expect(() =>
      parseSettingsImport(exportWith({ autoOpen: { enabled: "yes" } })),
    ).toThrow('"autoOpen.enabled" must be true or false.');
  });
});

describe("PR status defaults", () => {
  it("polls every 2 minutes", () => {
    expect(mergeWithDefaults({}).prStatus.pollMinutes).toBe(2);
  });

  it("keeps a poll interval the user already saved", () => {
    const merged = mergeWithDefaults({
      prStatus: { ...DEFAULT_SETTINGS.prStatus, pollMinutes: 5 },
    });
    expect(merged.prStatus.pollMinutes).toBe(5);
  });
});
