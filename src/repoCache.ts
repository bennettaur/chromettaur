import { loadGithubPat } from "./githubPat";
import type { RepoEntry, RepoVisitTimes } from "./repoSearch";
import { loadSettings } from "./settings";

export const REPO_CACHE_ALARM = "repo-cache";
const REPO_CACHE_REFRESH_MINUTES = 24 * 60;

const GITHUB_API = "https://api.github.com";
const CACHE_KEY = "repoCache";
const VISITED_KEY = "visitedRepos";
const VISITED_CAP = 500;
const STALE_AFTER_MS = REPO_CACHE_REFRESH_MINUTES * 60_000;
const FETCH_TIMEOUT_MS = 15_000;
// 100 repos per page, so this stops at 5,000 repos per owner. Guards against
// paging forever if GitHub keeps returning a `next` link.
const MAX_PAGES = 50;

const REPO_URL_RE =
  /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)/;
// GitHub user/org names: up to 39 alphanumerics or single hyphens, not
// starting or ending with a hyphen.
const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

interface OwnerCache {
  repos: RepoEntry[];
  fetchedAt: number;
}

/** API results keyed by lowercased owner. */
type RepoCache = Record<string, OwnerCache>;

/** Repo pages opened in any tab, keyed by lowercased `owner/name`. */
type VisitedRepos = Record<string, { fullName: string; lastVisited: number }>;

interface GithubRepoResponse {
  full_name: string;
  description: string | null;
  archived: boolean;
}

export class GithubRequestError extends Error {
  override name = "GithubRequestError";

  constructor(
    readonly status: number,
    readonly rateLimited: boolean,
    url: string,
  ) {
    super(`GitHub returned ${status} for ${url}`);
  }

  static fromResponse(res: Response, url: string): GithubRequestError {
    const rateLimited =
      res.status === 429 ||
      (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0");
    return new GithubRequestError(res.status, rateLimited, url);
  }
}

export interface RefreshFailure {
  owner: string;
  reason: string;
}

export interface RefreshResult {
  failed: RefreshFailure[];
}

function ownerKey(owner: string): string {
  return owner.trim().toLowerCase();
}

export function isValidGithubOwner(owner: string): boolean {
  return GITHUB_OWNER_RE.test(owner.trim());
}

export function extractRepoFullName(url: string): string | null {
  const m = REPO_URL_RE.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Returns the URL tagged `rel="next"` in a GitHub `Link` header. */
export function parseNextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m) return m[1];
  }
  return null;
}

function describeFailure(err: unknown): string {
  if (err instanceof GithubRequestError) {
    if (err.rateLimited) return "rate limited by GitHub";
    if (err.status === 401) return "GitHub token rejected (401)";
    if (err.status === 404) return "not found on GitHub (404)";
    return `GitHub returned ${err.status}`;
  }
  if (err instanceof DOMException && err.name === "TimeoutError") {
    return "timed out";
  }
  return "network error";
}

async function githubGet(
  url: string,
  pat: string | undefined,
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (pat) headers.Authorization = `Bearer ${pat}`;
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw GithubRequestError.fromResponse(res, url);
  return res;
}

async function fetchAllRepoPages(
  firstUrl: string,
  pat: string | undefined,
): Promise<RepoEntry[]> {
  const repos: RepoEntry[] = [];
  let url: string | null = firstUrl;
  for (let page = 0; url && page < MAX_PAGES; page += 1) {
    const res = await githubGet(url, pat);
    const body = (await res.json()) as GithubRepoResponse[];
    for (const repo of body) {
      // Archived repos clutter large orgs. Visiting one still adds it.
      if (repo.archived) continue;
      repos.push({
        fullName: repo.full_name,
        description: repo.description ?? undefined,
      });
    }
    const next = parseNextLink(res.headers.get("link"));
    // Every request carries the PAT, so only follow links back to the API.
    url = next && new URL(next).origin === GITHUB_API ? next : null;
  }
  return repos;
}

async function fetchViewerLogin(pat: string): Promise<string> {
  const res = await githubGet(`${GITHUB_API}/user`, pat);
  return ((await res.json()) as { login: string }).login;
}

/**
 * List an owner's repos. `/users/{owner}/repos` only shows public repos, so
 * when the owner is the PAT's own account this uses `/user/repos` instead.
 */
export async function fetchOwnerRepos(
  owner: string,
  pat: string | undefined,
  viewerLogin: string | null,
): Promise<RepoEntry[]> {
  const encodedOwner = encodeURIComponent(owner.trim());

  if (viewerLogin && ownerKey(viewerLogin) === ownerKey(owner)) {
    return fetchAllRepoPages(
      `${GITHUB_API}/user/repos?affiliation=owner&per_page=100`,
      pat,
    );
  }
  try {
    return await fetchAllRepoPages(
      `${GITHUB_API}/orgs/${encodedOwner}/repos?type=all&per_page=100`,
      pat,
    );
  } catch (err) {
    if (!(err instanceof GithubRequestError) || err.status !== 404) throw err;
    return fetchAllRepoPages(
      `${GITHUB_API}/users/${encodedOwner}/repos?type=owner&per_page=100`,
      pat,
    );
  }
}

async function loadRepoCache(): Promise<RepoCache> {
  const r = await chrome.storage.local.get(CACHE_KEY);
  return (r[CACHE_KEY] as RepoCache | undefined) ?? {};
}

async function loadVisitedRepos(): Promise<VisitedRepos> {
  const r = await chrome.storage.local.get(VISITED_KEY);
  return (r[VISITED_KEY] as VisitedRepos | undefined) ?? {};
}

