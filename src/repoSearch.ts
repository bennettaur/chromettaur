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

// Skips the first word: a match there is already a NamePrefix.
function isLaterWordPrefix(query: string, name: string): boolean {
  return name
    .split(/[-_.]/)
    .some((word, idx) => idx > 0 && word.startsWith(query));
}

function findMatchTier(query: string, fullName: string): MatchTier | null {
  const full = fullName.toLowerCase();
  const name = repoName(full);
  if (name === query) return MatchTier.ExactName;
  if (name.startsWith(query)) return MatchTier.NamePrefix;
  if (isLaterWordPrefix(query, name)) return MatchTier.NameWordPrefix;
  if (name.includes(query)) return MatchTier.NameSubstring;
  if (full.includes(query)) return MatchTier.FullNameSubstring;
  if (isSubsequence(query, name)) return MatchTier.NameFuzzy;
  return null;
}

/**
 * Filter and order repos for the switcher. Matches are grouped by
 * `MatchTier`, from exact name match down to fuzzy. Within a tier,
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
  const scored: { repo: RepoEntry; tier: MatchTier; lastVisited: number }[] =
    [];

  for (const repo of repos) {
    // Every repo ties on an empty query, so recency decides the order.
    const tier =
      q === "" ? MatchTier.ExactName : findMatchTier(q, repo.fullName);
    if (tier === null) continue;
    const lastVisited = visitTimes[repo.fullName.toLowerCase()] ?? 0;
    scored.push({ repo, tier, lastVisited });
  }

  scored.sort(
    (a, b) =>
      a.tier - b.tier ||
      b.lastVisited - a.lastVisited ||
      repoName(a.repo.fullName).length - repoName(b.repo.fullName).length ||
      a.repo.fullName.localeCompare(b.repo.fullName),
  );

  return scored.slice(0, limit).map((s) => s.repo);
}
