import { clearInFlight, markInFlight } from "./autogroup";
import { ensureGroupForTab, extensionGroupTitles } from "./groups";
import { GITHUB_API, githubGet, loadViewerLogin } from "./github";
import { loadGithubPat } from "./githubPat";
import { loadSettings } from "./settings";
import { addUserOverride, loadState, recordManaged } from "./state";
import type { PrStatus, PrStatusSettings } from "./types";

export const PR_STATUS_ALARM = "pr-status";
export const PR_STATUS_SWEEP_MESSAGE = "pr-status-sweep";
const PR_RULE_ID_PREFIX = "pr-status:";

export interface PrSweepResponse {
  ok: boolean;
  error?: string;
}

const PR_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

export interface PrCoords {
  owner: string;
  repo: string;
  number: string;
}

export function extractPrCoords(url: string): PrCoords | null {
  const m = PR_URL_RE.exec(url);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: m[3] };
}

export async function ensurePrStatusAlarm(
  intervalMinutes: number,
): Promise<void> {
  const periodInMinutes = Math.max(0.5, intervalMinutes);
  const existing = await chrome.alarms.get(PR_STATUS_ALARM);
  if (existing && existing.periodInMinutes === periodInMinutes) return;
  await chrome.alarms.clear(PR_STATUS_ALARM);
  chrome.alarms.create(PR_STATUS_ALARM, { periodInMinutes });
}

export async function clearPrStatusAlarm(): Promise<void> {
  await chrome.alarms.clear(PR_STATUS_ALARM);
}

export interface PrApiResponse {
  draft?: boolean;
  merged?: boolean;
  state?: "open" | "closed";
  mergeable_state?: string;
  user?: { login: string } | null;
  requested_reviewers?: { login: string }[];
}

interface ReviewApiResponse {
  user: { login: string } | null;
}

/**
 * Map a GitHub PR API response to one of our status buckets.
 *
 * `mergeable_state` values observed from GitHub:
 *  - `clean` — passing checks, no reviewer blocks → ready
 *  - `unstable` — non-required check failing → blocked (visually noisy enough
 *    to deserve a flag)
 *  - `blocked` — required reviewer or required check blocking → blocked
 *  - `dirty` — merge conflict → blocked
 *  - `behind` — branch is behind base → blocked
 *  - `has_hooks` — passing, pre-receive hooks present → ready
 *  - `draft` — draft PR → handled by `draft: true` first
 *  - `unknown` — github still computing → unknown
 */
export function mapPrStatus(body: PrApiResponse): PrStatus {
  if (body.merged) return "merged";
  if (body.state === "closed") return "closed";
  if (body.draft) return "draft";

  switch (body.mergeable_state) {
    case "clean":
    case "has_hooks":
      return "ready";
    case "blocked":
    case "dirty":
    case "behind":
    case "unstable":
      return "blocked";
    case "unknown":
    case undefined:
      return "unknown";
    default:
      return "unknown";
  }
}

export function prKey(c: PrCoords): string {
  return `${c.owner.toLowerCase()}/${c.repo.toLowerCase()}#${c.number}`;
}

function sameLogin(a: string | undefined, b: string): boolean {
  return a !== undefined && a.toLowerCase() === b.toLowerCase();
}

/** Requested (as a user, not a team) or already reviewed, and not the author. */
export function isReviewer(
  pr: PrApiResponse,
  reviewLogins: string[],
  viewer: string | null,
): boolean {
  if (!viewer || sameLogin(pr.user?.login, viewer)) return false;
  return (
    (pr.requested_reviewers ?? []).some((u) => sameLogin(u.login, viewer)) ||
    reviewLogins.some((login) => sameLogin(login, viewer))
  );
}

export function resolvePrGroup(
  pr: PrApiResponse,
  reviewLogins: string[],
  viewer: string | null,
): PrStatus {
  const status = mapPrStatus(pr);
  if (status === "merged" || status === "closed") return status;
  return isReviewer(pr, reviewLogins, viewer) ? "reviewer" : status;
}

export async function fetchPrStatus(
  c: PrCoords,
  pat: string | undefined,
  viewer: string | null = null,
): Promise<PrStatus> {
  const prUrl = `${GITHUB_API}/repos/${c.owner}/${c.repo}/pulls/${c.number}`;
  try {
    const pr = (await (await githubGet(prUrl, pat)).json()) as PrApiResponse;
    const status = resolvePrGroup(pr, [], viewer);
    // The reviews call can only change a non-final, non-reviewer answer.
    if (
      status === "reviewer" ||
      status === "merged" ||
      status === "closed" ||
      !viewer ||
      sameLogin(pr.user?.login, viewer)
    ) {
      return status;
    }
    const res = await githubGet(`${prUrl}/reviews?per_page=100`, pat);
    const logins = ((await res.json()) as ReviewApiResponse[]).flatMap((r) =>
      r.user ? [r.user.login] : [],
    );
    return resolvePrGroup(pr, logins, viewer);
  } catch {
    return "unknown";
  }
}

