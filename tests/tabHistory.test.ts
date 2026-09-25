import { describe, it, expect } from "vitest";
import { filterTabs, orderTabsByHistory } from "../src/tabHistory";

function tab(
  id: number,
  extra: Partial<chrome.tabs.Tab> = {},
): chrome.tabs.Tab {
  return { id, windowId: 1, ...extra } as chrome.tabs.Tab;
}

describe("orderTabsByHistory", () => {
  it("orders tabs by history position", () => {
    const result = orderTabsByHistory([tab(1), tab(2), tab(3)], [3, 1, 2]);

    expect(result.map((t) => t.id)).toEqual([3, 1, 2]);
  });

  it("puts tabs missing from history last, newest lastAccessed first", () => {
    const result = orderTabsByHistory(
      [
        tab(1, { lastAccessed: 100 }),
        tab(2, { lastAccessed: 300 }),
        tab(3, { lastAccessed: 200 }),
        tab(4),
      ],
      [3],
    );

    expect(result.map((t) => t.id)).toEqual([3, 2, 1, 4]);
  });

  it("ignores history entries for tabs that are gone", () => {
    const result = orderTabsByHistory([tab(1), tab(2)], [99, 2, 1]);

    expect(result.map((t) => t.id)).toEqual([2, 1]);
  });
});

describe("filterTabs", () => {
  const tabs = [
    tab(1, {
      title: "Pull request #12",
      url: "https://github.com/a/b/pull/12",
    }),
    tab(2, { title: "Jira board", url: "https://acme.atlassian.net/board" }),
  ];

  it("returns every tab for an empty query", () => {
    expect(filterTabs(tabs, " ")).toEqual(tabs);
  });

  it("matches against title and URL, case-insensitively", () => {
    expect(filterTabs(tabs, "JIRA").map((t) => t.id)).toEqual([2]);
    expect(filterTabs(tabs, "github").map((t) => t.id)).toEqual([1]);
  });

  it("requires every term to match", () => {
    expect(filterTabs(tabs, "pull atlassian")).toEqual([]);
    expect(filterTabs(tabs, "pull github").map((t) => t.id)).toEqual([1]);
  });
});
