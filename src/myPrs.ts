import { GITHUB_API, githubGet } from "./github";
import { extractPrCoords, prKey, type PrCoords } from "./prstatus";

// Ordered by priority: the open-tab cap favours review requests.
export const MY_PR_QUERIES = [
  // `review-requested:` would also match requests to any team I am on.
  "is:pr is:open archived:false user-review-requested:@me",
  "is:pr is:open archived:false reviewed-by:@me -author:@me",
  "is:pr is:open archived:false author:@me",
];

export interface WantedPr {
  key: string;
  url: string;
  coords: PrCoords;
}

interface SearchResponse {
  incomplete_results?: boolean;
  items: { html_url: string }[];
}

/** A partial list would make the planner forget dismissals and records. */
export class IncompleteSearchError extends Error {
  override name = "IncompleteSearchError";
}

/** Results only cover repos the token can read; GitHub omits the rest silently. */
export async function fetchWantedPrs(pat: string): Promise<WantedPr[]> {
  const byKey = new Map<string, WantedPr>();
  for (const q of MY_PR_QUERIES) {
    const res = await githubGet(
      `${GITHUB_API}/search/issues?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=100`,
      pat,
    );
    const body = (await res.json()) as SearchResponse;
    if (body.incomplete_results) {
      throw new IncompleteSearchError(
        "GitHub search returned incomplete results",
      );
    }
    for (const { html_url } of body.items) {
      const coords = extractPrCoords(html_url);
      if (!coords) continue;
      const key = prKey(coords);
      if (!byKey.has(key)) byKey.set(key, { key, url: html_url, coords });
    }
  }
  return [...byKey.values()];
}
