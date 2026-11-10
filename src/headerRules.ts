import { parsePattern, patternRegexSource } from "./matcher";
import type { HeaderRule } from "./types";

// Header values often carry auth tokens, so the rules live in
// `chrome.storage.local` like the GitHub PAT: never synced, never exported.
const HEADER_RULES_KEY = "headerRules";

export async function loadHeaderRules(): Promise<HeaderRule[]> {
  const stored = await chrome.storage.local.get(HEADER_RULES_KEY);
  const rules = stored[HEADER_RULES_KEY];
  return Array.isArray(rules) ? (rules as HeaderRule[]) : [];
}

export async function saveHeaderRules(rules: HeaderRule[]): Promise<void> {
  await chrome.storage.local.set({ [HEADER_RULES_KEY]: rules });
}

// Chrome only allows "append" on these request headers, and the check is
// case-sensitive, so the rule's header name is lowercased before it's sent.
const APPENDABLE_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "access-control-request-headers",
  "cache-control",
  "connection",
  "content-language",
  "cookie",
  "forwarded",
  "if-match",
  "if-none-match",
  "keep-alive",
  "range",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "user-agent",
  "via",
  "want-digest",
  "x-forwarded-for",
]);

// RFC 9110 token characters.
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

// Only http and https: the extension's optional host permission covers no
// other scheme, so Chrome would refuse the access request.
const HEADER_RULE_SCHEMES = new Set(["http", "https"]);

/** A user-facing error for the first problem with `rule`, or null. */
export function validateHeaderRule(rule: HeaderRule): string | null {
  const label = rule.header.trim() || "(unnamed header)";
  const parsed = parsePattern(rule.matchPattern);
  if (!parsed) return `Invalid match pattern for header "${label}".`;
  if (!HEADER_RULE_SCHEMES.has(parsed.scheme.toLowerCase())) {
    return `Match pattern for header "${label}" must start with https:// or http://.`;
  }
  if (parsed.host === "*") {
    return `Match pattern for header "${label}" must name a host. * would send the header to every site.`;
  }
  // A plain host, optionally with a leading `*.` and a port. This rejects a
  // `*` anywhere else (e.g. `example.*`) and userinfo like `a.com@b.com`,
  // both of which would match hosts the user doesn't own.
  if (!/^(\*\.)?[a-z0-9.-]+(:\d+)?$/i.test(parsed.host)) {
    return `Match pattern for header "${label}" has an invalid host. Use a name like internal.example.com or *.example.com.`;
  }
  // declarativeNetRequest only accepts ASCII in a rule's URL regex.
  if (!/^[\x20-\x7e]*$/.test(rule.matchPattern)) {
    return `Match pattern for header "${label}" must be plain ASCII.`;
  }
  if (!HEADER_NAME_RE.test(rule.header.trim())) {
    return `Invalid header name "${label}".`;
  }
  if (
    rule.operation === "append" &&
    !APPENDABLE_HEADERS.has(rule.header.trim().toLowerCase())
  ) {
    return `Chrome can't append to "${label}". Use "set" instead.`;
  }
  if (rule.operation !== "remove") {
    if (rule.value === "") return `Header "${label}" needs a value.`;
    if (/[\r\n]/.test(rule.value)) {
      return `Value for header "${label}" can't contain line breaks.`;
    }
  }
  return null;
}

/**
 * The host permission a rule needs, as a Chrome match pattern covering the
 * rule's whole origin (e.g. `https://*.example.com/*`). Null if the pattern
 * can't be parsed.
 */
export function hostPermissionFor(matchPattern: string): string | null {
  const parsed = parsePattern(matchPattern);
  if (!parsed) return null;
  return `${parsed.scheme.toLowerCase()}://${parsed.host.toLowerCase()}/*`;
}

/**
 * The pattern with its scheme and host lowercased, since Chrome sees URLs
 * that way and the rule's URL regex is case-sensitive.
 */
function normalizedPattern(matchPattern: string): string {
  const parsed = parsePattern(matchPattern);
  if (!parsed) return matchPattern;
  return `${parsed.scheme.toLowerCase()}://${parsed.host.toLowerCase()}${parsed.path}`;
}

/**
 * True when access to origin `broad` includes origin `narrow`, so removing
 * `broad` would also take `narrow` away. Both come from `hostPermissionFor`.
 */
function originCovers(broad: string, narrow: string): boolean {
  const b = parsePattern(broad);
  const n = parsePattern(narrow);
  if (!b || !n || b.scheme !== n.scheme) return false;
  const [broadHost, broadPort] = b.host.split(":");
  const [narrowHost, narrowPort] = n.host.split(":");
  // A host with no port covers every port.
  if (broadPort !== undefined && broadPort !== narrowPort) return false;
  if (!broadHost.startsWith("*.")) return broadHost === narrowHost;
  const base = broadHost.slice(2);
  const target = narrowHost.replace(/^\*\./, "");
  return target === base || target.endsWith(`.${base}`);
}

