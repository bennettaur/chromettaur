import type { UniquenessRule } from "./types";

const RESTRICTED_SCHEMES = [
  "chrome:",
  "chrome-extension:",
  "about:",
  "devtools:",
  "edge:",
  "view-source:",
];

const WEB_STORE_HOSTS = new Set([
  "chrome.google.com",
  "chromewebstore.google.com",
]);

export function isRestrictedUrl(url: string | undefined | null): boolean {
  if (!url) return true;
  const lower = url.toLowerCase();
  for (const scheme of RESTRICTED_SCHEMES) {
    if (lower.startsWith(scheme)) return true;
  }
  try {
    const u = new URL(url);
    if (WEB_STORE_HOSTS.has(u.hostname) && u.pathname.startsWith("/webstore")) {
      return true;
    }
  } catch {
    return true;
  }
  return false;
}

function escapeRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\*]/g, "\\$&");
}

/**
 * Compile a Chrome match-pattern-like glob into a RegExp.
 *
 * Supported pattern shape: `<scheme>://<host>/<path>` where:
 *  - scheme is a literal scheme (https, http, file, ftp) or `*` (any scheme)
 *  - `*` in host means "any subdomain segment" (matches zero or more characters
 *    that do not contain `/`) — `*.atlassian.net` matches `foo.atlassian.net`
 *    AND `atlassian.net`.
 *  - `*` in path matches any character except newline.
 *
 * Fragment is ignored — patterns never match the `#...` portion.
 */
function compilePattern(pattern: string): RegExp {
  const match = /^([a-z*]+):\/\/([^/]*)(\/.*)?$/i.exec(pattern.trim());
  if (!match) {
    return /a^/;
  }
  const [, scheme, host, path = "/"] = match;

  let schemeRe: string;
  if (scheme === "*") {
    schemeRe = "https?";
  } else {
    schemeRe = escapeRegex(scheme);
  }

  let hostRe: string;
  if (host === "*") {
    hostRe = "[^/]+";
  } else if (host.startsWith("*.")) {
    const rest = escapeRegex(host.slice(2));
    hostRe = `(?:[^/]*\\.)?${rest}`;
  } else {
    hostRe = escapeRegex(host).replace(/\\\*/g, "[^/]*");
  }

  const pathRe = escapeRegex(path).replace(/\\\*/g, "[^\\n]*");

  return new RegExp(`^${schemeRe}://${hostRe}${pathRe}$`);
}

const patternCache = new Map<string, RegExp>();
function getPatternRegex(pattern: string): RegExp {
  let re = patternCache.get(pattern);
  if (!re) {
    re = compilePattern(pattern);
    patternCache.set(pattern, re);
  }
  return re;
}

function stripFragment(url: string): string {
  const i = url.indexOf("#");
  return i === -1 ? url : url.slice(0, i);
}

export function matches(url: string, pattern: string): boolean {
  if (isRestrictedUrl(url)) return false;
  if (!pattern) return false;
  try {
    const re = getPatternRegex(pattern);
    return re.test(stripFragment(url));
  } catch {
    return false;
  }
}

export function canonicalKey(
  url: string,
  rule: UniquenessRule,
): string | null {
  if (isRestrictedUrl(url)) return null;
  if (!matches(url, rule.matchPattern)) return null;

  switch (rule.keyStrategy) {
    case "exact":
      return stripFragment(url);

    case "ignoreFragment":
      return stripFragment(url);

    case "ignoreQuery": {
      try {
        const u = new URL(url);
        return `${u.origin}${u.pathname}`;
      } catch {
        return null;
      }
    }

    case "regexCapture": {
      if (!rule.keyRegex) return null;
      try {
        const re = new RegExp(rule.keyRegex);
        const m = re.exec(stripFragment(url));
        return m && m[1] != null ? m[1] : null;
      } catch {
        return null;
      }
    }

    default:
      return null;
  }
}

export function isValidPattern(pattern: string): boolean {
  return /^([a-z*]+):\/\/([^/]*)(\/.*)?$/i.test(pattern.trim());
}

export function isValidRegex(re: string): boolean {
  try {
    new RegExp(re);
    return true;
  } catch {
    return false;
  }
}
