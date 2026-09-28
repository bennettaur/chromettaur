import { GITHUB_API, githubGet } from "./github";
import { extractPrCoords, prKey, type PrCoords } from "./prstatus";

// Ordered by priority: the per-poll open cap favours review requests.
export const MY_PR_QUERIES = [
  "is:pr is:open archived:false review-requested:@me",
  "is:pr is:open archived:false reviewed-by:@me -author:@me",
  "is:pr is:open archived:false author:@me",
];

export interface WantedPr {
  key: string;
  url: string;
  coords: PrCoords;
}

interface SearchResponse {
  items: { html_url: string }[];
}

/** Results only cover repos the token can read; GitHub omits the rest silently. */
export async function fetchWantedPrs(pat: string): Promise<WantedPr[]> {
  const byKey = new Map<string, WantedPr>();
  for (const q of MY_PR_QUERIES) {
    const res = await githubGet(
      `${GITHUB_API}/search/issues?q=${encodeURIComponent(q)}&per_page=100`,
      pat,
    );
    for (const { html_url } of ((await res.json()) as SearchResponse).items) {
      const coords = extractPrCoords(html_url);
      if (!coords) continue;
      const key = prKey(coords);
      if (!byKey.has(key)) byKey.set(key, { key, url: html_url, coords });
    }
  }
  return [...byKey.values()];
}