/** The distinct host permissions the enabled rules need. */
export function originsNeeded(rules: HeaderRule[]): string[] {
  const origins = new Set<string>();
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const origin = hostPermissionFor(rule.matchPattern);
    if (origin) origins.add(origin);
  }
  return [...origins];
}

type ResourceType = chrome.declarativeNetRequest.ResourceType;
type RequestMethod = chrome.declarativeNetRequest.RequestMethod;

// Every type except main_frame, which gets its own conditions below.
// websocket is left out because the http(s) URL regex can never match a
// ws:// or wss:// URL.
const SUBRESOURCE_TYPES = [
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "xmlhttprequest",
  "ping",
  "csp_report",
  "media",
  "other",
] as ResourceType[];

const SAFE_METHODS = ["get", "head"] as RequestMethod[];
const FIRST_PARTY = "firstParty" as chrome.declarativeNetRequest.DomainType;

/**
 * The conditions a header is sent under, modeled on SameSite=Lax cookies so
 * other sites can't make requests that carry the header:
 * - page loads by GET or HEAD from anywhere, so typed URLs, bookmarks and
 *   links from other sites work;
 * - any other page load, and every subresource, only when started by a page
 *   on the same registrable domain (e.g. app.example.com to api.example.com).
 * The three never overlap, so an "append" header is only added once.
 */
const CONDITIONS: Omit<
  chrome.declarativeNetRequest.RuleCondition,
  "regexFilter"
>[] = [
  {
    resourceTypes: ["main_frame" as ResourceType],
    requestMethods: SAFE_METHODS,
  },
  {
    resourceTypes: ["main_frame" as ResourceType],
    excludedRequestMethods: SAFE_METHODS,
    domainType: FIRST_PARTY,
  },
  { resourceTypes: SUBRESOURCE_TYPES, domainType: FIRST_PARTY },
];

/** Turns the enabled rules into declarativeNetRequest dynamic rules. */
export function buildDnrRules(
  rules: HeaderRule[],
): chrome.declarativeNetRequest.Rule[] {
  const out: chrome.declarativeNetRequest.Rule[] = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const regexFilter = patternRegexSource(
      normalizedPattern(rule.matchPattern),
    );
    // Unreachable for validated rules; guards against hand-edited storage.
    if (regexFilter === null) continue;
    const requestHeader: chrome.declarativeNetRequest.ModifyHeaderInfo = {
      header: rule.header.trim().toLowerCase(),
      operation: rule.operation as chrome.declarativeNetRequest.HeaderOperation,
      ...(rule.operation === "remove" ? {} : { value: rule.value }),
    };
    for (const condition of CONDITIONS) {
      out.push({
        // Dynamic rule IDs must be positive integers.
        id: out.length + 1,
        priority: 1,
        action: {
          type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
          requestHeaders: [requestHeader],
        },
        condition: {
          ...condition,
          regexFilter,
          // Match paths the same way `matches` does elsewhere in the extension.
          isUrlFilterCaseSensitive: true,
        },
      });
    }
  }
  return out;
}

/**
 * Replaces every dynamic rule with ones built from `rules`. Chromettaur owns
 * all of its dynamic rules, so nothing else is lost. Rejects with Chrome's
 * error if a rule is refused (e.g. a match pattern compiles to a regex that
 * is too large), leaving the previous rules in place.
 */
export async function applyHeaderRules(rules: HeaderRule[]): Promise<void> {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules: buildDnrRules(rules),
  });
}

/**
 * Asks Chrome for access to each enabled rule's site, applies the rules, then
 * stores them. Access no rule needs any more is given back. Returns a
 * user-facing error, or null on success.
 *
 * Must be called straight from a click handler with nothing awaited first:
 * Chrome only shows the permission prompt in response to a user gesture.
 */
export async function saveHeaderRulesWithAccess(
  rules: HeaderRule[],
): Promise<string | null> {
  const needed = originsNeeded(rules);
  try {
    if (needed.length > 0) {
      const granted = await chrome.permissions.request({ origins: needed });
      if (!granted) return "Site access was not granted.";
    }
    const previous = await loadHeaderRules();
    // Applied before storing so storage never holds rules Chrome refused.
    await applyHeaderRules(rules);
    await saveHeaderRules(rules);
    // Only origins this feature asked for before, so nothing granted for
    // another reason is taken away.
    const unused = originsNeeded(previous).filter(
      (o) => !needed.some((n) => originCovers(o, n)),
    );
    if (unused.length > 0) {
      // The rules are already saved; leftover access isn't worth failing for.
      await chrome.permissions.remove({ origins: unused }).catch(() => {});
    }
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return null;
}