interface ApplyContext {
  cfg: PrStatusSettings;
  respectUserOverride: boolean;
  ownedTitles: Set<string>;
}

async function applyPrStatusToTab(
  tab: chrome.tabs.Tab,
  ctx: ApplyContext,
  getStatus: () => Promise<PrStatus>,
): Promise<void> {
  if (tab.id == null || !tab.url) return;
  const coords = extractPrCoords(tab.url);
  if (!coords) return;

  const state = await loadState();

  if (ctx.respectUserOverride && state.userOverride.includes(tab.id)) {
    return;
  }

  const managed = state.managed[tab.id];

  if (
    tab.groupId !== undefined &&
    tab.groupId !== -1 &&
    managed != null &&
    tab.groupId !== managed.assignedGroupId
  ) {
    if (ctx.respectUserOverride) {
      await addUserOverride(tab.id);
    }
    return;
  }

  // A group the extension never assigned was chosen by the user, so leave it.
  // Tabs another extension rule grouped (e.g. generic auto-group) fall through
  // so PR status wins over it. Titles count too: `managed` is keyed by tab ID,
  // and Chrome renumbers tabs on restart.
  if (tab.groupId !== undefined && tab.groupId !== -1 && managed == null) {
    const group = await chrome.tabGroups.get(tab.groupId).catch(() => null);
    if (!group?.title || !ctx.ownedTitles.has(group.title)) return;
  }

  const status = await getStatus();
  if (status === "unknown") return;

  const name = ctx.cfg.groupTitles[status];
  const color = ctx.cfg.groupColors[status];

  markInFlight(tab.id);
  try {
    const groupId = await ensureGroupForTab(tab.id, tab.windowId, name, color);
    await recordManaged(tab.id, {
      groupRuleId: `${PR_RULE_ID_PREFIX}${status}`,
      assignedGroupId: groupId,
    });
  } catch {
    // tab may have closed or moved; ignore.
  } finally {
    clearInFlight(tab.id);
  }
}

let inFlightSweep: Promise<boolean> | null = null;

/**
 * Sweep every tab whose URL matches a GitHub PR, fetch its status, and place
 * it into the matching PR-status group. Dedupes per `owner/repo/number` so we
 * only hit the API once per unique PR even if several tabs (sub-views) point
 * at it. Resolves to false when PR status grouping is disabled.
 *
 * Calls made while a sweep is running share it. Two sweeps moving the same
 * tab at once can create duplicate groups and record false user overrides.
 */
export function runPrStatusSweep(): Promise<boolean> {
  inFlightSweep ??= sweepPrTabs().finally(() => {
    inFlightSweep = null;
  });
  return inFlightSweep;
}

async function sweepPrTabs(): Promise<boolean> {
  const settings = await loadSettings();
  const cfg = settings.prStatus;
  if (!cfg.enabled) return false;

  const pat = await loadGithubPat();
  let viewer: string | null;
  try {
    viewer = await loadViewerLogin(pat);
  } catch {
    // Without the login, reviewer tabs would be moved to their status groups.
    return true;
  }
  const ctx: ApplyContext = {
    cfg,
    respectUserOverride: settings.autoGroup.respectUserOverride,
    ownedTitles: extensionGroupTitles(settings),
  };

  const tabs = await chrome.tabs.query({
    url: "https://github.com/*/*/pull/*",
  });

  const byKey = new Map<string, chrome.tabs.Tab[]>();
  for (const tab of tabs) {
    if (!tab.url || tab.id == null) continue;
    const c = extractPrCoords(tab.url);
    if (!c) continue;
    const key = `${c.owner}/${c.repo}/${c.number}`;
    const arr = byKey.get(key) ?? [];
    arr.push(tab);
    byKey.set(key, arr);
  }

  for (const [, group] of byKey) {
    const first = group[0];
    if (!first?.url) continue;
    const coords = extractPrCoords(first.url)!;
    const status = await fetchPrStatus(coords, pat, viewer);
    if (status === "unknown") continue;

    for (const tab of group) {
      await applyPrStatusToTab(tab, ctx, async () => status);
    }
  }
  return true;
}

/**
 * Handle a single PR-URL tab on navigation (no full sweep). Returns true if
 * the tab matched a PR URL and PR-status was active (caller should skip the
 * generic auto-group rule for this tab).
 */
export async function handlePrTabNavigation(
  tab: chrome.tabs.Tab,
): Promise<boolean> {
  if (tab.id == null || !tab.url) return false;
  const coords = extractPrCoords(tab.url);
  if (!coords) return false;

  const settings = await loadSettings();
  if (!settings.prStatus.enabled) return false;

  const pat = await loadGithubPat();
  let viewer: string | null;
  try {
    viewer = await loadViewerLogin(pat);
  } catch {
    return true;
  }
  await applyPrStatusToTab(
    tab,
    {
      cfg: settings.prStatus,
      respectUserOverride: settings.autoGroup.respectUserOverride,
      ownedTitles: extensionGroupTitles(settings),
    },
    () => fetchPrStatus(coords, pat, viewer),
  );
  return true;
}
