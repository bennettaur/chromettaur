import { afterEach, describe, it, expect, vi } from "vitest";
import {
  handleTrackedTabNavigated,
  handleTrackedTabRemoved,
  loadAutoOpenState,
  rebuildAutoOpenTabMap,
  runAutoOpen,
} from "../src/autoopen";
import { loadState } from "../src/state";
import { DEFAULT_SETTINGS } from "../src/settings";
import { installChromeTabsFake, type FakeTab } from "./chromeTabsFake";
import { jsonResponse, stubGithub } from "./githubStub";

const url = (n: number) => `https://github.com/org/r/pull/${n}`;
const NOW = 1_000_000;

function setup(
  opts: {
    tabs?: FakeTab[];
    lastFocusedWindowId?: number | null;
    autoOpen?: boolean;
  } = {},
) {
  const fake = installChromeTabsFake({
    tabs: opts.tabs,
    lastFocusedWindowId: opts.lastFocusedWindowId,
  });
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.prStatus.enabled = true;
  settings.autoOpen.enabled = opts.autoOpen ?? true;
  fake.sync.data.settings = settings;
  fake.local.data.githubPat = "pat";
  return fake;
}

/** Search returns `requested` for the first query, nothing for the others. */
function stubSearch(requested: number[], pulls: Record<number, object> = {}) {
  let call = 0;
  const routes: Record<string, () => Response> = {
    "/search/issues": () =>
      jsonResponse({
        items:
          call++ % 3 === 0 ? requested.map((n) => ({ html_url: url(n) })) : [],
      }),
  };
  for (const [n, body] of Object.entries(pulls)) {
    routes[`/pulls/${n}`] = () => jsonResponse(body);
  }
  return stubGithub(routes);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runAutoOpen", () => {
  it("does nothing, and calls GitHub for nothing, when off", async () => {
    setup({ autoOpen: false });
    const fetchMock = stubSearch([1]);
    await runAutoOpen(NOW);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opens wanted PRs in the background in the last focused window", async () => {
    const fake = setup();
    stubSearch([1]);
    await runAutoOpen(NOW);
    expect(fake.chrome.tabs.create).toHaveBeenCalledWith({
      url: url(1),
      windowId: 1,
      active: false,
    });
    expect((await loadAutoOpenState()).autoOpened).toHaveProperty(["org/r#1"]);
  });

  it("opens nothing without a normal window, and remembers nothing", async () => {
    const fake = setup({ lastFocusedWindowId: null });
    stubSearch([1]);
    await runAutoOpen(NOW);
    expect(fake.chrome.tabs.create).not.toHaveBeenCalled();
    expect((await loadAutoOpenState()).autoOpened).toEqual({});
  });

  it("opens and closes nothing when one search fails, and records the error", async () => {
    const fake = setup({
      tabs: [{ id: 5, windowId: 1, url: url(2), groupId: -1 }],
    });
    fake.local.data.autoOpenState = {
      autoOpened: { "org/r#2": { openedAt: 1, url: url(2) } },
      dismissed: [],
      lastError: null,
    };
    let call = 0;
    stubGithub({
      "/search/issues": () =>
        call++ === 1
          ? jsonResponse({}, 403, { "x-ratelimit-remaining": "0" })
          : jsonResponse({ items: [{ html_url: url(1) }] }),
      "/pulls/2": () => jsonResponse({ merged: true, state: "closed" }),
    });
    await runAutoOpen(NOW);
    expect(fake.chrome.tabs.create).not.toHaveBeenCalled();
    expect(fake.chrome.tabs.remove).not.toHaveBeenCalled();
    expect((await loadAutoOpenState()).lastError).toEqual({
      message: "rate limited by GitHub",
      at: NOW,
    });
  });

  it("closes an auto-opened tab once its PR is merged, into recently closed", async () => {
    const fake = setup();
    stubSearch([1]);
    await runAutoOpen(NOW);
    const opened = fake.tabs.find((t) => t.url === url(1))!;
    opened.title = "Fix retries";
    stubSearch([], { 1: { merged: true, state: "closed" } });

    await runAutoOpen(NOW + 1);

    expect(fake.tabs.some((t) => t.id === opened.id)).toBe(false);
    expect((await loadState()).recentlyClosed[0]).toMatchObject({
      url: url(1),
      title: "Fix retries",
    });
    expect((await loadAutoOpenState()).autoOpened).toEqual({});
  });

  it("only closes tabs it opened, not my own tab on the same PR", async () => {
    const fake = setup();
    stubSearch([1]);
    await runAutoOpen(NOW);
    fake.tabs.push({ id: 77, windowId: 1, url: `${url(1)}/files`, groupId: -1 });
    stubSearch([], { 1: { merged: true, state: "closed" } });

    await runAutoOpen(NOW + 1);

    expect(fake.tabs.map((t) => t.id)).toEqual([77]);
  });

  it("does not reopen a PR I closed", async () => {
    const fake = setup();
    stubSearch([1]);
    await runAutoOpen(NOW);
    const opened = fake.tabs.find((t) => t.url === url(1))!;
    fake.tabs.splice(fake.tabs.indexOf(opened), 1);
    await handleTrackedTabRemoved(opened.id, false);

    stubSearch([1]);
    await runAutoOpen(NOW + 1);

    expect(fake.chrome.tabs.create).toHaveBeenCalledTimes(1);
  });

  it("reopens a PR whose window was closed", async () => {
    const fake = setup();
    stubSearch([1]);
    await runAutoOpen(NOW);
    const opened = fake.tabs.find((t) => t.url === url(1))!;
    fake.tabs.splice(fake.tabs.indexOf(opened), 1);
    await handleTrackedTabRemoved(opened.id, true);

    stubSearch([1]);
    await runAutoOpen(NOW + 1);

    expect(fake.chrome.tabs.create).toHaveBeenCalledTimes(2);
  });

  it("treats navigating an auto-opened tab off its PR as dismissing it", async () => {
    const fake = setup();
    stubSearch([1]);
    await runAutoOpen(NOW);
    const opened = fake.tabs.find((t) => t.url === url(1))!;
    opened.url = "https://github.com/org/r";
    await handleTrackedTabNavigated(opened.id, opened.url);

    stubSearch([1]);
    await runAutoOpen(NOW + 1);

    expect(fake.chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect((await loadAutoOpenState()).dismissed).toEqual(["org/r#1"]);
  });
});

