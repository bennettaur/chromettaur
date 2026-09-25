import { describe, it, expect } from "vitest";
import {
  parseRepoQuery,
  rankRepos,
  repoPageUrl,
  type RepoEntry,
} from "../src/repoSearch";

function repos(...fullNames: string[]): RepoEntry[] {
  return fullNames.map((fullName) => ({ fullName }));
}

function names(result: RepoEntry[]): string[] {
  return result.map((r) => r.fullName);
}

describe("rankRepos", () => {
  it("puts an exact name match before prefix matches", () => {
    const result = rankRepos(
      repos("wealthsimple/yarvis-ui", "wealthsimple/yarvis"),
      "yarvis",
      {},
      10,
    );

    expect(names(result)).toEqual([
      "wealthsimple/yarvis",
      "wealthsimple/yarvis-ui",
    ]);
  });

  it("ranks name prefix, word prefix, substring, owner, then fuzzy", () => {
    const result = rankRepos(
      repos(
        "wealthsimple/fuzzy-service-lol",
        "wealthsimple/llm-thing",
        "llmcorp/other",
        "wealthsimple/allm",
        "wealthsimple/my-llm",
        "wealthsimple/llm",
        "wealthsimple/l-x-l-m",
      ),
      "llm",
      {},
      10,
    );

    expect(names(result)).toEqual([
      "wealthsimple/llm",
      "wealthsimple/llm-thing",
      "wealthsimple/my-llm",
      "wealthsimple/allm",
      "llmcorp/other",
      "wealthsimple/l-x-l-m",
    ]);
  });

  it("matches case-insensitively", () => {
    const result = rankRepos(repos("bennettaur/Chromettaur"), "CHROME", {}, 10);

    expect(names(result)).toEqual(["bennettaur/Chromettaur"]);
  });

  it("matches owner/name queries", () => {
    const result = rankRepos(
      repos("wealthsimple/api", "bennettaur/api"),
      "bennettaur/a",
      {},
      10,
    );

    expect(names(result)).toEqual(["bennettaur/api"]);
  });

  it("prefers recently visited repos within the same tier", () => {
    const result = rankRepos(
      repos("wealthsimple/llm", "wealthsimple/llm-service"),
      "ll",
      { "wealthsimple/llm-service": 1000 },
      10,
    );

    expect(names(result)).toEqual([
      "wealthsimple/llm-service",
      "wealthsimple/llm",
    ]);
  });

  it("does not let a visit outrank a better tier", () => {
    const result = rankRepos(
      repos("wealthsimple/llm", "wealthsimple/my-llm"),
      "llm",
      { "wealthsimple/my-llm": 1000 },
      10,
    );

    expect(names(result)[0]).toBe("wealthsimple/llm");
  });

  it("lists recently visited repos first for an empty query", () => {
    const result = rankRepos(
      repos("a/bbb", "a/aaa", "a/ccc"),
      "  ",
      { "a/ccc": 5, "a/bbb": 10 },
      10,
    );

    expect(names(result)).toEqual(["a/bbb", "a/ccc", "a/aaa"]);
  });

  it("puts an exact owner/name match first", () => {
    const result = rankRepos(
      repos("wealthsimple/yarvis-ui", "wealthsimple/yarvis"),
      "wealthsimple/yarvis",
      { "wealthsimple/yarvis-ui": 1000 },
      10,
    );

    expect(names(result)[0]).toBe("wealthsimple/yarvis");
  });

  it("keeps the repo first when Tab's completion is searched again", () => {
    const repoList = repos("WealthSimple/Yarvis-UI", "WealthSimple/Yarvis");
    const { repoText, prNumber } = parseRepoQuery("WealthSimple/Yarvis#12");

    const result = rankRepos(repoList, repoText, {}, 10);

    expect(names(result)[0]).toBe("WealthSimple/Yarvis");
    expect(prNumber).toBe("12");
  });

  it("drops repos that don't match", () => {
    expect(rankRepos(repos("a/zzz"), "llm", {}, 10)).toEqual([]);
  });

  it("keeps the best-ranked repos when capping at the limit", () => {
    const result = rankRepos(repos("a/zx", "a/xy", "a/x"), "x", {}, 2);

    expect(names(result)).toEqual(["a/x", "a/xy"]);
  });
});

describe("parseRepoQuery", () => {
  it("returns the whole query when there's no #", () => {
    expect(parseRepoQuery("yarvis")).toEqual({
      repoText: "yarvis",
      prNumber: null,
    });
  });

  it("splits a trailing PR number off the repo text", () => {
    expect(parseRepoQuery("wealthsimple/yarvis#123")).toEqual({
      repoText: "wealthsimple/yarvis",
      prNumber: "123",
    });
  });

  it("reports an empty PR number while only # is typed", () => {
    expect(parseRepoQuery("yarvis #")).toEqual({
      repoText: "yarvis",
      prNumber: "",
    });
  });

  it("allows a space after the #", () => {
    expect(parseRepoQuery("yarvis # 12")).toEqual({
      repoText: "yarvis",
      prNumber: "12",
    });
  });

  it("leaves the repo text empty for a bare PR number", () => {
    expect(parseRepoQuery("#123")).toEqual({ repoText: "", prNumber: "123" });
  });

  it("treats a # followed by non-digits as repo text", () => {
    expect(parseRepoQuery("yarvis#abc")).toEqual({
      repoText: "yarvis#abc",
      prNumber: null,
    });
  });
});

describe("repoPageUrl", () => {
  it("links to the repo without a PR number", () => {
    expect(repoPageUrl("a/b", null)).toBe("https://github.com/a/b");
  });

  it("links to the pull request list for a bare #", () => {
    expect(repoPageUrl("a/b", "")).toBe("https://github.com/a/b/pulls");
  });

  it("links to a single pull request", () => {
    expect(repoPageUrl("a/b", "42")).toBe("https://github.com/a/b/pull/42");
  });
});
