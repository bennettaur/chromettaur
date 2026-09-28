import { afterEach, describe, it, expect, vi } from "vitest";
import {
  extractPrCoords,
  fetchPrStatus,
  hasChangesRequested,
  isReviewer,
  mapPrStatus,
  prKey,
  resolvePrGroup,
} from "../src/prstatus";
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

const review = (login: string, state = "COMMENTED") => ({
  user: { login },
  state,
});

describe("resolvePrGroup", () => {
  const open = { state: "open" as const, mergeable_state: "blocked" };

  it("is reviewer when my review is requested", () => {
    const pr = {
      ...open,
      user: { login: "a" },
      requested_reviewers: [{ login: "Me" }],
    };
    expect(resolvePrGroup(pr, [], "me")).toBe("reviewer");
  });

  it("is reviewer when I already reviewed", () => {
    expect(resolvePrGroup({ ...open, user: { login: "a" } }, [review("me")], "me")).toBe(
      "reviewer",
    );
  });

  it("never marks my own PR as reviewer", () => {
    const pr = {
      ...open,
      user: { login: "me" },
      requested_reviewers: [{ login: "me" }],
    };
    expect(resolvePrGroup(pr, [review("me")], "me")).toBe("blocked");
  });

  it("puts merged and closed ahead of reviewer", () => {
    const req = { user: { login: "a" }, requested_reviewers: [{ login: "me" }] };
    expect(
      resolvePrGroup({ ...req, merged: true, state: "closed" }, [], "me"),
    ).toBe("merged");
    expect(resolvePrGroup({ ...req, state: "closed" }, [], "me")).toBe("closed");
  });

  it("falls back to status without a viewer login", () => {
    const pr = {
      ...open,
      user: { login: "a" },
      requested_reviewers: [{ login: "me" }],
    };
    expect(resolvePrGroup(pr, [review("me")], null)).toBe("blocked");
  });

  it("ignores team review requests", () => {
    const pr = { ...open, user: { login: "a" }, requested_reviewers: [] };
    expect(isReviewer(pr, [], "me")).toBe(false);
  });
});

describe("hasChangesRequested", () => {
  it("is true when a reviewer's latest verdict requests changes", () => {
    expect(hasChangesRequested([review("a", "CHANGES_REQUESTED")])).toBe(true);
  });

  it("clears once that reviewer approves", () => {
    expect(
      hasChangesRequested([
        review("a", "CHANGES_REQUESTED"),
        review("a", "APPROVED"),
      ]),
    ).toBe(false);
  });

  it("clears once the review is dismissed", () => {
    expect(
      hasChangesRequested([
        review("a", "CHANGES_REQUESTED"),
        review("a", "DISMISSED"),
      ]),
    ).toBe(false);
  });

  it("is not cleared by a later plain comment", () => {
    expect(
      hasChangesRequested([
        review("a", "CHANGES_REQUESTED"),
        review("a", "COMMENTED"),
      ]),
    ).toBe(true);
  });

  it("is true when one of several reviewers requests changes", () => {
    expect(
      hasChangesRequested([
        review("a", "APPROVED"),
        review("b", "CHANGES_REQUESTED"),
      ]),
    ).toBe(true);
  });

  it("is false with no reviews", () => {
    expect(hasChangesRequested([])).toBe(false);
  });
});

describe("resolvePrGroup changes requested", () => {
  const mine = { state: "open" as const, mergeable_state: "blocked", user: { login: "me" } };
  const cr = [review("a", "CHANGES_REQUESTED")];

  it("puts my PR with changes requested into changesRequested", () => {
    expect(resolvePrGroup(mine, cr, "me")).toBe("changesRequested");
  });

  it("wins over draft", () => {
    expect(resolvePrGroup({ ...mine, draft: true }, cr, "me")).toBe(
      "changesRequested",
    );
  });

  it("loses to merged and closed", () => {
    expect(resolvePrGroup({ ...mine, merged: true, state: "closed" }, cr, "me")).toBe(
      "merged",
    );
    expect(resolvePrGroup({ ...mine, state: "closed" }, cr, "me")).toBe("closed");
  });

  it("does not apply to someone else's PR", () => {
    expect(resolvePrGroup({ ...mine, user: { login: "b" } }, cr, "me")).toBe(
      "blocked",
    );
  });

  it("does not apply without a viewer login", () => {
    expect(resolvePrGroup(mine, cr, null)).toBe("blocked");
  });
});

describe("prKey", () => {
  it("ignores owner/repo case", () => {
    expect(prKey({ owner: "Org", repo: "Repo", number: "7" })).toBe(
      "org/repo#7",
    );
  });
});

describe("fetchPrStatus with a viewer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const coords = { owner: "org", repo: "repo", number: "7" };

  it("checks reviews on my own PR and reports changes requested", async () => {
    stubGithub({
      "/pulls/7/reviews": () =>
        jsonResponse([{ user: { login: "a" }, state: "CHANGES_REQUESTED" }]),
      "/pulls/7": () =>
        jsonResponse({ state: "open", mergeable_state: "clean", user: { login: "me" } }),
    });
    expect(await fetchPrStatus(coords, "pat", "me")).toBe("changesRequested");
  });

  it("skips the reviews call when my review is requested", async () => {
    const fetchMock = stubGithub({
      "/pulls/7": () =>
        jsonResponse({
          state: "open",
          user: { login: "a" },
          requested_reviewers: [{ login: "me" }],
        }),
    });
    expect(await fetchPrStatus(coords, "pat", "me")).toBe("reviewer");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("checks reviews when not requested", async () => {
    stubGithub({
      "/pulls/7/reviews": () =>
        jsonResponse([{ user: { login: "me" } }, { user: null }]),
      "/pulls/7": () =>
        jsonResponse({
          state: "open",
          mergeable_state: "clean",
          user: { login: "a" },
          requested_reviewers: [],
        }),
    });
    expect(await fetchPrStatus(coords, "pat", "me")).toBe("reviewer");
  });

  it("returns unknown when the reviews call fails", async () => {
    stubGithub({
      "/pulls/7/reviews": () => jsonResponse({}, 502),
      "/pulls/7": () =>
        jsonResponse({
          state: "open",
          mergeable_state: "clean",
          user: { login: "a" },
          requested_reviewers: [],
        }),
    });
    expect(await fetchPrStatus(coords, "pat", "me")).toBe("unknown");
  });
});
