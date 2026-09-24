import { afterEach, describe, it, expect, vi } from "vitest";
import {
  extractRepoFullName,
  fetchOwnerRepos,
  GithubRequestError,
  isValidGithubOwner,
  parseNextLink,
} from "../src/repoCache";

function jsonResponse(
  body: unknown,
  init: { status?: number; link?: string } = {},
): Response {
  const headers = new Headers();
  if (init.link) headers.set("link", init.link);
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers,
  });
}

function apiRepo(fullName: string, extra: Record<string, unknown> = {}) {
  return { full_name: fullName, description: null, archived: false, ...extra };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extractRepoFullName", () => {
  it("reads owner/name from repo URLs and sub-pages", () => {
    expect(extractRepoFullName("https://github.com/wealthsimple/yarvis")).toBe(
      "wealthsimple/yarvis",
    );
    expect(
      extractRepoFullName("https://github.com/bennettaur/chrome.ttaur/pull/3"),
    ).toBe("bennettaur/chrome.ttaur");
  });

  it("returns null for pages without a repo", () => {
    expect(extractRepoFullName("https://github.com/wealthsimple")).toBeNull();
    expect(extractRepoFullName("https://example.com/a/b")).toBeNull();
  });
});

describe("isValidGithubOwner", () => {
  it.each(["wealthsimple", "bennettaur", "a-b", "A1", "x".repeat(39)])(
    "accepts %s",
    (owner) => {
      expect(isValidGithubOwner(owner)).toBe(true);
    },
  );

  it.each([
    "-lead",
    "trail-",
    "dou--ble",
    "dot.ted",
    "under_score",
    "x".repeat(40),
    "",
  ])("rejects %s", (owner) => {
    expect(isValidGithubOwner(owner)).toBe(false);
  });
});

describe("parseNextLink", () => {
  it("returns the next URL", () => {
    const header =
      '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"';

    expect(parseNextLink(header)).toBe("https://api.github.com/x?page=2");
  });

  it("returns null without a next link", () => {
    expect(
      parseNextLink('<https://api.github.com/x?page=1>; rel="prev"'),
    ).toBeNull();
    expect(parseNextLink(null)).toBeNull();
  });
});

describe("fetchOwnerRepos", () => {
  it("follows pagination and skips archived repos", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([apiRepo("org/a", { description: "A repo" })], {
          link: '<https://api.github.com/orgs/org/repos?page=2>; rel="next"',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          apiRepo("org/b"),
          apiRepo("org/old", { archived: true }),
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const repos = await fetchOwnerRepos("org", undefined, null);

    expect(repos).toEqual([
      { fullName: "org/a", description: "A repo" },
      { fullName: "org/b", description: undefined },
    ]);
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://api.github.com/orgs/org/repos?page=2",
    );
  });

  it("falls back to the users endpoint when the owner isn't an org", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, { status: 404 }))
      .mockResolvedValueOnce(jsonResponse([apiRepo("someone/x")]));
    vi.stubGlobal("fetch", fetchMock);

    const repos = await fetchOwnerRepos("someone", undefined, null);

    expect(repos.map((r) => r.fullName)).toEqual(["someone/x"]);
    expect(fetchMock.mock.calls[1][0]).toContain("/users/someone/repos");
  });

  it("uses /user/repos with the PAT when the owner is the token's account", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse([apiRepo("Me/x")]));
    vi.stubGlobal("fetch", fetchMock);

    await fetchOwnerRepos("me", "token", "Me");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/user/repos?affiliation=owner");
    expect(init.headers.Authorization).toBe("Bearer token");
  });

  it("stops paging at a next link that leaves the GitHub API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([apiRepo("org/a")], {
        link: '<https://evil.example/steal>; rel="next"',
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchOwnerRepos("org", "token", null);

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws on errors other than a missing org", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({}, { status: 403 })),
    );

    await expect(
      fetchOwnerRepos("org", undefined, null),
    ).rejects.toBeInstanceOf(GithubRequestError);
  });
});
