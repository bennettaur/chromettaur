import { afterEach, describe, it, expect, vi } from "vitest";
import { GithubRequestError } from "../src/github";
import { fetchWantedPrs, MY_PR_QUERIES } from "../src/myPrs";
import { jsonResponse, stubGithub } from "./githubStub";

const item = (path: string) => ({ html_url: `https://github.com/${path}` });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchWantedPrs", () => {
  it("sends the three queries in order", async () => {
    const fetchMock = stubGithub({
      "/search/issues": () => jsonResponse({ items: [] }),
    });
    await fetchWantedPrs("pat");
    const qs = fetchMock.mock.calls.map(([u]) =>
      new URL(u).searchParams.get("q"),
    );
    expect(qs).toEqual(MY_PR_QUERIES);
  });

  it("keeps query order and drops duplicates across queries", async () => {
    const pages = [
      { items: [item("org/a/pull/1")] },
      { items: [item("Org/A/pull/1"), item("org/b/pull/2")] },
      { items: [item("org/c/pull/3")] },
    ];
    let call = 0;
    stubGithub({ "/search/issues": () => jsonResponse(pages[call++]) });

    const wanted = await fetchWantedPrs("pat");

    expect(wanted.map((w) => w.key)).toEqual(["org/a#1", "org/b#2", "org/c#3"]);
  });

  it("fails the whole fetch when any search fails", async () => {
    let call = 0;
    stubGithub({
      "/search/issues": () =>
        call++ === 1
          ? jsonResponse({}, 403, { "x-ratelimit-remaining": "0" })
          : jsonResponse({ items: [] }),
    });
    await expect(fetchWantedPrs("pat")).rejects.toBeInstanceOf(
      GithubRequestError,
    );
  });
});
