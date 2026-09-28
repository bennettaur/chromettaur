import { describe, it, expect } from "vitest";
import { planAutoOpen, type OpenPrTab } from "../src/autoOpenPlan";
import type { WantedPr } from "../src/myPrs";

function wanted(n: number): WantedPr {
  return {
    key: `org/r#${n}`,
    url: `https://github.com/org/r/pull/${n}`,
    coords: { owner: "org", repo: "r", number: String(n) },
  };
}
function tab(tabId: number, n: number): OpenPrTab {
  return {
    tabId,
    key: `org/r#${n}`,
    url: `https://github.com/org/r/pull/${n}`,
    title: `#${n}`,
  };
}
const base = { openTabs: [], autoOpened: {}, dismissed: [], maxPerPoll: 10 };

describe("planAutoOpen", () => {
  it("opens wanted PRs that have no tab", () => {
    const plan = planAutoOpen({
      ...base,
      wanted: [wanted(1), wanted(2)],
      openTabs: [tab(9, 2)],
    });
    expect(plan.toOpen.map((w) => w.key)).toEqual(["org/r#1"]);
  });

  it("does not reopen dismissed PRs", () => {
    const plan = planAutoOpen({
      ...base,
      wanted: [wanted(1)],
      dismissed: ["org/r#1"],
    });
    expect(plan.toOpen).toEqual([]);
    expect(plan.dismissed).toEqual(["org/r#1"]);
  });

  it("forgets dismissals for PRs no longer wanted", () => {
    const plan = planAutoOpen({ ...base, wanted: [], dismissed: ["org/r#1"] });
    expect(plan.dismissed).toEqual([]);
  });

  it("opens at most maxPerPoll, in wanted order", () => {
    const plan = planAutoOpen({
      ...base,
      wanted: [1, 2, 3].map(wanted),
      maxPerPoll: 2,
    });
    expect(plan.toOpen.map((w) => w.key)).toEqual(["org/r#1", "org/r#2"]);
  });

  it("forgets auto-opened PRs whose tabs are gone", () => {
    const plan = planAutoOpen({
      ...base,
      wanted: [wanted(1)],
      autoOpened: { "org/r#1": { openedAt: 1, url: wanted(1).url } },
    });
    expect(plan.autoOpened).toEqual({});
    expect(plan.toOpen.map((w) => w.key)).toEqual(["org/r#1"]);
  });

  it("checks auto-opened PRs that left the wanted set but still have a tab", () => {
    const plan = planAutoOpen({
      ...base,
      wanted: [],
      openTabs: [tab(9, 1)],
      autoOpened: { "org/r#1": { openedAt: 1, url: wanted(1).url } },
    });
    expect(plan.toCheck).toEqual(["org/r#1"]);
    expect(plan.autoOpened).toHaveProperty(["org/r#1"]);
  });
});
