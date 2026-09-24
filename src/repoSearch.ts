export interface RepoEntry {
  /** `owner/name`, in GitHub's casing. */
  fullName: string;
  description?: string;
}

/** Last visit time (ms since epoch) keyed by lowercased `owner/name`. */
export type RepoVisitTimes = Record<string, number>;

// Lower tier wins. A query matches a repo in the first tier that applies.
enum MatchTier {
  ExactName,
  NamePrefix,
  NameWordPrefix,
  NameSubstring,
  FullNameSubstring,
  NameFuzzy,
}

function repoName(fullName: string): string {
  const slash = fullName.indexOf("/");
  return slash === -1 ? fullName : fullName.slice(slash + 1);
}

function isSubsequence(query: string, text: string): boolean {
  let i = 0;
  for (const ch of text) {
    if (ch === query[i]) i += 1;
    if (i === query.length) return true;
  }
  return false;
}

function isWordPrefix(query: string, name: string): boolean {
  return name
    .split(/[-_.]/)
    .some((word, idx) => idx > 0 && word.startsWith(query));
}

function matchTier(query: string, fullName: string): MatchTier | null {
  const full = fullName.toLowerCase();
  const name = repoName(full);
  if (name === query) return MatchTier.ExactName;
  if (name.startsWith(query)) return MatchTier.NamePrefix;
  if (isWordPrefix(query, name)) return MatchTier.NameWordPrefix;
  if (name.includes(query)) return MatchTier.NameSubstring;
  if (full.includes(query)) return MatchTier.FullNameSubstring;
  if (isSubsequence(query, name)) return MatchTier.NameFuzzy;
  return null;
}

/**
 * Filter and order repos for the switcher. Matches are grouped by how well
 * the query fits the repo name (exact, prefix, ... fuzzy). Within a group,
 * recently visited repos come first, then shorter names, then alphabetical.
 * An empty query lists recently visited repos first.
 */
export function rankRepos(
  repos: RepoEntry[],
  query: string,
  visitTimes: RepoVisitTimes,
  limit: number,
): RepoEntry[] {
  const q = query.trim().toLowerCase();
  const scored: { repo: RepoEntry; tier: number; visited: number }[] = [];

  for (const repo of repos) {
    const tier = q === "" ? 0 : matchTier(q, repo.fullName);
    if (tier === null) continue;
    const visited = visitTimes[repo.fullName.toLowerCase()] ?? 0;
    scored.push({ repo, tier, visited });
  }

  scored.sort(
    (a, b) =>
      a.tier - b.tier ||
      b.visited - a.visited ||
      repoName(a.repo.fullName).length - repoName(b.repo.fullName).length ||
      a.repo.fullName.localeCompare(b.repo.fullName),
  );

  return scored.slice(0, limit).map((s) => s.repo);
}
