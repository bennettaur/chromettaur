# Chromettaur

A Manifest V3 Chrome extension that adds Arc-like tab behaviors to Chrome:

1. **Auto-close inactive tabs** *(opt-in)* — close (or discard) tabs idle past
   a configurable threshold, with protections and a recently-closed restore
   list.
2. **Tab uniqueness** — for configured URL patterns (default: GitHub PR pages),
   prevent duplicate tabs by focusing the existing tab and closing the new one.
3. **Auto-group by URL** — automatically place tabs into named, colored tab
   groups (defaults: GitHub → grey "GitHub", `*.atlassian.net` → blue "Jira").
4. **GitHub PR status grouping** *(opt-in)* — periodically asks the GitHub API
   for the status of each open PR tab and places it into a colored group:
   `PR: Draft` / `Ready` / `Blocked` / `Merged` / `Closed`. Optional PAT to
   raise the API rate limit.
5. **GitHub repo switcher** — **Alt+Shift+G** opens a search box in the
   toolbar popup. Type part of a repo name, press Enter, and the repo opens
   in a new tab. Tab fills in the highlighted repo; add `#123` to open that
   pull request instead (a bare `#` opens the repo's pull request list).
   `#123` on its own opens that PR in the repo you visited most recently.
   Lists repos from an allowlist of owners (default: `wealthsimple`,
   `bennettaur`).
6. **Recent tabs** — **Alt+Shift+H** lists open tabs in the order you last
   viewed them, across windows. Enter jumps to the selected tab; the tab you
   were on before the current one is selected by default.

The extension is loaded **unpacked** for personal use; there is no Web Store
distribution, no content scripts, and no host permissions. PR status grouping
and the repo switcher call the GitHub API (see *A note on network access*).

---

## Prerequisites (macOS)

- **Chrome 149** (this is the version the extension is targeted at).
- **Node.js 20.x or newer.** Recommended via `mise`, `nvm`, or Homebrew (`brew
  install node`).
- **pnpm.** Easiest install path:

  ```bash
  corepack enable
  corepack prepare pnpm@latest --activate
  ```

  If `corepack` cannot create symlinks under your Node install (e.g. when using
  `mise`), use `npm install -g pnpm` instead, or install via Homebrew with
  `brew install pnpm`.

Verify:

```bash
node --version    # v20.x or newer
pnpm --version    # 9.x or 10.x
```

---

## Install & build

From the project root:

```bash
pnpm install              # one-time
pnpm test                 # runs unit tests (Vitest)
pnpm build                # production build → dist/chrome-mv3
```

For active development with auto-reload:

```bash
pnpm dev
```

`pnpm dev` launches Chrome with the extension auto-loaded (WXT handles the
manifest, bundling, and HMR). When background-worker code changes, WXT reloads
the extension automatically.

---

## Load the built extension into your day-to-day Chrome

If you don't want WXT's dev-launched Chrome and want this extension running in
your normal browser permanently:

1. Run `pnpm build`. Output lands in `./dist/chrome-mv3`.
2. Open `chrome://extensions`.
3. Toggle **Developer mode** on (top-right).
4. Click **Load unpacked** and select the `dist/chrome-mv3` directory.
5. The extension appears as **Chromettaur**. Pin it to the toolbar for quick popup
   access.

Chrome will prompt with a single permission notice ("Read your browsing
history") — that is the standard text for the `tabs` permission. The extension
does **not** read browsing history; it only inspects URLs and titles of open
tabs.

> Chrome will prompt you on each launch to keep developer extensions enabled —
> this is normal for unpacked extensions and cannot be disabled.

When you rebuild (`pnpm build`), return to `chrome://extensions` and click the
refresh / reload icon on the Chromettaur card to pick up the new build.

### Testing a dev copy next to your installed build

`pnpm build:dev` writes to `./dist/chrome-mv3-local-dev` and names the
extension **Chromettaur (dev)**. Load that folder unpacked as well. Chrome
derives an unpacked extension's ID from its folder, so the dev copy gets its
own settings, tab history and repo cache.

Both copies act on the same tabs. While testing, turn off tab uniqueness and
auto-group in one of them so they don't both dedupe and group. Keyboard
shortcuts bind to whichever copy claimed them first; reassign them at
`chrome://extensions/shortcuts`.

---

## Configuration

Open the options page from the popup → **Settings…**, or right-click the
toolbar icon → **Options**. Each feature has its own section:

- **Auto-close** — idle minutes, sweep interval, min tabs to keep open,
  close-vs-discard, per-protection toggles, allowlist patterns.
- **Tab uniqueness** — enable/disable, edit/remove/add rules. Each rule has a
  name, a URL match pattern, and a key strategy (`exact`, `ignoreFragment`,
  `ignoreQuery`, or `regexCapture` with a regex whose first capture group is
  the dedup key).
- **Auto-group** — enable/disable, "respect user moves" toggle, edit/remove/add
  rules (group title, color, URL match pattern).
- **GitHub PR status grouping** — enable/disable, poll interval, optional
  GitHub PAT (also used by the repo switcher).
- **Keyboard shortcuts** — the GitHub owners the repo switcher lists, and a
  button to refresh the cached repo list.

Both shortcuts can be changed at `chrome://extensions/shortcuts`. Chrome only
applies a suggested shortcut if nothing else already uses it, so check that
page if a shortcut does nothing after install.

The repo switcher keeps a cache of each owner's repos from the GitHub API,
refreshed daily (archived repos are skipped). Repos you visit under an
allowlisted owner are added too, and recent visits rank higher in results.
Private repos only show up from the API if the GitHub PAT can read them: a
fine-grained PAT covers a single owner, so use a classic PAT with `repo`
scope (SSO-authorized for orgs that need it) to cover several.

Match patterns follow Chrome's `<scheme>://<host>/<path>` shape with `*`
wildcards (e.g. `https://github.com/*/*/pull/*`, `https://*.atlassian.net/*`).

**Export settings** / **Import settings…** in the options footer save and
load all settings as a JSON file. An import is validated like a manual save
and saved immediately. The GitHub PAT is never included in an export.

Settings are stored in `chrome.storage.sync` (so they roam with your Chrome
profile). Runtime bookkeeping (managed tabs, user overrides, recently-closed
list), the repo switcher's cached repo lists, and up to 500 recently visited
repos under allowlisted owners live in `chrome.storage.local`. Incognito
visits are not recorded. Recent-tab order lives in `chrome.storage.session`,
which Chrome clears on restart, so right after a restart the order falls back
to Chrome's own last-accessed times. The optional GitHub PAT is stored only
in `chrome.storage.local` (never synced).

### A note on network access

Features 1–3 and recent tabs make no external network calls. **PR status
grouping and the repo switcher talk to `https://api.github.com/`** to read PR
metadata and repo lists. PR status grouping is opt-in; the repo switcher
fetches its default owners as soon as the extension is installed. Neither
needs `host_permissions` (an extension service worker can `fetch()` any
origin) or content scripts. Disable PR status grouping and remove every repo
switcher owner in Options if you don't want the extension making any outbound
traffic.

---

## Acceptance checklist

These should all pass on Chrome 149 after a fresh build and load.

### Feature 2 — auto-close

- [ ] Disabled by default on a fresh install. Enable it in **Options →
      Auto-close inactive tabs** or the popup toggle.
- [ ] Set idle to 1 min, sweep to 0.5 min, min tabs to 2. Open 5 tabs, leave
      them; within ~2 min the inactive ones close down to 2, oldest-first.
- [ ] The active tab is never closed.
- [ ] A pinned tab, an audible tab (e.g. a playing video), and an allowlisted
      URL are never closed.
- [ ] With `action: "discard"`, tabs are discarded (greyed, reload on click),
      not removed, and nothing is added to the recently-closed list.
- [ ] Closed tabs appear in the popup's recently-closed list and **Restore**
      reopens them.
- [ ] Kill the service worker (DevTools → Application → Service Workers →
      Stop), wait past the interval — the sweep still fires (the alarm
      re-wakes the worker). The alarm still exists after a browser restart.

### Feature 3 — uniqueness

- [ ] Open a GitHub PR. Open the same PR again (paste URL / click a link) →
      the new tab closes and the original is focused.
- [ ] Open the PR's `/files` and `/commits` sub-views of the same PR → they
      collapse to the one PR tab (regex-capture key).
- [ ] Two *different* PRs stay as two tabs.
- [ ] Non-configured URLs are never deduped (open two of the same random site
      → both stay).
- [ ] Focus lands on the kept tab and its window is raised on macOS.

### Feature 4 — auto-group

- [ ] Navigate to a github.com page → tab joins a grey **GitHub** group
      (created if absent).
- [ ] Navigate to a `*.atlassian.net` page → tab joins a blue **Jira** group.
- [ ] Manually drag a GitHub tab into another group → it is **not** yanked
      back on the next github navigation (with `respectUserOverride` true).
- [ ] Manually pull a GitHub tab out to ungrouped → it stays ungrouped
      (override recorded); navigating it to a *different* matching rule
      re-enables grouping.
- [ ] No group thrashing / flicker on a single navigation (debounce works).

### Feature 5 — GitHub PR status grouping

- [ ] Disabled by default. Enable it in **Options → GitHub PR status grouping**.
- [ ] Open a draft PR → tab joins a grey **PR: Draft** group within one poll
      cycle.
- [ ] Mark the PR ready for review → on the next poll the tab moves to the
      green **PR: Ready** group.
- [ ] CI fails on the PR (or a required reviewer requests changes) → tab moves
      to the red **PR: Blocked** group.
- [ ] Merge the PR → tab moves to the purple **PR: Merged** group.
- [ ] Without a PAT, fewer than ~12 PRs are polled per hour without hitting the
      60 req/hr unauth limit. Paste a PAT in options and the limit becomes
      5,000 req/hr.
- [ ] Manually drag a PR tab into another group → it is not yanked back
      (`userOverride` respected, same as Feature 4).
- [ ] PR URLs never end up in the generic "GitHub" group while PR status is
      enabled.

### GitHub repo switcher

- [ ] Alt+Shift+G opens the popup with a focused search box.
- [ ] Typing `yarvis` puts `wealthsimple/yarvis` first; Enter opens it in a
      new tab and closes the popup.
- [ ] Tab fills the search box with the highlighted `owner/name`.
- [ ] `yarvis#12` (typed or after Tab) opens `wealthsimple/yarvis/pull/12`;
      `yarvis#` opens its pull request list.
- [ ] Arrow keys move the selection; Escape closes the popup.
- [ ] Clicking the toolbar icon afterwards still shows the regular popup.
- [ ] Visiting a repo under an allowlisted owner that the API didn't return
      makes it show up in the switcher.
- [ ] **Refresh repo list now** in Options reports the cached repo count.

### Recent tabs

- [ ] Switch between three tabs (including one in another window), then
      Alt+Shift+H lists them most recent first, without the current tab.
- [ ] Enter on the first entry jumps back to the previous tab.
- [ ] Typing filters by title and URL.
- [ ] Closed tabs disappear from the list.

### General / lifecycle

- [ ] `chrome://`, web store, and `about:` tabs are never touched by any
      feature.
- [ ] Stale `managed`/`userOverride` entries are pruned after a browser
      restart.
- [ ] No errors in the service worker console during normal use.
- [ ] Unit tests pass (`pnpm test`).

---

## Troubleshooting

- **Service worker shows as inactive** in `chrome://extensions` → this is
  normal. The worker wakes on alarms and tab events.
- **Sweep doesn't run** → verify the alarm exists at
  `chrome://extensions/?id=<id>` → **Service worker** → DevTools → run
  `chrome.alarms.getAll()`.
- **Auto-group didn't fire on the first navigation** → the `tabs.onUpdated`
  handler only runs when `changeInfo.url` is set. A tab opened to `about:blank`
  won't be grouped until it navigates to a URL the matchers see.
- **A tab won't auto-group** → it may be in the `userOverride` list. Trigger a
  navigation to a URL that matches a *different* auto-group rule to clear the
  override, or close and re-open the tab.
