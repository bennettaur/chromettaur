import { afterEach, describe, it, expect, vi } from "vitest";
import { runPrStatusSweep } from "../src/prstatus";
import { DEFAULT_SETTINGS } from "../src/settings";
import type { FakeStorageArea } from "./chromeStorageFake";
import { installChromeTabsFake } from "./chromeTabsFake";
import { jsonResponse, stubGithub } from "./githubStub";

const PR_URL = "https://github.com/org/repo/pull/7";

function enablePrStatus(sync: FakeStorageArea) {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.prStatus.enabled = true;
  sync.data.settings = settings;
  return settings;
}

function groupOf(
  fake: ReturnType<typeof installChromeTabsFake>,
  tabId: number,
) {
  const tab = fake.tabs.find((t) => t.id === tabId)!;
  return fake.groups.find((g) => g.id === tab.groupId);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runPrStatusSweep after a Chrome restart", () => {
  it("moves a PR tab out of a restored GitHub group into its status group", async () => {
    const fake = installChromeTabsFake({
      tabs: [{ id: 1, windowId: 1, url: PR_URL, groupId: 50 }],
      groups: [{ id: 50, windowId: 1, title: "GitHub", color: "grey" }],
    });
    enablePrStatus(fake.sync);
    stubGithub({
      "/pulls/7": () =>
        jsonResponse({ state: "open", mergeable_state: "clean" }),
    });

    await runPrStatusSweep();

    expect(groupOf(fake, 1)).toMatchObject({
      title: "PR: Ready",
      color: "green",
    });
  });

  it("reclaims a tab from a restored group named by a custom auto-group rule", async () => {
    const fake = installChromeTabsFake({
      tabs: [{ id: 1, windowId: 1, url: PR_URL, groupId: 50 }],
      groups: [{ id: 50, windowId: 1, title: "Code", color: "cyan" }],
    });
    const settings = enablePrStatus(fake.sync);
    settings.autoGroup.rules[0].name = "Code";
    fake.sync.data.settings = settings;
    stubGithub({
      "/pulls/7": () =>
        jsonResponse({ state: "open", mergeable_state: "clean" }),
    });

    await runPrStatusSweep();

    expect(groupOf(fake, 1)).toMatchObject({ title: "PR: Ready" });
  });

  it("leaves a PR tab in a group the user named", async () => {
    const fake = installChromeTabsFake({
      tabs: [{ id: 1, windowId: 1, url: PR_URL, groupId: 50 }],
      groups: [{ id: 50, windowId: 1, title: "Sprint", color: "blue" }],
    });
    enablePrStatus(fake.sync);
    stubGithub({
      "/pulls/7": () =>
        jsonResponse({ state: "open", mergeable_state: "clean" }),
    });

    await runPrStatusSweep();

    expect(groupOf(fake, 1)).toMatchObject({ id: 50, title: "Sprint" });
  });
});

describe("runPrStatusSweep reviewer grouping", () => {
  it("puts a PR requesting my review into PR: Reviewer", async () => {
    const fake = installChromeTabsFake({
      tabs: [{ id: 1, windowId: 1, url: PR_URL, groupId: -1 }],
    });
    enablePrStatus(fake.sync);
    fake.local.data.githubPat = "pat";
    const fetchMock = stubGithub({
      "/user": () => jsonResponse({ login: "me" }),
      "/pulls/7": () =>
        jsonResponse({
          state: "open",
          mergeable_state: "blocked",
          user: { login: "author" },
          requested_reviewers: [{ login: "me" }],
        }),
    });

    await runPrStatusSweep();

    expect(groupOf(fake, 1)).toMatchObject({
      title: "PR: Reviewer",
      color: "yellow",
    });
    expect(
      fetchMock.mock.calls.filter(([u]) => u.includes("/pulls/7")),
    ).toHaveLength(1);
  });

  it("moves nothing when the viewer login can't be fetched", async () => {
    const fake = installChromeTabsFake({
      tabs: [{ id: 1, windowId: 1, url: PR_URL, groupId: -1 }],
    });
    enablePrStatus(fake.sync);
    fake.local.data.githubPat = "pat";
    stubGithub({
      "/user": () => jsonResponse({}, 503),
      "/pulls/7": () =>
        jsonResponse({ state: "open", mergeable_state: "clean" }),
    });

    await runPrStatusSweep();

    expect(fake.tabs[0].groupId).toBe(-1);
  });
});

describe("runPrStatusSweep needs attention", () => {
  it("puts my PR with changes requested into PR: Needs attention", async () => {
    const fake = installChromeTabsFake({
      tabs: [{ id: 1, windowId: 1, url: PR_URL, groupId: -1 }],
    });
    enablePrStatus(fake.sync);
    fake.local.data.githubPat = "pat";
    stubGithub({
      "/user": () => jsonResponse({ login: "me" }),
      "/pulls/7/reviews": () =>
        jsonResponse([{ user: { login: "a" }, state: "CHANGES_REQUESTED" }]),
      "/pulls/7": () =>
        jsonResponse({
          state: "open",
          mergeable_state: "blocked",
          user: { login: "me" },
        }),
    });

    await runPrStatusSweep();

    expect(groupOf(fake, 1)).toMatchObject({
      title: "PR: Needs attention",
      color: "orange",
    });
  });
});

describe("runPrStatusSweep unresolved threads", () => {
  it("puts my PR with an unresolved review thread into PR: Needs attention", async () => {
    const fake = installChromeTabsFake({
      tabs: [{ id: 1, windowId: 1, url: PR_URL, groupId: -1 }],
    });
    enablePrStatus(fake.sync);
    fake.local.data.githubPat = "pat";
    stubGithub({
      "/user": () => jsonResponse({ login: "me" }),
      "/graphql": () =>
        jsonResponse({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      isResolved: false,
                      comments: {
                        nodes: [{ author: { __typename: "User", login: "yk" } }],
                      },
                    },
                  ],
                },
              },
            },
          },
        }),
      "/pulls/7/reviews": () => jsonResponse([]),
      "/pulls/7": () =>
        jsonResponse({ state: "open", mergeable_state: "dirty", user: { login: "me" } }),
    });

    await runPrStatusSweep();

    expect(groupOf(fake, 1)).toMatchObject({ title: "PR: Needs attention" });
  });
});