describe("after a Chrome restart", () => {
  function restartWith(tabs: FakeTab[]) {
    const fake = setup({ tabs });
    fake.local.data.autoOpenState = {
      autoOpened: { "org/r#1": { openedAt: 1, url: url(1) } },
      dismissed: [],
      lastError: null,
    };
    // session storage starts empty, as after a real restart
    return fake;
  }

  it("still closes restored auto-opened tabs when their PR merges", async () => {
    const fake = restartWith([
      { id: 300, windowId: 1, url: url(1), groupId: -1 },
    ]);
    await rebuildAutoOpenTabMap();
    stubSearch([], { 1: { merged: true, state: "closed" } });

    await runAutoOpen(NOW);

    expect(fake.tabs).toEqual([]);
  });

  it("re-links restored tabs on the next poll when the startup rebuild missed them", async () => {
    const fake = restartWith([
      { id: 300, windowId: 1, url: url(1), groupId: -1 },
    ]);
    stubSearch([1]);
    await runAutoOpen(NOW);
    fake.tabs.splice(0, 1);
    await handleTrackedTabRemoved(300, false);

    expect((await loadAutoOpenState()).dismissed).toEqual(["org/r#1"]);
  });

  it("closes a restored tab on merge when the startup rebuild missed it", async () => {
    const fake = restartWith([
      { id: 300, windowId: 1, url: url(1), groupId: -1 },
    ]);
    stubSearch([], { 1: { merged: true, state: "closed" } });

    await runAutoOpen(NOW);

    expect(fake.tabs).toEqual([]);
  });

  it("still dismisses a restored auto-opened tab I close", async () => {
    const fake = restartWith([
      { id: 300, windowId: 1, url: url(1), groupId: -1 },
    ]);
    await rebuildAutoOpenTabMap();
    fake.tabs.splice(0, 1);
    await handleTrackedTabRemoved(300, false);

    expect((await loadAutoOpenState()).dismissed).toEqual(["org/r#1"]);
  });
});
