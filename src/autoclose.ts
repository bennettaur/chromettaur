import { isRestrictedUrl, matches } from "./matcher";
import { loadSettings } from "./settings";
import { pushRecentlyClosed } from "./state";
import type { AutoCloseSettings } from "./types";

export const SWEEP_ALARM = "sweep";

export async function ensureSweepAlarm(intervalMinutes: number): Promise<void> {
  const periodInMinutes = Math.max(0.5, intervalMinutes);
  const existing = await chrome.alarms.get(SWEEP_ALARM);
  if (existing && existing.periodInMinutes === periodInMinutes) return;
  await chrome.alarms.clear(SWEEP_ALARM);
  chrome.alarms.create(SWEEP_ALARM, { periodInMinutes });
}

function isProtected(
  tab: chrome.tabs.Tab,
  cfg: AutoCloseSettings,
  activeIds: Set<number>,
): boolean {
  if (tab.id == null) return true;
  if (activeIds.has(tab.id)) return true;
  if (cfg.protectPinned && tab.pinned) return true;
  if (cfg.protectAudible && tab.audible) return true;
  if (cfg.protectGrouped && tab.groupId !== undefined && tab.groupId !== -1) {
    return true;
  }
  if (isRestrictedUrl(tab.url)) return true;
  if (tab.url) {
    for (const pattern of cfg.allowlist) {
      if (matches(tab.url, pattern)) return true;
    }
  }
  return false;
}

interface SweepCandidate {
  tab: chrome.tabs.Tab;
  idleMs: number;
}

export async function runSweep(now: number = Date.now()): Promise<number> {
  const settings = await loadSettings();
  const cfg = settings.autoClose;
  if (!cfg.enabled) return 0;

  const windows = await chrome.windows.getAll({ populate: false });
  let closed = 0;

  for (const win of windows) {
    if (win.id == null) continue;
    const tabs = await chrome.tabs.query({ windowId: win.id });
    if (tabs.length <= cfg.minTabsOpen) continue;

    const activeIds = new Set<number>(
      tabs.filter((t) => t.active && t.id != null).map((t) => t.id!),
    );

    const idleThresholdMs = cfg.idleMinutes * 60_000;
    const candidates: SweepCandidate[] = [];
    for (const tab of tabs) {
      if (tab.id == null) continue;
      if (isProtected(tab, cfg, activeIds)) continue;
      const lastAccessed = tab.lastAccessed ?? now;
      const idleMs = now - lastAccessed;
      if (idleMs >= idleThresholdMs) {
        candidates.push({ tab, idleMs });
      }
    }

    candidates.sort((a, b) => b.idleMs - a.idleMs);

    const maxCloseable = tabs.length - cfg.minTabsOpen;
    const toClose = candidates.slice(0, Math.max(0, maxCloseable));

    for (const { tab } of toClose) {
      if (tab.id == null) continue;
      try {
        if (cfg.action === "discard") {
          await chrome.tabs.discard(tab.id);
        } else {
          await pushRecentlyClosed({
            url: tab.url ?? tab.pendingUrl ?? "",
            title: tab.title ?? tab.url ?? "(untitled)",
            closedAt: now,
          });
          await chrome.tabs.remove(tab.id);
        }
        closed += 1;
      } catch {
        // Tab may have been closed already; ignore.
      }
    }
  }

  return closed;
}
