import type { WantedPr } from "./myPrs";

export interface OpenPrTab {
  tabId: number;
  key: string;
  url: string;
  title: string;
}

export type AutoOpened = Record<string, { openedAt: number; url: string }>;

export interface AutoOpenPlan {
  toOpen: WantedPr[];
  /** Auto-opened PRs that left the wanted set; merged/closed ones get closed. */
  toCheck: string[];
  autoOpened: AutoOpened;
  dismissed: string[];
}

export function planAutoOpen(input: {
  wanted: WantedPr[];
  openTabs: OpenPrTab[];
  autoOpened: AutoOpened;
  dismissed: string[];
  maxPerPoll: number;
}): AutoOpenPlan {
  const wantedKeys = new Set(input.wanted.map((w) => w.key));
  const openKeys = new Set(input.openTabs.map((t) => t.key));
  const dismissed = input.dismissed.filter((key) => wantedKeys.has(key));
  const autoOpened: AutoOpened = {};
  for (const [key, entry] of Object.entries(input.autoOpened)) {
    if (openKeys.has(key)) autoOpened[key] = entry;
  }
  const toOpen = input.wanted
    .filter((w) => !openKeys.has(w.key) && !dismissed.includes(w.key))
    .slice(0, input.maxPerPoll);
  const toCheck = Object.keys(autoOpened).filter((key) => !wantedKeys.has(key));
  return { toOpen, toCheck, autoOpened, dismissed };
}
