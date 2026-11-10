import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyHeaderRules,
  buildDnrRules,
  hostPermissionFor,
  loadHeaderRules,
  originsNeeded,
  saveHeaderRules,
  saveHeaderRulesWithAccess,
  validateHeaderRule,
} from "../src/headerRules";
import { matches } from "../src/matcher";
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

  it("only accepts http and https patterns", () => {
    expect(
      validateHeaderRule(rule({ matchPattern: "ftp://files.example.com/*" })),
    ).toMatch(/https:\/\/ or http:\/\//);
    expect(
      validateHeaderRule(rule({ matchPattern: "http://localhost:8080/*" })),
    ).toBeNull();
  });

  it.each([
    "https://internal.example.com*",
    "https://internal.*.com/*",
    "https://*internal.example.com/*",
    "https://*.example.*/*",
  ])("rejects a * inside the host: %s", (matchPattern) => {
    expect(validateHeaderRule(rule({ matchPattern }))).toMatch(
      /only use \* as the whole host/,
    );
  });

  it("accepts * as the whole host", () => {
    expect(
      validateHeaderRule(rule({ matchPattern: "https://*/*" })),
    ).toBeNull();
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

describe("originsNeeded", () => {
  it("lists each enabled rule's origin once", () => {
    expect(
      originsNeeded([
        rule({ matchPattern: "https://a.example.com/api/*" }),
        rule({ matchPattern: "https://a.example.com/other/*" }),
        rule({ matchPattern: "https://b.example.com/*", enabled: false }),
      ]),
    ).toEqual(["https://a.example.com/*"]);
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

  it("matches paths case-sensitively, like the rest of the extension", () => {
    const [built] = buildDnrRules([rule()]);
    expect(built.condition.isUrlFilterCaseSensitive).toBe(true);
  });

  const patterns = [
    "https://*.internal.example.com/*",
    "https://internal.example.com/api/*",
    "http://localhost:8080/*",
    "https://*/*",
    "https://example.com/",
  ];
  const urls = [
    "https://app.internal.example.com/api/x?y=1",
    "https://internal.example.com/",
    "https://internal.example.com/api/v1",
    "https://internal.example.com.evil.test/",
    "https://internal.example.com@evil.test/",
    "https://evil.test/?next=https://internal.example.com/",
    "http://app.internal.example.com/",
    "http://localhost:8080/x",
    "http://localhost:9090/x",
    "https://example.com/",
    "https://example.com/other",
  ];
  it.each(patterns)(
    "sends Chrome a regex that matches the same URLs as %s",
    (matchPattern) => {
      const [built] = buildDnrRules([rule({ matchPattern })]);
      const re = new RegExp(built.condition.regexFilter ?? "");
      for (const url of urls) {
        expect([url, re.test(url)]).toEqual([url, matches(url, matchPattern)]);
      }
    },
  );
});

/**
 * Chrome's declarativeNetRequest and permissions APIs, on top of the storage
 * fake. `answerPrompt` is what the user clicks in the access prompt.
 */
function installChromeFake(answerPrompt = true) {
  const storage = installChromeStorageFake();
  let dynamicRules: chrome.declarativeNetRequest.Rule[] = [];
  const granted = new Set<string>();
  const prompts: string[][] = [];
  let refuseNextUpdate: string | null = null;

  vi.stubGlobal("chrome", {
    storage,
    declarativeNetRequest: {
      async getDynamicRules() {
        return structuredClone(dynamicRules);
      },
      async updateDynamicRules({
        removeRuleIds = [],
        addRules = [],
      }: chrome.declarativeNetRequest.UpdateRuleOptions) {
        if (refuseNextUpdate) {
          const message = refuseNextUpdate;
          refuseNextUpdate = null;
          throw new Error(message);
        }
        const next = dynamicRules.filter((r) => !removeRuleIds.includes(r.id));
        for (const r of addRules) {
          if (next.some((n) => n.id === r.id)) {
            throw new Error(`Rule with id ${r.id} already exists.`);
          }
          next.push(structuredClone(r));
        }
        dynamicRules = next;
      },
    },
    permissions: {
      async request({ origins = [] }: chrome.permissions.Permissions) {
        prompts.push(origins);
        if (answerPrompt) for (const o of origins) granted.add(o);
        return answerPrompt;
      },
      async remove({ origins = [] }: chrome.permissions.Permissions) {
        for (const o of origins) granted.delete(o);
        return true;
      },
    },
  });

  return {
    storage,
    granted,
    prompts,
    dynamicRules: () => dynamicRules,
    refuseNextUpdate(message: string) {
      refuseNextUpdate = message;
    },
  };
}

describe("applyHeaderRules", () => {
  it("replaces the previous rules without id clashes", async () => {
    const chromeFake = installChromeFake();

    await applyHeaderRules([rule(), rule({ header: "X-Team" })]);
    await applyHeaderRules([rule({ header: "X-Other" })]);

    expect(
      chromeFake.dynamicRules().map((r) => r.action.requestHeaders?.[0].header),
    ).toEqual(["x-other"]);
  });

  it("clears every rule when none are enabled", async () => {
    const chromeFake = installChromeFake();
    await applyHeaderRules([rule()]);

    await applyHeaderRules([rule({ enabled: false })]);

    expect(chromeFake.dynamicRules()).toEqual([]);
  });
});

describe("saveHeaderRulesWithAccess", () => {
  it("asks for each site once, then applies and stores the rules", async () => {
    const chromeFake = installChromeFake();
    const rules = [
      rule({ matchPattern: "https://a.example.com/api/*" }),
      rule({ matchPattern: "https://a.example.com/v2/*", header: "X-Team" }),
    ];

    expect(await saveHeaderRulesWithAccess(rules)).toBeNull();

    expect(chromeFake.prompts).toEqual([["https://a.example.com/*"]]);
    expect(chromeFake.dynamicRules()).toHaveLength(2);
    expect(await loadHeaderRules()).toEqual(rules);
  });

  it("saves nothing when the user declines access", async () => {
    const chromeFake = installChromeFake(false);

    expect(await saveHeaderRulesWithAccess([rule()])).toMatch(/not granted/);

    expect(chromeFake.dynamicRules()).toEqual([]);
    expect(await loadHeaderRules()).toEqual([]);
  });

  it("keeps the previous rules when Chrome refuses the new ones", async () => {
    const chromeFake = installChromeFake();
    const previous = [rule()];
    await saveHeaderRulesWithAccess(previous);
    chromeFake.refuseNextUpdate("Regex is too large.");

    expect(await saveHeaderRulesWithAccess([rule({ header: "X-New" })])).toBe(
      "Regex is too large.",
    );

    expect(chromeFake.dynamicRules()).toEqual(buildDnrRules(previous));
    expect(await loadHeaderRules()).toEqual(previous);
  });

  it("doesn't prompt when no rule is enabled", async () => {
    const chromeFake = installChromeFake();

    expect(
      await saveHeaderRulesWithAccess([rule({ enabled: false })]),
    ).toBeNull();

    expect(chromeFake.prompts).toEqual([]);
  });

  it("gives back access that no rule needs any more", async () => {
    const chromeFake = installChromeFake();
    chromeFake.granted.add("https://unrelated.example.org/*");
    await saveHeaderRulesWithAccess([
      rule({ matchPattern: "https://a.example.com/*" }),
      rule({ matchPattern: "https://b.example.com/*" }),
    ]);

    await saveHeaderRulesWithAccess([
      rule({ matchPattern: "https://a.example.com/*" }),
      rule({ matchPattern: "https://b.example.com/*", enabled: false }),
    ]);

    expect([...chromeFake.granted].sort()).toEqual([
      "https://a.example.com/*",
      "https://unrelated.example.org/*",
    ]);
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
