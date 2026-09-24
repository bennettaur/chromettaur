import { loadGithubPat } from "./githubPat";
import type { RepoEntry, RepoVisitTimes } from "./repoSearch";
import { loadSettings } from "./settings";

export const REPO_CACHE_ALARM = "repo-cache";
export const REPO_CACHE_REFRESH_MINUTES = 24 * 60;

const CACHE_KEY = "repoCache";
const VISITED_KEY = "visitedRepos";
const VISITED_CAP = 500;
const STALE_AFTER_MS = REPO_CACHE_REFRESH_MINUTES * 60_000;
// 100 repos per page, so this stops at 5,000 repos per owner. Guards against
// paging forever if GitHub keeps returning a `next` link.
const MAX_PAGES = 50;

const REPO_URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)/;

interface OwnerCache {
  repos: RepoEntry[];
  fetchedAt: number;
}

/** API results keyed by lowercased owner. */
type RepoCache = Record<string, OwnerCache>;

/** Repos seen in the address bar, keyed by lowercased `owner/name`. */
type VisitedRepos = Record<string, { fullName: string; lastVisited: number }>;

interface GithubRepoResponse {
  full_name: string;
  description: string | null;
  archived: boolean;
}

export class GithubRequestError extends Error {
  constructor(
    readonly status: number,
    url: string,
  ) {
    super(`GitHub returned ${status} for ${url}`);
  }
}

export interface RefreshResult {
  refreshed: string[];
  failed: string[];
}

function ownerKey(owner: string): string {
  return owner.trim().toLowerCase();
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

function githubHeaders(pat: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (pat) headers.Authorization = `Bearer ${pat}`;
  return headers;
}

async function fetchAllRepoPages(
  firstUrl: string,
  pat: string | undefined,
): Promise<RepoEntry[]> {
  const repos: RepoEntry[] = [];
  let url: string | null = firstUrl;
  for (let page = 0; url && page < MAX_PAGES; page += 1) {
    const res = await fetch(url, { headers: githubHeaders(pat) });
    if (!res.ok) throw new GithubRequestError(res.status, url);
    const body = (await res.json()) as GithubRepoResponse[];
    for (const repo of body) {
      // Archived repos clutter large orgs. Visiting one still adds it.
      if (repo.archived) continue;
      repos.push({
        fullName: repo.full_name,
        description: repo.description ?? undefined,
      });
    }
    url = parseNextLink(res.headers.get("link"));
  }
  return repos;
}

async function fetchViewerLogin(pat: string): Promise<string | null> {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: githubHeaders(pat),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { login?: string };
    return body.login ?? null;
  } catch {
    return null;
  }
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
  const api = "https://api.github.com";
  const name = encodeURIComponent(owner.trim());

  if (viewerLogin && ownerKey(viewerLogin) === ownerKey(owner)) {
    return fetchAllRepoPages(
      `${api}/user/repos?affiliation=owner&per_page=100`,
      pat,
    );
  }
  try {
    return await fetchAllRepoPages(
      `${api}/orgs/${name}/repos?type=all&per_page=100`,
      pat,
    );
  } catch (err) {
    if (!(err instanceof GithubRequestError) || err.status !== 404) throw err;
    return fetchAllRepoPages(
      `${api}/users/${name}/repos?type=owner&per_page=100`,
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

/**
 * Fetch repo lists for every configured owner. Without `force`, only owners
 * that are missing from the cache or older than a day are fetched. A failed
 * owner keeps its previous list.
 */
export async function refreshRepoCache(force: boolean): Promise<RefreshResult> {
  const { owners } = (await loadSettings()).repoSwitcher;
  const cache = await loadRepoCache();
  const now = Date.now();
  const result: RefreshResult = { refreshed: [], failed: [] };

  const wanted = new Set(owners.map(ownerKey));
  const toFetch = owners.filter((owner) => {
    const entry = cache[ownerKey(owner)];
    return force || !entry || now - entry.fetchedAt > STALE_AFTER_MS;
  });
  const staleOwners = Object.keys(cache).filter((key) => !wanted.has(key));
  if (toFetch.length === 0 && staleOwners.length === 0) return result;

  const pat = await loadGithubPat();
  const viewerLogin = pat ? await fetchViewerLogin(pat) : null;

  for (const owner of toFetch) {
    try {
      const repos = await fetchOwnerRepos(owner, pat, viewerLogin);
      cache[ownerKey(owner)] = { repos, fetchedAt: now };
      result.refreshed.push(owner);
    } catch {
      result.failed.push(owner);
    }
  }
  for (const key of staleOwners) delete cache[key];

  await chrome.storage.local.set({ [CACHE_KEY]: cache });
  return result;
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
