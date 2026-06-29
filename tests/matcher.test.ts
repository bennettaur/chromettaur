import { describe, it, expect } from "vitest";
import {
  matches,
  canonicalKey,
  isRestrictedUrl,
  isValidPattern,
  isValidRegex,
} from "../src/matcher";
import type { UniquenessRule } from "../src/types";

const githubPrRule: UniquenessRule = {
  id: "github-pr",
  name: "GitHub PRs",
  matchPattern: "https://github.com/*/*/pull/*",
  keyStrategy: "regexCapture",
  keyRegex: "^https://github\\.com/([^/]+/[^/]+/pull/\\d+)",
};

describe("isRestrictedUrl", () => {
  it("rejects restricted schemes", () => {
    expect(isRestrictedUrl("chrome://settings")).toBe(true);
    expect(isRestrictedUrl("chrome-extension://abc/foo.html")).toBe(true);
    expect(isRestrictedUrl("about:blank")).toBe(true);
    expect(isRestrictedUrl("devtools://devtools/bundled/foo")).toBe(true);
    expect(isRestrictedUrl("edge://settings")).toBe(true);
    expect(isRestrictedUrl("view-source:https://foo")).toBe(true);
  });

  it("rejects the chrome web store", () => {
    expect(
      isRestrictedUrl("https://chrome.google.com/webstore/category/extensions"),
    ).toBe(true);
    expect(
      isRestrictedUrl("https://chromewebstore.google.com/webstore/detail/foo"),
    ).toBe(true);
  });

  it("accepts normal URLs", () => {
    expect(isRestrictedUrl("https://github.com/foo/bar")).toBe(false);
    expect(isRestrictedUrl("https://example.com")).toBe(false);
  });

  it("rejects empty / nullish input", () => {
    expect(isRestrictedUrl("")).toBe(true);
    expect(isRestrictedUrl(undefined)).toBe(true);
    expect(isRestrictedUrl(null)).toBe(true);
  });

  it("rejects malformed URLs", () => {
    expect(isRestrictedUrl("not a url")).toBe(true);
  });
});

describe("matches", () => {
  it("matches a literal host and glob path", () => {
    expect(matches("https://github.com/foo", "https://github.com/*")).toBe(true);
    expect(matches("https://github.com/foo/bar/pull/123", "https://github.com/*/*/pull/*"))
      .toBe(true);
  });

  it("does not match when the path is too short", () => {
    expect(matches("https://github.com/foo", "https://github.com/*/*/pull/*"))
      .toBe(false);
  });

  it("matches subdomain wildcards including bare apex", () => {
    expect(matches("https://foo.atlassian.net/x", "https://*.atlassian.net/*"))
      .toBe(true);
    expect(matches("https://wealthsimple.atlassian.net/browse/ABC-1", "https://*.atlassian.net/*"))
      .toBe(true);
    expect(matches("https://atlassian.net/x", "https://*.atlassian.net/*"))
      .toBe(true);
  });

  it("does not match different hosts", () => {
    expect(matches("https://gitlab.com/foo", "https://github.com/*")).toBe(false);
    expect(matches("https://atlassiannet.com/x", "https://*.atlassian.net/*"))
      .toBe(false);
  });

  it("ignores the URL fragment", () => {
    expect(
      matches(
        "https://github.com/a/b/pull/1#issuecomment-99",
        "https://github.com/*/*/pull/*",
      ),
    ).toBe(true);
  });

  it("rejects restricted schemes regardless of pattern", () => {
    expect(matches("chrome://settings", "chrome://*")).toBe(false);
  });

  it("returns false for empty patterns and malformed regex shapes", () => {
    expect(matches("https://github.com/foo", "")).toBe(false);
  });
});

