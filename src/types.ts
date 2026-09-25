export type KeyStrategy =
  | "exact"
  | "ignoreFragment"
  | "ignoreQuery"
  | "regexCapture";

export const KEY_STRATEGIES: KeyStrategy[] = [
  "exact",
  "ignoreFragment",
  "ignoreQuery",
  "regexCapture",
];

export interface UniquenessRule {
  id: string;
  name: string;
  matchPattern: string;
  keyStrategy: KeyStrategy;
  keyRegex?: string;
}

export type GroupColor =
  | "grey"
  | "blue"
  | "red"
  | "yellow"
  | "green"
  | "pink"
  | "purple"
  | "cyan"
  | "orange";

export const GROUP_COLORS: GroupColor[] = [
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
];

export interface AutoGroupRule {
  id: string;
  name: string;
  color: GroupColor;
  matchPattern: string;
}

export type CloseAction = "close" | "discard";

export interface AutoCloseSettings {
  enabled: boolean;
  idleMinutes: number;
  sweepIntervalMinutes: number;
  minTabsOpen: number;
  action: CloseAction;
  protectPinned: boolean;
  protectAudible: boolean;
  protectGrouped: boolean;
  allowlist: string[];
}

export interface UniquenessSettings {
  enabled: boolean;
  rules: UniquenessRule[];
}

export interface AutoGroupSettings {
  enabled: boolean;
  rules: AutoGroupRule[];
  respectUserOverride: boolean;
}

export type PrStatus =
  | "draft"
  | "ready"
  | "blocked"
  | "merged"
  | "closed"
  | "unknown";

export const PR_STATUSES: Exclude<PrStatus, "unknown">[] = [
  "draft",
  "ready",
  "blocked",
  "merged",
  "closed",
];

export interface PrStatusSettings {
  enabled: boolean;
  pollMinutes: number;
  groupColors: Record<Exclude<PrStatus, "unknown">, GroupColor>;
  groupTitles: Record<Exclude<PrStatus, "unknown">, string>;
}

export interface RepoSwitcherSettings {
  /** GitHub orgs/users whose repos the repo switcher lists. */
  owners: string[];
}

export interface Settings {
  autoClose: AutoCloseSettings;
  uniqueness: UniquenessSettings;
  autoGroup: AutoGroupSettings;
  prStatus: PrStatusSettings;
  repoSwitcher: RepoSwitcherSettings;
}

export interface RecentlyClosedEntry {
  url: string;
  title: string;
  closedAt: number;
}

export interface ManagedTab {
  groupRuleId: string;
  assignedGroupId: number;
}

export interface RuntimeState {
  managed: Record<number, ManagedTab>;
  userOverride: number[];
  recentlyClosed: RecentlyClosedEntry[];
}
