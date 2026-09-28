import { planAutoOpen, type AutoOpened, type OpenPrTab } from "./autoOpenPlan";
import { describeFailure } from "./github";
import { loadGithubPat } from "./githubPat";
import { fetchWantedPrs, type WantedPr } from "./myPrs";
import { extractPrCoords, fetchPrStatus, prKey } from "./prstatus";
import { loadSettings } from "./settings";
import { pushRecentlyClosed } from "./state";

const STATE_KEY = "autoOpenState";
// Session storage: tab IDs and this map both reset when Chrome restarts.
const TAB_MAP_KEY = "autoOpenTabs";

export interface AutoOpenState {
  autoOpened: AutoOpened;
  dismissed: string[];
  lastError: { message: string; at: number } | null;
}

/** Tab ID (as a string key) → PR key, for tabs this extension opened. */
type TabMap = Record<string, string>;

export async function loadAutoOpenState(): Promise<AutoOpenState> {
  const r = await chrome.storage.local.get(STATE_KEY);
  const s = r[STATE_KEY] as Partial<AutoOpenState> | undefined;
  return {
    autoOpened: s?.autoOpened ?? {},
    dismissed: s?.dismissed ?? [],
    lastError: s?.lastError ?? null,
  };
}

async function saveAutoOpenState(state: AutoOpenState): Promise<void> {
  await chrome.storage.local.set({ [STATE_KEY]: state });
}

async function loadTabMap(): Promise<TabMap> {
  const r = await chrome.storage.session.get(TAB_MAP_KEY);
  return (r[TAB_MAP_KEY] as TabMap | undefined) ?? {};
}

async function saveTabMap(map: TabMap): Promise<void> {
  await chrome.storage.session.set({ [TAB_MAP_KEY]: map });
}

// Polls and tab events all read-modify-write the same state. Running them in
// order also means a tab a poll closed is gone from the tab map by the time
// its removal event is handled, so it isn't taken for a dismissal.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

