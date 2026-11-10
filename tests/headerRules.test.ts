import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyHeaderRules,
  buildDnrRules,
  hostPermissionFor,
  loadHeaderRules,
  saveHeaderRules,
  validateHeaderRule,
} from "../src/headerRules";
import type { HeaderRule } from "../src/types";
import { installChromeStorageFake } from "./chromeStorageFake";

function rule(overrides: Partial<HeaderRule> = {}): HeaderRule {
  return {
    id: "r1",
    enabled: true,
    matchPattern: "https://*.internal.example.com/*",
    header: "Authorization",
    operation: "set",
    value: "Bearer abc",
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("validateHeaderRule", () => {
  it("accepts a set rule", () => {
    expect(validateHeaderRule(rule())).toBeNull();
  });

  it("rejects an invalid match pattern", () => {
    expect(
      validateHeaderRule(rule({ matchPattern: "internal.example.com" })),
    ).toMatch(/match pattern/);
  });

  it("rejects a non-ASCII match pattern", () => {
    expect(
      validateHeaderRule(rule({ matchPattern: "https://bücher.de/*" })),
    ).toMatch(/ASCII/);
  });

  it("rejects header names that aren't HTTP tokens", () => {
    expect(validateHeaderRule(rule({ header: "" }))).toMatch(/header name/);
    expect(validateHeaderRule(rule({ header: "X Api Key" }))).toMatch(
      /header name/,
    );
  });

  it("requires a value unless removing", () => {
    expect(validateHeaderRule(rule({ value: "" }))).toMatch(/needs a value/);
    expect(
      validateHeaderRule(rule({ operation: "remove", value: "" })),
    ).toBeNull();
  });

  it("rejects line breaks in the value", () => {
    expect(validateHeaderRule(rule({ value: "a\r\nX-Evil: 1" }))).toMatch(
      /line breaks/,
    );
  });

  it("only allows append on headers Chrome can append to", () => {
    expect(validateHeaderRule(rule({ operation: "append" }))).toMatch(
      /can't append/,
    );
    expect(
      validateHeaderRule(
        rule({ operation: "append", header: "Cookie", value: "a=b" }),
      ),
    ).toBeNull();
  });
});

describe("hostPermissionFor", () => {
  it("widens the pattern to its whole origin", () => {
    expect(hostPermissionFor("https://*.example.com/api/*")).toBe(
      "https://*.example.com/*",
    );
    expect(hostPermissionFor("http://localhost:8080/")).toBe(
      "http://localhost:8080/*",
    );
  });

  it("returns null for an invalid pattern", () => {
    expect(hostPermissionFor("example.com")).toBeNull();
  });
});

describe("buildDnrRules", () => {
  it("skips disabled rules and numbers the rest from 1", () => {
    const built = buildDnrRules([
      rule({ id: "a", enabled: false }),
      rule({ id: "b" }),
      rule({ id: "c", header: "X-Team" }),
    ]);
    expect(built.map((r) => r.id)).toEqual([1, 2]);
    expect(built.map((r) => r.action.requestHeaders?.[0].header)).toEqual([
      "authorization",
      "x-team",
    ]);
  });

  it("applies to page loads as well as subresources", () => {
    const [built] = buildDnrRules([rule()]);
    expect(built.condition.resourceTypes).toContain("main_frame");
    expect(built.condition.resourceTypes).toContain("xmlhttprequest");
  });

  it("leaves the value off remove rules", () => {
    const [built] = buildDnrRules([rule({ operation: "remove" })]);
    expect(built.action.requestHeaders).toEqual([
      { header: "authorization", operation: "remove" },
    ]);
  });

  it("builds a regex that matches the same URLs as the pattern", () => {
    const [built] = buildDnrRules([rule()]);
    const re = new RegExp(built.condition.regexFilter ?? "");
    expect(re.test("https://app.internal.example.com/api/x?y=1")).toBe(true);
    expect(re.test("https://internal.example.com/")).toBe(true);
    expect(re.test("https://internal.example.com.evil.test/")).toBe(false);
    expect(re.test("http://app.internal.example.com/")).toBe(false);
  });
});

describe("applyHeaderRules", () => {
  it("replaces every existing dynamic rule", async () => {
    const updateDynamicRules = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", {
      declarativeNetRequest: {
        getDynamicRules: vi.fn().mockResolvedValue([{ id: 1 }, { id: 7 }]),
        updateDynamicRules,
      },
    });

    await applyHeaderRules([rule()]);

    expect(updateDynamicRules).toHaveBeenCalledWith({
      removeRuleIds: [1, 7],
      addRules: buildDnrRules([rule()]),
    });
  });
});

describe("header rule storage", () => {
  it("round-trips through local storage only", async () => {
    const storage = installChromeStorageFake();
    expect(await loadHeaderRules()).toEqual([]);

    await saveHeaderRules([rule()]);

    expect(await loadHeaderRules()).toEqual([rule()]);
    expect(storage.sync.data).toEqual({});
  });
});
