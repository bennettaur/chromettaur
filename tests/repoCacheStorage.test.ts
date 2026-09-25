import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  loadRepoCandidates,
  recordRepoVisit,
  refreshRepoCache,
} from "../src/repoCache";
import {
  installChromeStorageFake,
  type FakeStorageArea,
} from "./chromeStorageFake";

const DAY_MS = 24 * 60 * 60_000;

let local: FakeStorageArea;
let sync: FakeStorageArea;

function setOwners(owners: string[]): void {
  sync.data.settings = { repoSwitcher: { owners } };
}

function jsonResponse(body: unknown, status = 200, headers = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function apiRepos(...fullNames: string[]) {
  return fullNames.map((full_name) => ({
    full_name,
    description: null,
    archived: false,
  }));
}

/** Route fetches by the first matching URL fragment. */
function stubGithub(routes: Record<string, () => Response>) {
  const fetchMock = vi.fn(async (url: string) => {
    const match = Object.keys(routes).find((fragment) =>
      url.includes(fragment),
    );
    if (!match) throw new Error(`Unexpected fetch: ${url}`);
    return routes[match]();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  ({ local, sync } = installChromeStorageFake());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("refreshRepoCache", () => {
  it("fetches owners missing from the cache", async () => {
    setOwners(["org"]);
    stubGithub({ "/orgs/org/repos": () => jsonResponse(apiRepos("org/a")) });

    await refreshRepoCache();

    const { repos } = await loadRepoCandidates();
    expect(repos.map((r) => r.fullName)).toEqual(["org/a"]);
  });

  it("makes no GitHub calls when every owner is fresh", async () => {
    setOwners(["org"]);
    local.data.repoCache = { org: { repos: [], fetchedAt: Date.now() } };
    const fetchMock = stubGithub({});

    await refreshRepoCache();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refetches owners older than a day", async () => {
    setOwners(["org"]);
    local.data.repoCache = {
      org: { repos: [], fetchedAt: Date.now() - DAY_MS - 1 },
    };
    const fetchMock = stubGithub({
      "/orgs/org/repos": () => jsonResponse(apiRepos("org/a")),
    });

    await refreshRepoCache();

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("matches configured owners to cache entries case-insensitively", async () => {
    setOwners(["Org"]);
    local.data.repoCache = { org: { repos: [], fetchedAt: Date.now() } };
    const fetchMock = stubGithub({});

    await refreshRepoCache();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(local.data.repoCache).toHaveProperty("org");
  });

  it("keeps an owner's previous repos when its fetch fails", async () => {
    setOwners(["org"]);
    local.data.repoCache = {
      org: { repos: [{ fullName: "org/old" }], fetchedAt: 0 },
    };
    stubGithub({ "/orgs/org/repos": () => jsonResponse({}, 500) });

    const result = await refreshRepoCache({ force: true });

    expect(result.failed).toEqual([
      { owner: "org", reason: "GitHub returned 500" },
    ]);
    const { repos } = await loadRepoCandidates();
    expect(repos.map((r) => r.fullName)).toEqual(["org/old"]);
  });

  it("drops owners removed from settings without calling GitHub", async () => {
    setOwners(["kept"]);
    local.data.githubPat = "token";
    local.data.repoCache = {
      kept: { repos: [], fetchedAt: Date.now() },
      removed: { repos: [], fetchedAt: Date.now() },
    };
    const fetchMock = stubGithub({});

    await refreshRepoCache();

    expect(Object.keys(local.data.repoCache as object)).toEqual(["kept"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves the cache alone when the token's login can't be read", async () => {
    setOwners(["me"]);
    local.data.githubPat = "token";
    local.data.repoCache = {
      me: { repos: [{ fullName: "me/private" }], fetchedAt: 0 },
    };
    stubGithub({ "api.github.com/user": () => jsonResponse({}, 502) });

    const result = await refreshRepoCache({ force: true });

    expect(result.failed.map((f) => f.owner)).toEqual(["me"]);
    const { repos } = await loadRepoCandidates();
    expect(repos.map((r) => r.fullName)).toEqual(["me/private"]);
  });

  it("stops fetching once GitHub rate-limits the refresh", async () => {
    setOwners(["a", "b", "c"]);
    const fetchMock = stubGithub({
      "/orgs/a/repos": () =>
        jsonResponse({}, 403, { "x-ratelimit-remaining": "0" }),
    });

    const result = await refreshRepoCache();

    expect(result.failed).toEqual([
      { owner: "a", reason: "rate limited by GitHub" },
      { owner: "b", reason: "rate limited by GitHub" },
      { owner: "c", reason: "rate limited by GitHub" },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("shares one run between concurrent calls", async () => {
    setOwners(["org"]);
    const fetchMock = stubGithub({
      "/orgs/org/repos": () => jsonResponse(apiRepos("org/a")),
    });

    await Promise.all([refreshRepoCache(), refreshRepoCache()]);

    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("recordRepoVisit", () => {
  it("records repos whose owner is allowlisted", async () => {
    setOwners(["Org"]);

    await recordRepoVisit("https://github.com/org/app/pull/1");

    const { repos, visitTimes } = await loadRepoCandidates();
    expect(repos.map((r) => r.fullName)).toEqual(["org/app"]);
    expect(visitTimes["org/app"]).toBeGreaterThan(0);
  });

  it("ignores repos from other owners and non-repo pages", async () => {
    setOwners(["org"]);

    await recordRepoVisit("https://github.com/other/app");
    await recordRepoVisit("https://github.com/orgs/org/teams");

    expect(local.data.visitedRepos).toBeUndefined();
  });

  it("evicts the oldest visits past 500 entries", async () => {
    setOwners(["org"]);
    const visited: Record<string, { fullName: string; lastVisited: number }> =
      {};
    for (let i = 0; i < 500; i += 1) {
      visited[`org/r${i}`] = { fullName: `org/r${i}`, lastVisited: i + 1 };
    }
    local.data.visitedRepos = visited;

    await recordRepoVisit("https://github.com/org/newest");

    const stored = local.data.visitedRepos as Record<string, unknown>;
    expect(Object.keys(stored)).toHaveLength(500);
    expect(stored).not.toHaveProperty("org/r0");
    expect(stored).toHaveProperty("org/newest");
  });
});

describe("loadRepoCandidates", () => {
  it("merges cached and visited repos without duplicates across casing", async () => {
    setOwners(["org"]);
    local.data.repoCache = {
      org: {
        repos: [{ fullName: "Org/App", description: "From the API" }],
        fetchedAt: 1,
      },
    };
    local.data.visitedRepos = {
      "org/app": { fullName: "org/app", lastVisited: 5 },
      "org/visited-only": { fullName: "org/visited-only", lastVisited: 9 },
    };

    const { repos, visitTimes } = await loadRepoCandidates();

    expect(repos).toEqual([
      { fullName: "Org/App", description: "From the API" },
      { fullName: "org/visited-only" },
    ]);
    expect(visitTimes).toEqual({ "org/app": 5, "org/visited-only": 9 });
  });

  it("leaves out owners that are no longer configured", async () => {
    setOwners(["org"]);
    local.data.repoCache = {
      gone: { repos: [{ fullName: "gone/a" }], fetchedAt: 1 },
    };
    local.data.visitedRepos = {
      "gone/b": { fullName: "gone/b", lastVisited: 1 },
    };

    const { repos, visitTimes } = await loadRepoCandidates();

    expect(repos).toEqual([]);
    expect(visitTimes).toEqual({});
  });
});