// Sign-in and SSO pages GitHub sends a tab to when the browser session lapses.
const GITHUB_AUTH_URL_RE =
  /^https:\/\/github\.com\/(?:login|session|sessions\/[^?#]+|(?:orgs|enterprises)\/[^/?#]+\/sso)(?:[/?#]|$)/;

function isGithubAuthUrl(url: string): boolean {
  return GITHUB_AUTH_URL_RE.test(url);
}

/** Tracked tabs parked on a GitHub sign-in page still hold their PR. */
async function listTrackedAuthTabs(map: TabMap): Promise<OpenPrTab[]> {
  const tabs = await chrome.tabs.query({ url: "https://github.com/*" });
  return tabs.flatMap((t) => {
    const key = t.id == null ? undefined : map[String(t.id)];
    if (t.id == null || !key || !t.url || !isGithubAuthUrl(t.url)) return [];
    return [{ tabId: t.id, key, url: t.url, title: t.title ?? t.url }];
  });
}

async function listOpenPrTabs(): Promise<OpenPrTab[]> {
  const tabs = await chrome.tabs.query({
    url: "https://github.com/*/*/pull/*",
  });
  return tabs.flatMap((t) => {
    const coords = t.url ? extractPrCoords(t.url) : null;
    if (t.id == null || !t.url || !coords) return [];
    return [
      { tabId: t.id, key: prKey(coords), url: t.url, title: t.title ?? t.url },
    ];
  });
}

export function runAutoOpen(now: number = Date.now()): Promise<void> {
  return serialized(() => runAutoOpenNow(now));
}

async function runAutoOpenNow(now: number): Promise<void> {
  const settings = await loadSettings();
  if (!settings.autoOpen.enabled) return;
  const state = await loadAutoOpenState();
  const pat = await loadGithubPat();
  if (!settings.prStatus.enabled || !pat) {
    const message = "Needs PR status grouping on and a GitHub token.";
    await saveAutoOpenState({ ...state, lastError: { message, at: now } });
    return;
  }

  let wanted: WantedPr[];
  try {
    wanted = await fetchWantedPrs(pat);
  } catch (err) {
    // A partial answer could close tabs for PRs that are still wanted.
    await saveAutoOpenState({
      ...state,
      lastError: { message: describeFailure(err), at: now },
    });
    return;
  }

  const tabMap = await loadTabMap();
  const openTabs = [
    ...(await listOpenPrTabs()),
    ...(await listTrackedAuthTabs(tabMap)),
  ];
  for (const [id, key] of Object.entries(tabMap)) {
    if (!openTabs.some((t) => t.tabId === Number(id) && t.key === key)) {
      delete tabMap[id];
    }
  }

  const plan = planAutoOpen({
    wanted,
    openTabs,
    autoOpened: state.autoOpened,
    dismissed: state.dismissed,
    maxPerPoll: settings.autoOpen.maxPerPoll,
  });
  const autoOpened = plan.autoOpened;
  relinkUnmappedTabs(tabMap, openTabs, autoOpened);

  for (const key of plan.toCheck) {
    const coords = extractPrCoords(autoOpened[key].url);
    if (!coords) continue;
    const status = await fetchPrStatus(coords, pat);
    if (status !== "merged" && status !== "closed") continue;
    for (const [id, mapped] of Object.entries(tabMap)) {
      if (mapped !== key) continue;
      const tab = openTabs.find((t) => t.tabId === Number(id));
      if (!tab) continue;
      try {
        await chrome.tabs.remove(tab.tabId);
      } catch {
        continue;
      }
      delete tabMap[id];
      await pushRecentlyClosed({
        url: tab.url,
        title: tab.title,
        closedAt: now,
      });
    }
    delete autoOpened[key];
  }

  if (plan.toOpen.length > 0) {
    const win = await chrome.windows
      .getLastFocused({ windowTypes: ["normal"] })
      .catch(() => null);
    if (win?.id != null) {
      for (const pr of plan.toOpen) {
        try {
          const tab = await chrome.tabs.create({
            url: pr.url,
            windowId: win.id,
            active: false,
          });
          if (tab.id == null) continue;
          // PR status leaves tabs in groups it doesn't own, so start ungrouped.
          if (tab.groupId !== undefined && tab.groupId !== -1) {
            await chrome.tabs.ungroup(tab.id);
          }
          autoOpened[pr.key] = { openedAt: now, url: pr.url };
          tabMap[String(tab.id)] = pr.key;
        } catch {
          // window closed mid-run
        }
      }
    }
  }

  await saveTabMap(tabMap);
  await saveAutoOpenState({
    autoOpened,
    dismissed: plan.dismissed,
    lastError: null,
  });
}

/**
 * Link open tabs to auto-opened PRs that have no tab in the map. Tabs get new
 * IDs when Chrome restores them (restart, reopened window), so this runs on
 * every poll as well as at startup.
 */
function relinkUnmappedTabs(
  map: TabMap,
  openTabs: OpenPrTab[],
  autoOpened: AutoOpened,
): void {
  const mappedKeys = new Set(Object.values(map));
  for (const t of openTabs) {
    if (autoOpened[t.key] && !mappedKeys.has(t.key)) {
      map[String(t.tabId)] = t.key;
    }
  }
}

/** Re-link restored tabs to the PRs this extension opened. */
export function rebuildAutoOpenTabMap(): Promise<void> {
  return serialized(async () => {
    const { autoOpened } = await loadAutoOpenState();
    const map: TabMap = {};
    relinkUnmappedTabs(map, await listOpenPrTabs(), autoOpened);
    await saveTabMap(map);
  });
}

async function untrack(tabId: number, dismiss: boolean): Promise<void> {
  const map = await loadTabMap();
  const key = map[String(tabId)];
  if (!key) return;
  delete map[String(tabId)];
  await saveTabMap(map);
  if (!dismiss || Object.values(map).includes(key)) return;
  const state = await loadAutoOpenState();
  delete state.autoOpened[key];
  if (!state.dismissed.includes(key)) state.dismissed.push(key);
  await saveAutoOpenState(state);
}

export function handleTrackedTabRemoved(
  tabId: number,
  isWindowClosing: boolean,
): Promise<void> {
  return serialized(async () => {
    // Chrome may report quitting as window closes, and restored tabs must
    // stay tracked. The next poll forgets PRs whose tabs are really gone.
    await untrack(tabId, !isWindowClosing);
  });
}

export function handleTrackedTabNavigated(
  tabId: number,
  url: string,
): Promise<void> {
  return serialized(async () => {
    const key = (await loadTabMap())[String(tabId)];
    if (!key || isGithubAuthUrl(url)) return;
    const coords = extractPrCoords(url);
    if (coords && prKey(coords) === key) return;
    await untrack(tabId, true);
  });
}
