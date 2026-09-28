import { vi } from "vitest";
import { matches } from "../src/matcher";
import { installChromeStorageFake } from "./chromeStorageFake";

export interface FakeTab {
  id: number;
  windowId: number;
  url: string;
  title?: string;
  groupId: number;
}

export interface FakeGroup {
  id: number;
  windowId: number;
  title: string;
  color: string;
}

/**
 * Stub `chrome` with storage plus the tabs, tabGroups and windows calls the
 * PR code makes. `lastFocusedWindowId: null` simulates no normal window.
 */
export function installChromeTabsFake(
  init: {
    tabs?: FakeTab[];
    groups?: FakeGroup[];
    lastFocusedWindowId?: number | null;
  } = {},
) {
  const storage = installChromeStorageFake();
  const tabs: FakeTab[] = structuredClone(init.tabs ?? []);
  const groups: FakeGroup[] = structuredClone(init.groups ?? []);
  let nextId = 1000;
  const setGroup = (ids: number | number[], groupId: number) => {
    const list = Array.isArray(ids) ? ids : [ids];
    for (const t of tabs) if (list.includes(t.id)) t.groupId = groupId;
  };

  const chrome = {
    storage,
    tabs: {
      query: vi.fn(async (q: { url?: string } = {}) =>
        tabs
          .filter((t) => q.url === undefined || matches(t.url, q.url))
          .map((t) => ({ ...t })),
      ),
      get: vi.fn(async (id: number) => {
        const t = tabs.find((x) => x.id === id);
        if (!t) throw new Error(`No tab ${id}`);
        return { ...t };
      }),
      create: vi.fn(
        async (p: { url: string; windowId?: number; active?: boolean }) => {
          const t: FakeTab = {
            id: nextId++,
            windowId: p.windowId ?? 1,
            url: p.url,
            groupId: -1,
          };
          tabs.push(t);
          return { ...t };
        },
      ),
      remove: vi.fn(async (id: number) => {
        const i = tabs.findIndex((x) => x.id === id);
        if (i >= 0) tabs.splice(i, 1);
      }),
      group: vi.fn(
        async (o: {
          tabIds: number | number[];
          groupId?: number;
          createProperties?: { windowId?: number };
        }) => {
          let gid = o.groupId;
          if (gid === undefined) {
            gid = nextId++;
            groups.push({
              id: gid,
              windowId: o.createProperties?.windowId ?? 1,
              title: "",
              color: "grey",
            });
          }
          setGroup(o.tabIds, gid);
          return gid;
        },
      ),
      ungroup: vi.fn(async (ids: number | number[]) => setGroup(ids, -1)),
    },
    tabGroups: {
      get: vi.fn(async (id: number) => {
        const g = groups.find((x) => x.id === id);
        if (!g) throw new Error(`No group ${id}`);
        return { ...g };
      }),
      query: vi.fn(async (q: { title?: string; windowId?: number }) =>
        groups
          .filter(
            (g) =>
              (q.title === undefined || g.title === q.title) &&
              (q.windowId === undefined || g.windowId === q.windowId),
          )
          .map((g) => ({ ...g })),
      ),
      update: vi.fn(
        async (id: number, props: { title?: string; color?: string }) => {
          const g = groups.find((x) => x.id === id);
          if (!g) throw new Error(`No group ${id}`);
          Object.assign(g, props);
          return { ...g };
        },
      ),
    },
    windows: {
      WINDOW_ID_NONE: -1,
      getLastFocused: vi.fn(async () => {
        const id =
          init.lastFocusedWindowId === undefined ? 1 : init.lastFocusedWindowId;
        if (id === null) throw new Error("No window");
        return { id };
      }),
    },
  };
  vi.stubGlobal("chrome", chrome);
  return { ...storage, tabs, groups, chrome };
}
