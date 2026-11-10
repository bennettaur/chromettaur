import { isValidPattern, patternRegexSource } from "./matcher";
import type { HeaderRule } from "./types";

const HEADER_RULES_KEY = "headerRules";

// Header values often carry auth tokens, so the rules live in
// `chrome.storage.local` like the GitHub PAT: never synced, never exported.
export async function loadHeaderRules(): Promise<HeaderRule[]> {
  const r = await chrome.storage.local.get(HEADER_RULES_KEY);
  const v = r[HEADER_RULES_KEY];
  return Array.isArray(v) ? (v as HeaderRule[]) : [];
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

/** A user-facing error for the first problem with `rule`, or null. */
export function validateHeaderRule(rule: HeaderRule): string | null {
  const label = rule.header.trim() || "(unnamed header)";
  if (!isValidPattern(rule.matchPattern)) {
    return `Invalid match pattern for header "${label}".`;
  }
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
 * is invalid.
 */
export function hostPermissionFor(matchPattern: string): string | null {
  const m = /^([a-z*]+):\/\/([^/]*)/i.exec(matchPattern.trim());
  if (!m) return null;
  return `${m[1]}://${m[2]}/*`;
}

// Listed in full because leaving resourceTypes out skips main_frame, so the
// header would be missing from the page load itself.
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
  "websocket",
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
      condition: { regexFilter, resourceTypes: ALL_RESOURCE_TYPES },
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
