import { defineBackground } from "wxt/sandbox";
import { ensureSweepAlarm, runSweep, SWEEP_ALARM } from "../src/autoclose";
import { handleAutoGroup, reconcileGroupChange } from "../src/autogroup";
import { isRestrictedUrl } from "../src/matcher";
import {
  clearPrStatusAlarm,
  ensurePrStatusAlarm,
  extractPrCoords,
  handlePrTabNavigation,
  PR_STATUS_ALARM,
  runPrStatusSweep,
} from "../src/prstatus";
import { loadSettings } from "../src/settings";
import { clearTabFromState, pruneStaleTabIds } from "../src/state";
import { handleUniqueness } from "../src/uniqueness";

// MV3 service workers are ephemeral: every listener must be registered
// synchronously at the top level so it survives wake/sleep cycles. Anything
// added later (e.g. inside an `async` callback after an `await`) may not be
// re-attached when the worker is re-awakened — that's the most common MV3 bug.

const URL_DEBOUNCE_MS = 250;
const pendingTimers = new Map<number, ReturnType<typeof setTimeout>>();

async function initAlarms(): Promise<void> {
  const settings = await loadSettings();
  await ensureSweepAlarm(settings.autoClose.sweepIntervalMinutes);
  if (settings.prStatus.enabled) {
    await ensurePrStatusAlarm(settings.prStatus.pollMinutes);
  } else {
    await clearPrStatusAlarm();
  }
}

async function kickPrSweepIfEnabled(): Promise<void> {
  const settings = await loadSettings();
  if (settings.prStatus.enabled) await runPrStatusSweep();
}

async function pruneStaleState(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  const ids = new Set<number>();
  for (const t of tabs) if (t.id != null) ids.add(t.id);
  await pruneStaleTabIds(ids);
}

export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(() => {
    void initAlarms();
    void pruneStaleState();
  });

  chrome.runtime.onStartup.addListener(() => {
    void initAlarms();
    void pruneStaleState();
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SWEEP_ALARM) {
      void runSweep();
    } else if (alarm.name === PR_STATUS_ALARM) {
      void runPrStatusSweep();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes.settings) return;
    void initAlarms();
    void kickPrSweepIfEnabled();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "pr-status-sweep") return false;
    runPrStatusSweep()
      .then(() => sendResponse({ ok: true }))
      .catch((e: unknown) =>
        sendResponse({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    return true;
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.groupId !== undefined && changeInfo.groupId !== null) {
      void reconcileGroupChange(tabId, changeInfo.groupId);
    }

    if (!changeInfo.url) return;
    if (isRestrictedUrl(changeInfo.url)) return;

    const existing = pendingTimers.get(tabId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      pendingTimers.delete(tabId);
      void processTabNavigation(tabId, tab);
    }, URL_DEBOUNCE_MS);
    pendingTimers.set(tabId, timer);
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    const t = pendingTimers.get(tabId);
    if (t) {
      clearTimeout(t);
      pendingTimers.delete(tabId);
    }
    void clearTabFromState(tabId);
  });
});

async function processTabNavigation(
  tabId: number,
  cachedTab: chrome.tabs.Tab,
): Promise<void> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }

  if (!tab.url) tab = { ...cachedTab, ...tab };
  if (!tab.url || isRestrictedUrl(tab.url)) return;

  const closedAsDup = await handleUniqueness(tab);
  if (closedAsDup) return;

  // PR-URL tabs are routed to PR-status grouping (a separate alarm keeps
  // existing tabs accurate). If PR-status is disabled or the URL isn't a PR,
  // fall through to the generic auto-group rule.
  if (extractPrCoords(tab.url)) {
    const handled = await handlePrTabNavigation(tab);
    if (handled) return;
  }

  await handleAutoGroup(tab);
}
