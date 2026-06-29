import type { ManagedTab, RecentlyClosedEntry, RuntimeState } from "./types";

const STATE_KEY = "runtimeState";
const RECENT_CAP = 25;

const EMPTY_STATE: RuntimeState = {
  managed: {},
  userOverride: [],
  recentlyClosed: [],
};

export async function loadState(): Promise<RuntimeState> {
  const result = await chrome.storage.local.get(STATE_KEY);
  const stored = result[STATE_KEY] as Partial<RuntimeState> | undefined;
  return {
    managed: stored?.managed ?? {},
    userOverride: stored?.userOverride ?? [],
    recentlyClosed: stored?.recentlyClosed ?? [],
  };
}

export async function saveState(state: RuntimeState): Promise<void> {
  await chrome.storage.local.set({ [STATE_KEY]: state });
}

export async function updateState(
  mutator: (state: RuntimeState) => RuntimeState | void,
): Promise<RuntimeState> {
  const state = await loadState();
  const next = mutator(state) ?? state;
  await saveState(next);
  return next;
}

export async function recordManaged(
  tabId: number,
  entry: ManagedTab,
): Promise<void> {
  await updateState((s) => {
    s.managed[tabId] = entry;
  });
}

export async function clearTabFromState(tabId: number): Promise<void> {
  await updateState((s) => {
    delete s.managed[tabId];
    s.userOverride = s.userOverride.filter((id) => id !== tabId);
  });
}

export async function addUserOverride(tabId: number): Promise<void> {
  await updateState((s) => {
    delete s.managed[tabId];
    if (!s.userOverride.includes(tabId)) s.userOverride.push(tabId);
  });
}

export async function removeUserOverride(tabId: number): Promise<void> {
  await updateState((s) => {
    s.userOverride = s.userOverride.filter((id) => id !== tabId);
  });
}

export async function pushRecentlyClosed(
  entry: RecentlyClosedEntry,
): Promise<void> {
  await updateState((s) => {
    s.recentlyClosed.unshift(entry);
    if (s.recentlyClosed.length > RECENT_CAP) {
      s.recentlyClosed.length = RECENT_CAP;
    }
  });
}

export async function clearRecentlyClosed(): Promise<void> {
  await updateState((s) => {
    s.recentlyClosed = [];
  });
}

export async function pruneStaleTabIds(
  existingTabIds: Set<number>,
): Promise<void> {
  await updateState((s) => {
    for (const idStr of Object.keys(s.managed)) {
      const id = Number(idStr);
      if (!existingTabIds.has(id)) delete s.managed[id];
    }
    s.userOverride = s.userOverride.filter((id) => existingTabIds.has(id));
  });
}

export { EMPTY_STATE };
