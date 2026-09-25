import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  forgetTab,
  loadTabHistory,
  recordTabViewed,
  replaceTab,
} from "../src/tabHistory";
import { installChromeStorageFake } from "./chromeStorageFake";

beforeEach(() => {
  installChromeStorageFake();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tab history storage", () => {
  it("moves a viewed tab to the front without duplicating it", async () => {
    await recordTabViewed(1);
    await recordTabViewed(2);
    await recordTabViewed(1);

    expect(await loadTabHistory()).toEqual([1, 2]);
  });

  it("keeps every entry when views are recorded concurrently", async () => {
    await Promise.all([
      recordTabViewed(1),
      recordTabViewed(2),
      recordTabViewed(3),
    ]);

    expect(await loadTabHistory()).toEqual([3, 2, 1]);
  });

  it("caps history at 100 tabs", async () => {
    for (let id = 0; id < 105; id += 1) void recordTabViewed(id);
    await recordTabViewed(105);

    const history = await loadTabHistory();
    expect(history).toHaveLength(100);
    expect(history[0]).toBe(105);
  });

  it("forgets closed tabs", async () => {
    await recordTabViewed(1);
    await recordTabViewed(2);

    await forgetTab(1);

    expect(await loadTabHistory()).toEqual([2]);
  });

  it("replaces a swapped tab id without leaving a duplicate", async () => {
    await recordTabViewed(1);
    await recordTabViewed(9);
    await recordTabViewed(2);

    await replaceTab(9, 1);

    expect(await loadTabHistory()).toEqual([2, 9]);
  });
});
