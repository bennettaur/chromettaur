import { canonicalKey, matches } from "./matcher";
import { loadSettings } from "./settings";
import type { UniquenessRule } from "./types";

/**
 * Returns true if `tab` was closed in favour of an existing duplicate. Caller
 * should short-circuit further per-tab processing (auto-group) in that case.
 */
export async function handleUniqueness(
  tab: chrome.tabs.Tab,
): Promise<boolean> {
  if (tab.id == null || !tab.url) return false;

  const settings = await loadSettings();
  if (!settings.uniqueness.enabled) return false;

  const rule = findRule(tab.url, settings.uniqueness.rules);
  if (!rule) return false;

  const keyT = canonicalKey(tab.url, rule);
  if (keyT == null) return false;

  const allTabs = await chrome.tabs.query({});
  let duplicate: chrome.tabs.Tab | undefined;
  for (const other of allTabs) {
    if (other.id == null || other.id === tab.id) continue;
    if (!other.url) continue;
    if (!matches(other.url, rule.matchPattern)) continue;
    if (canonicalKey(other.url, rule) !== keyT) continue;
    if (!duplicate || (other.id != null && duplicate.id != null && other.id < duplicate.id)) {
      duplicate = other;
    }
  }

  if (!duplicate || duplicate.id == null) return false;

  try {
    await chrome.tabs.update(duplicate.id, { active: true });
    if (duplicate.windowId != null && duplicate.windowId !== chrome.windows.WINDOW_ID_NONE) {
      await chrome.windows.update(duplicate.windowId, { focused: true });
    }
    await chrome.tabs.remove(tab.id);
    return true;
  } catch {
    return false;
  }
}

function findRule(
  url: string,
  rules: UniquenessRule[],
): UniquenessRule | undefined {
  for (const rule of rules) {
    if (matches(url, rule.matchPattern)) return rule;
  }
  return undefined;
}
