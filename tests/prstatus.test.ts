import { afterEach, describe, it, expect, vi } from "vitest";
import { extractPrCoords, fetchPrStatus, mapPrStatus } from "../src/prstatus";
import { jsonResponse, stubGithub } from "./githubStub";

describe("extractPrCoords", () => {
  it("parses owner/repo/number from a PR URL", () => {
    expect(extractPrCoords("https://github.com/foo/bar/pull/123")).toEqual({
      owner: "foo",
      repo: "bar",
      number: "123",
    });
  });

  it("ignores PR sub-views in the path", () => {
    expect(
      extractPrCoords("https://github.com/foo/bar/pull/123/files"),
    ).toEqual({
      owner: "foo",
      repo: "bar",
      number: "123",
    });
    expect(
      extractPrCoords("https://github.com/foo/bar/pull/123/commits"),
    ).toEqual({
      owner: "foo",
      repo: "bar",
      number: "123",
    });
  });

  it("ignores query/fragment", () => {
    expect(
      extractPrCoords(
        "https://github.com/foo/bar/pull/123?diff=split#diff-abc",
      ),
    ).toEqual({
      owner: "foo",
      repo: "bar",
      number: "123",
    });
  });

  it("returns null for non-PR URLs", () => {
    expect(extractPrCoords("https://github.com/foo/bar")).toBe(null);
    expect(extractPrCoords("https://github.com/foo/bar/issues/1")).toBe(null);
    expect(extractPrCoords("https://example.com/foo/bar/pull/1")).toBe(null);
  });
});

describe("mapPrStatus", () => {
  it("returns merged when merged=true (even if state=closed)", () => {
    expect(mapPrStatus({ merged: true, state: "closed" })).toBe("merged");
  });

  it("returns closed when state=closed and not merged", () => {
    expect(mapPrStatus({ merged: false, state: "closed" })).toBe("closed");
  });

  it("returns draft for an open draft PR", () => {
    expect(mapPrStatus({ draft: true, state: "open" })).toBe("draft");
  });

  it("returns ready for mergeable_state=clean", () => {
    expect(
      mapPrStatus({ state: "open", draft: false, mergeable_state: "clean" }),
    ).toBe("ready");
    expect(
      mapPrStatus({
        state: "open",
        draft: false,
        mergeable_state: "has_hooks",
      }),
    ).toBe("ready");
  });

  it("returns blocked for failing/conflict/behind/required-holds states", () => {
    for (const s of ["blocked", "dirty", "behind", "unstable"]) {
      expect(
        mapPrStatus({ state: "open", draft: false, mergeable_state: s }),
      ).toBe("blocked");
    }
  });

  it("returns unknown when GitHub hasn't computed the state yet", () => {
    expect(
      mapPrStatus({ state: "open", draft: false, mergeable_state: "unknown" }),
    ).toBe("unknown");
    expect(mapPrStatus({ state: "open", draft: false })).toBe("unknown");
  });

  it("merged trumps everything else", () => {
    expect(
      mapPrStatus({ merged: true, draft: true, state: "closed" }),
    ).toBe("merged");
  });
});

describe("fetchPrStatus", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const coords = { owner: "org", repo: "repo", number: "7" };

  it("returns unknown when GitHub answers with an error", async () => {
    stubGithub({ "/pulls/7": () => jsonResponse({}, 500) });
    expect(await fetchPrStatus(coords, "pat")).toBe("unknown");
  });

  it("sends requests with a timeout signal", async () => {
    const fetchMock = stubGithub({
      "/pulls/7": () =>
        jsonResponse({ state: "open", mergeable_state: "clean" }),
    });
    await fetchPrStatus(coords, "pat");
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });
});
