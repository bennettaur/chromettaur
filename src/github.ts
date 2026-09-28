export const GITHUB_API = "https://api.github.com";
const FETCH_TIMEOUT_MS = 15_000;

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

export function describeFailure(err: unknown): string {
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

function githubHeaders(pat: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (pat) headers.Authorization = `Bearer ${pat}`;
  return headers;
}

export async function githubGet(
  url: string,
  pat: string | undefined,
): Promise<Response> {
  const res = await fetch(url, {
    headers: githubHeaders(pat),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw GithubRequestError.fromResponse(res, url);
  return res;
}

/** GraphQL reports most failures in a 200 body, so those throw too. */
export async function githubGraphql<T>(
  query: string,
  variables: Record<string, unknown>,
  pat: string,
): Promise<T> {
  const url = `${GITHUB_API}/graphql`;
  const res = await fetch(url, {
    method: "POST",
    headers: githubHeaders(pat),
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw GithubRequestError.fromResponse(res, url);
  const body = (await res.json()) as {
    data?: T;
    errors?: { message: string }[];
  };
  if (body.errors?.length || !body.data) {
    throw new Error(
      `GitHub GraphQL: ${body.errors?.[0]?.message ?? "no data returned"}`,
    );
  }
  return body.data;
}

export async function fetchViewerLogin(pat: string): Promise<string> {
  const res = await githubGet(`${GITHUB_API}/user`, pat);
  return ((await res.json()) as { login: string }).login;
}

const VIEWER_KEY = "githubViewerLogin";

/**
 * Login of the PAT's owner, cached until the PAT is saved or cleared. Null
 * without a PAT; throws when GitHub can't be reached.
 */
export async function loadViewerLogin(
  pat: string | undefined,
): Promise<string | null> {
  if (!pat) return null;
  const r = await chrome.storage.local.get(VIEWER_KEY);
  const cached = r[VIEWER_KEY];
  if (typeof cached === "string") return cached;
  const login = await fetchViewerLogin(pat);
  await chrome.storage.local.set({ [VIEWER_KEY]: login });
  return login;
}

export async function forgetViewerLogin(): Promise<void> {
  await chrome.storage.local.remove(VIEWER_KEY);
}
