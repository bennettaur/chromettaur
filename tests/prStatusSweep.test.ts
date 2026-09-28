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
