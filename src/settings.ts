import type { Settings, UniquenessRule, AutoGroupRule } from "./types";

const SETTINGS_KEY = "settings";

export const DEFAULT_UNIQUENESS_RULES: UniquenessRule[] = [
  {
    id: "github-pr",
    name: "GitHub PRs",
    matchPattern: "https://github.com/*/*/pull/*",
    keyStrategy: "regexCapture",
    keyRegex: "^https://github\\.com/([^/]+/[^/]+/pull/\\d+)",
  },
];

export const DEFAULT_AUTOGROUP_RULES: AutoGroupRule[] = [
  {
    id: "github",
    name: "GitHub",
    color: "grey",
    matchPattern: "https://github.com/*",
  },
  {
    id: "jira",
    name: "Jira",
    color: "blue",
    matchPattern: "https://*.atlassian.net/*",
  },
];

export const DEFAULT_SETTINGS: Settings = {
  autoClose: {
    enabled: true,
    idleMinutes: 4320,
    sweepIntervalMinutes: 10,
    minTabsOpen: 5,
    action: "close",
    protectPinned: true,
    protectAudible: true,
    protectGrouped: false,
    allowlist: [],
  },
  uniqueness: {
    enabled: true,
    rules: DEFAULT_UNIQUENESS_RULES,
  },
  autoGroup: {
    enabled: true,
    rules: DEFAULT_AUTOGROUP_RULES,
    respectUserOverride: true,
  },
  prStatus: {
    enabled: false,
    pollMinutes: 5,
    groupColors: {
      draft: "grey",
      ready: "green",
      blocked: "red",
      merged: "purple",
      closed: "pink",
    },
    groupTitles: {
      draft: "PR: Draft",
      ready: "PR: Ready",
      blocked: "PR: Blocked",
      merged: "PR: Merged",
      closed: "PR: Closed",
    },
  },
};

function mergeWithDefaults(stored: Partial<Settings> | undefined): Settings {
  if (!stored) return structuredClone(DEFAULT_SETTINGS);
  return {
    autoClose: { ...DEFAULT_SETTINGS.autoClose, ...stored.autoClose },
    uniqueness: { ...DEFAULT_SETTINGS.uniqueness, ...stored.uniqueness },
    autoGroup: { ...DEFAULT_SETTINGS.autoGroup, ...stored.autoGroup },
    prStatus: {
      ...DEFAULT_SETTINGS.prStatus,
      ...stored.prStatus,
      groupColors: {
        ...DEFAULT_SETTINGS.prStatus.groupColors,
        ...stored.prStatus?.groupColors,
      },
      groupTitles: {
        ...DEFAULT_SETTINGS.prStatus.groupTitles,
        ...stored.prStatus?.groupTitles,
      },
    },
  };
}

export async function loadSettings(): Promise<Settings> {
  const result = await chrome.storage.sync.get(SETTINGS_KEY);
  return mergeWithDefaults(result[SETTINGS_KEY] as Partial<Settings> | undefined);
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
}

export function onSettingsChanged(
  cb: (settings: Settings) => void,
): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: chrome.storage.AreaName,
  ): void => {
    if (area !== "sync" || !changes[SETTINGS_KEY]) return;
    const next = changes[SETTINGS_KEY].newValue as Partial<Settings> | undefined;
    cb(mergeWithDefaults(next));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
