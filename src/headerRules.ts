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
  // Chrome only accepts `*` as the whole host or a leading `*.`. Anything
  // else, like `example.*`, would also match hosts the user doesn't own.
  const hostRest = parsed.host.startsWith("*.")
    ? parsed.host.slice(2)
    : parsed.host;
  if (parsed.host !== "*" && hostRest.includes("*")) {
    return `Match pattern for header "${label}" can only use * as the whole host or at the start, as in *.example.com.`;
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
  return parsed ? `${parsed.scheme}://${parsed.host}/*` : null;
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

// Leaving resourceTypes out skips main_frame, so the header would be missing
// from the page load itself. websocket is left out because the http(s) URL
// regex can never match a ws:// or wss:// URL.
const ALL_RESOURCE_TYPES = [
  "main_frame",
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
] as chrome.declarativeNetRequest.ResourceType[];

/** Turns the enabled rules into declarativeNetRequest dynamic rules. */
export function buildDnrRules(
  rules: HeaderRule[],
): chrome.declarativeNetRequest.Rule[] {
  const out: chrome.declarativeNetRequest.Rule[] = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const regexFilter = patternRegexSource(rule.matchPattern);
    // Unreachable for validated rules; guards against hand-edited storage.
    if (regexFilter === null) continue;
    const operation =
      rule.operation as chrome.declarativeNetRequest.HeaderOperation;
    out.push({
      // Dynamic rule IDs must be positive integers.
      id: out.length + 1,
      priority: 1,
      action: {
        type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
        requestHeaders: [
          {
            header: rule.header.trim().toLowerCase(),
            operation,
            ...(rule.operation === "remove" ? {} : { value: rule.value }),
          },
        ],
      },
      condition: {
        regexFilter,
        // Match paths the same way `matches` does elsewhere in the extension.
        isUrlFilterCaseSensitive: true,
        resourceTypes: ALL_RESOURCE_TYPES,
      },
    });
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
    const unused = originsNeeded(previous).filter((o) => !needed.includes(o));
    if (unused.length > 0) {
      // The rules are already saved; leftover access isn't worth failing for.
      await chrome.permissions.remove({ origins: unused }).catch(() => {});
    }
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return null;
}