describe("canonicalKey", () => {
  it("collapses PR sub-views to one key (regexCapture)", () => {
    const base = canonicalKey(
      "https://github.com/foo/bar/pull/42",
      githubPrRule,
    );
    expect(base).toBe("foo/bar/pull/42");
    expect(canonicalKey("https://github.com/foo/bar/pull/42/files", githubPrRule))
      .toBe("foo/bar/pull/42");
    expect(canonicalKey("https://github.com/foo/bar/pull/42/commits", githubPrRule))
      .toBe("foo/bar/pull/42");
    expect(
      canonicalKey(
        "https://github.com/foo/bar/pull/42#issuecomment-99",
        githubPrRule,
      ),
    ).toBe("foo/bar/pull/42");
  });

  it("returns distinct keys for distinct PRs", () => {
    expect(canonicalKey("https://github.com/foo/bar/pull/1", githubPrRule)).toBe(
      "foo/bar/pull/1",
    );
    expect(canonicalKey("https://github.com/foo/bar/pull/2", githubPrRule)).toBe(
      "foo/bar/pull/2",
    );
  });

  it("returns null when URL is outside the rule's match pattern", () => {
    expect(canonicalKey("https://github.com/foo/bar", githubPrRule)).toBe(null);
    expect(canonicalKey("https://example.com/foo", githubPrRule)).toBe(null);
  });

  it("returns null for restricted URLs", () => {
    expect(canonicalKey("chrome://settings", githubPrRule)).toBe(null);
  });

  it("returns null when regexCapture rule has no keyRegex", () => {
    const rule: UniquenessRule = {
      id: "x",
      name: "x",
      matchPattern: "https://example.com/*",
      keyStrategy: "regexCapture",
    };
    expect(canonicalKey("https://example.com/foo", rule)).toBe(null);
  });

  it("returns null when keyRegex has no capture group match", () => {
    const rule: UniquenessRule = {
      id: "x",
      name: "x",
      matchPattern: "https://example.com/*",
      keyStrategy: "regexCapture",
      keyRegex: "^https://example\\.com/(no-match-here)$",
    };
    expect(canonicalKey("https://example.com/foo", rule)).toBe(null);
  });

  it("exact strategy strips fragment", () => {
    const rule: UniquenessRule = {
      id: "x",
      name: "x",
      matchPattern: "https://example.com/*",
      keyStrategy: "exact",
    };
    expect(canonicalKey("https://example.com/a?b=1#frag", rule)).toBe(
      "https://example.com/a?b=1",
    );
  });

  it("ignoreFragment strategy strips fragment", () => {
    const rule: UniquenessRule = {
      id: "x",
      name: "x",
      matchPattern: "https://example.com/*",
      keyStrategy: "ignoreFragment",
    };
    expect(canonicalKey("https://example.com/a?b=1#frag", rule)).toBe(
      "https://example.com/a?b=1",
    );
  });

  it("ignoreQuery strategy returns origin + pathname", () => {
    const rule: UniquenessRule = {
      id: "x",
      name: "x",
      matchPattern: "https://example.com/*",
      keyStrategy: "ignoreQuery",
    };
    expect(canonicalKey("https://example.com/a?b=1&c=2#frag", rule)).toBe(
      "https://example.com/a",
    );
    expect(canonicalKey("https://example.com/a/b", rule)).toBe(
      "https://example.com/a/b",
    );
  });
});

describe("isValidPattern", () => {
  it("accepts well-formed patterns", () => {
    expect(isValidPattern("https://github.com/*")).toBe(true);
    expect(isValidPattern("https://*.atlassian.net/*")).toBe(true);
    expect(isValidPattern("https://github.com/*/*/pull/*")).toBe(true);
  });

  it("rejects malformed patterns", () => {
    expect(isValidPattern("not-a-pattern")).toBe(false);
    expect(isValidPattern("")).toBe(false);
  });
});

describe("isValidRegex", () => {
  it("accepts valid regex", () => {
    expect(isValidRegex("^foo$")).toBe(true);
    expect(isValidRegex("^https://github\\.com/([^/]+)")).toBe(true);
  });

  it("rejects invalid regex", () => {
    expect(isValidRegex("([")).toBe(false);
  });
});
