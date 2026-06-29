import type { GroupColor } from "./types";

/**
 * Find a group in `windowId` titled `name`; if it exists, just return its id
 * (updating its color if drifted). Otherwise create a fresh group containing
 * `tabId` and apply the title/color.
 *
 * Returns the resulting group id.
 */
export async function ensureGroupForTab(
  tabId: number,
  windowId: number | undefined,
  name: string,
  color: GroupColor,
): Promise<number> {
  const queryArgs: chrome.tabGroups.QueryInfo = { title: name };
  if (windowId != null) queryArgs.windowId = windowId;
  const existing = await chrome.tabGroups.query(queryArgs);
  const match = existing.find((g) => g.title === name);

  if (match) {
    if (match.color !== color) {
      try {
        await chrome.tabGroups.update(match.id, { color });
      } catch {
        // group may have been deleted concurrently; fall through and recreate.
      }
    }
    await chrome.tabs.group({ tabIds: tabId, groupId: match.id });
    return match.id;
  }

  const groupOpts: chrome.tabs.GroupOptions = { tabIds: tabId };
  if (windowId != null) groupOpts.createProperties = { windowId };
  const newId = await chrome.tabs.group(groupOpts);
  await chrome.tabGroups.update(newId, { title: name, color });
  return newId;
}
