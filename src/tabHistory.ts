// Tab IDs don't survive a browser restart, so history lives in session
// storage. It still survives the service worker being suspended.
const HISTORY_KEY = "tabHistory";
const HISTORY_CAP = 100;

let pendingUpdate: Promise<void> = Promise.resolve();

// Serialized so a burst of activation events can't interleave their
// read-modify-write cycles and drop entries.
function updateHistory(mutate: (ids: number[]) => number[]): Promise<void> {
  pendingUpdate = pendingUpdate
    .then(async () => {
      const ids = await loadTabHistory();
      await chrome.storage.session.set({ [HISTORY_KEY]: mutate(ids) });
    })
    .catch(() => {
      // Storage errors shouldn't block later updates.
    });
  return pendingUpdate;
}

/** Tab IDs, most recently viewed first. */
export async function loadTabHistory(): Promise<number[]> {
  const r = await chrome.storage.session.get(HISTORY_KEY);
  return (r[HISTORY_KEY] as number[] | undefined) ?? [];
}

export function recordTabViewed(tabId: number): Promise<void> {
  return updateHistory((ids) =>
    [tabId, ...ids.filter((id) => id !== tabId)].slice(0, HISTORY_CAP),
  );
}

export async function recordWindowFocused(windowId: number): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (tab?.id != null) await recordTabViewed(tab.id);
}

export function forgetTab(tabId: number): Promise<void> {
  return updateHistory((ids) => ids.filter((id) => id !== tabId));
}

export function replaceTab(addedTabId: number, removedTabId: number): Promise<void> {
  return updateHistory((ids) =>
    ids.map((id) => (id === removedTabId ? addedTabId : id)),
  );
}

/**
 * Order tabs most recently viewed first. Tabs missing from `history` (e.g.
 * after a browser restart) follow, ordered by Chrome's `lastAccessed`.
 */
export function orderTabsByHistory(
  tabs: chrome.tabs.Tab[],
  history: number[],
): chrome.tabs.Tab[] {
  const rank = new Map(history.map((id, idx) => [id, idx]));
  const rankOf = (tab: chrome.tabs.Tab): number =>
    (tab.id != null ? rank.get(tab.id) : undefined) ?? history.length;

  return [...tabs].sort(
    (a, b) =>
      rankOf(a) - rankOf(b) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0),
  );
}

/** Keep tabs whose title or URL contains every space-separated term. */
export function filterTabs(
  tabs: chrome.tabs.Tab[],
  query: string,
): chrome.tabs.Tab[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return tabs;
  return tabs.filter((tab) => {
    const haystack = `${tab.title ?? ""} ${tab.url ?? ""}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
