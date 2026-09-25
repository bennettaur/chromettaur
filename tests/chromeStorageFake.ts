import { vi } from "vitest";

export interface FakeStorageArea {
  data: Record<string, unknown>;
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

// Each call yields before touching data, so unserialized read-modify-write
// cycles can interleave the way they do against real chrome.storage.
function fakeArea(): FakeStorageArea {
  const data: Record<string, unknown> = {};
  return {
    data,
    async get(key) {
      await Promise.resolve();
      return key in data ? { [key]: structuredClone(data[key]) } : {};
    },
    async set(items) {
      await Promise.resolve();
      Object.assign(data, structuredClone(items));
    },
    async remove(key) {
      await Promise.resolve();
      delete data[key];
    },
  };
}

/** Stub the global `chrome` with in-memory local, sync and session storage. */
export function installChromeStorageFake() {
  const storage = {
    local: fakeArea(),
    sync: fakeArea(),
    session: fakeArea(),
  };
  vi.stubGlobal("chrome", { storage });
  return storage;
}
