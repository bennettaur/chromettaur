import { ensureGroupForTab } from "./groups";
import { matches } from "./matcher";
import { loadSettings } from "./settings";
import {
  addUserOverride,
  loadState,
  recordManaged,
  removeUserOverride,
} from "./state";
import type { AutoGroupRule } from "./types";

const inFlight = new Set<number>();

export function isInFlight(tabId: number): boolean {
  return inFlight.has(tabId);
}

export function markInFlight(tabId: number): void {
  inFlight.add(tabId);
}

export function clearInFlight(tabId: number): void {
  inFlight.delete(tabId);
}

export async function handleAutoGroup(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id == null || !tab.url) return;

  const settings = await loadSettings();
  if (!settings.autoGroup.enabled) return;

  const rule = findRule(tab.url, settings.autoGroup.rules);
  if (!rule) return;

  const state = await loadState();

  if (
    settings.autoGroup.respectUserOverride &&
    state.userOverride.includes(tab.id)
  ) {
    const previous = state.managed[tab.id];
    if (previous && previous.groupRuleId !== rule.id) {
      await removeUserOverride(tab.id);
    } else {
      return;
    }
  }

  if (tab.groupId !== undefined && tab.groupId !== -1) {
    return;
  }

  inFlight.add(tab.id);
  try {
    const groupId = await ensureGroupForTab(
      tab.id,
      tab.windowId,
      rule.name,
      rule.color,
    );
    await recordManaged(tab.id, {
      groupRuleId: rule.id,
      assignedGroupId: groupId,
    });
  } catch {
    // tab/group may have moved or been closed under us; ignore.
  } finally {
    inFlight.delete(tab.id);
  }
}

/**
 * Called when a tab's groupId changes. If we previously managed this tab and
 * the user (not us) moved it out of its group, record an override so we don't
 * auto-regroup it.
 */
export async function reconcileGroupChange(
  tabId: number,
  newGroupId: number,
): Promise<void> {
  if (inFlight.has(tabId)) return;

  const settings = await loadSettings();
  if (!settings.autoGroup.respectUserOverride) return;

  const state = await loadState();
  const managed = state.managed[tabId];
  if (!managed) return;

  if (newGroupId === -1 || newGroupId !== managed.assignedGroupId) {
    await addUserOverride(tabId);
  }
}

function findRule(
  url: string,
  rules: AutoGroupRule[],
): AutoGroupRule | undefined {
  for (const rule of rules) {
    if (matches(url, rule.matchPattern)) return rule;
  }
  return undefined;
}