// Refreshes can run in the background, options page and palette at once, so
// each write re-reads the cache and changes only its own owner.
async function saveOwnerRepos(owner: string, entry: OwnerCache): Promise<void> {
  const cache = await loadRepoCache();
  cache[ownerKey(owner)] = entry;
  await chrome.storage.local.set({ [CACHE_KEY]: cache });
}

async function dropRemovedOwners(): Promise<void> {
  const { owners } = (await loadSettings()).repoSwitcher;
  const allowed = new Set(owners.map(ownerKey));
  const cache = await loadRepoCache();
  const removed = Object.keys(cache).filter((key) => !allowed.has(key));
  if (removed.length === 0) return;
  for (const key of removed) delete cache[key];
  await chrome.storage.local.set({ [CACHE_KEY]: cache });
}

export async function ensureRepoCacheAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(REPO_CACHE_ALARM);
  if (existing?.periodInMinutes === REPO_CACHE_REFRESH_MINUTES) return;
  await chrome.alarms.clear(REPO_CACHE_ALARM);
  chrome.alarms.create(REPO_CACHE_ALARM, {
    periodInMinutes: REPO_CACHE_REFRESH_MINUTES,
  });
}

async function fetchAndSaveOwners(
  owners: string[],
  now: number,
): Promise<RefreshResult> {
  const failAll = (list: string[], reason: string): RefreshFailure[] =>
    list.map((owner) => ({ owner, reason }));

  const pat = await loadGithubPat();
  let viewerLogin: string | null = null;
  if (pat) {
    try {
      viewerLogin = await fetchViewerLogin(pat);
    } catch (err) {
      // Without the login, the token owner's repos would come from the
      // public-only endpoint and replace their cached private repos.
      return { failed: failAll(owners, describeFailure(err)) };
    }
  }

  const failed: RefreshFailure[] = [];
  for (const [idx, owner] of owners.entries()) {
    try {
      const repos = await fetchOwnerRepos(owner, pat, viewerLogin);
      await saveOwnerRepos(owner, { repos, fetchedAt: now });
    } catch (err) {
      const reason = describeFailure(err);
      if (err instanceof GithubRequestError && err.rateLimited) {
        failed.push(...failAll(owners.slice(idx), reason));
        break;
      }
      failed.push({ owner, reason });
    }
  }
  return { failed };
}

let inFlightRefresh: Promise<RefreshResult> | null = null;

/**
 * Fetch repo lists for configured owners and drop owners no longer
 * configured. Without `force`, only owners missing from the cache or older
 * than `REPO_CACHE_REFRESH_MINUTES` are fetched. A failed owner keeps its
 * previous list. Calls made while a refresh is running share its result.
 */
export function refreshRepoCache({
  force = false,
} = {}): Promise<RefreshResult> {
  inFlightRefresh ??= (async () => {
    const { owners } = (await loadSettings()).repoSwitcher;
    const cache = await loadRepoCache();
    const now = Date.now();
    const toFetch = owners.filter((owner) => {
      const entry = cache[ownerKey(owner)];
      return force || !entry || now - entry.fetchedAt > STALE_AFTER_MS;
    });

    const result =
      toFetch.length > 0
        ? await fetchAndSaveOwners(toFetch, now)
        : { failed: [] };
    await dropRemovedOwners();
    return result;
  })().finally(() => {
    inFlightRefresh = null;
  });
  return inFlightRefresh;
}

/** Remember a visit to a repo page if its owner is on the switcher allowlist. */
export async function recordRepoVisit(url: string): Promise<void> {
  const fullName = extractRepoFullName(url);
  if (!fullName) return;

  const { owners } = (await loadSettings()).repoSwitcher;
  const owner = ownerKey(fullName.split("/")[0]);
  if (!owners.some((o) => ownerKey(o) === owner)) return;

  const visited = await loadVisitedRepos();
  visited[fullName.toLowerCase()] = { fullName, lastVisited: Date.now() };

  const keys = Object.keys(visited);
  if (keys.length > VISITED_CAP) {
    keys
      .sort((a, b) => visited[a].lastVisited - visited[b].lastVisited)
      .slice(0, keys.length - VISITED_CAP)
      .forEach((key) => delete visited[key]);
  }
  await chrome.storage.local.set({ [VISITED_KEY]: visited });
}

export interface RepoCandidates {
  repos: RepoEntry[];
  visitTimes: RepoVisitTimes;
}

/** Everything the switcher can offer: API results plus visited repos. */
export async function loadRepoCandidates(): Promise<RepoCandidates> {
  const [settings, cache, visited] = await Promise.all([
    loadSettings(),
    loadRepoCache(),
    loadVisitedRepos(),
  ]);
  const owners = new Set(settings.repoSwitcher.owners.map(ownerKey));
  const byName = new Map<string, RepoEntry>();

  for (const [owner, entry] of Object.entries(cache)) {
    if (!owners.has(owner)) continue;
    for (const repo of entry.repos) {
      byName.set(repo.fullName.toLowerCase(), repo);
    }
  }

  const visitTimes: RepoVisitTimes = {};
  for (const [key, entry] of Object.entries(visited)) {
    if (!owners.has(key.split("/")[0])) continue;
    visitTimes[key] = entry.lastVisited;
    if (!byName.has(key)) byName.set(key, { fullName: entry.fullName });
  }

  return { repos: [...byName.values()], visitTimes };
}

export interface RepoCacheSummary {
  repoCount: number;
  /** Fetch time of the least recently refreshed owner. */
  oldestFetchAt: number | null;
}

export async function summarizeRepoCache(): Promise<RepoCacheSummary> {
  const cache = await loadRepoCache();
  const entries = Object.values(cache);
  return {
    repoCount: entries.reduce((n, e) => n + e.repos.length, 0),
    oldestFetchAt: entries.length
      ? Math.min(...entries.map((e) => e.fetchedAt))
      : null,
  };
}
