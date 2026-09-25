import {
  loadRepoCandidates,
  refreshRepoCache,
  type RepoCandidates,
} from "../../src/repoCache";
import {
  parseRepoQuery,
  rankRepos,
  repoPageUrl,
  type RepoEntry,
} from "../../src/repoSearch";
import {
  filterTabs,
  loadTabHistory,
  orderTabsByHistory,
} from "../../src/tabHistory";

const MAX_RESULTS = 50;

interface PaletteItem {
  title: string;
  detail: string;
  iconUrl?: string;
  /** Text that Tab puts in the search box. */
  completion?: string;
  open: () => Promise<void>;
}

interface PaletteSource {
  placeholder: string;
  emptyText: string;
  search: (query: string) => PaletteItem[];
}

let activeSource: PaletteSource | null = null;
let items: PaletteItem[] = [];
let selectedIndex = 0;

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

function renderResults(): void {
  const list = $<HTMLUListElement>("palette-results");
  const empty = $<HTMLParagraphElement>("palette-empty");
  list.innerHTML = "";
  empty.hidden = items.length > 0;
  empty.textContent = activeSource?.emptyText ?? "";

  items.forEach((item, idx) => {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.classList.toggle("selected", idx === selectedIndex);

    if (item.iconUrl) {
      const icon = document.createElement("img");
      icon.src = item.iconUrl;
      icon.alt = "";
      icon.addEventListener("error", () => (icon.style.visibility = "hidden"));
      li.append(icon);
    }

    const text = document.createElement("div");
    text.className = "item-text";
    const title = document.createElement("span");
    title.className = "item-title";
    title.textContent = item.title;
    const detail = document.createElement("span");
    detail.className = "item-detail";
    detail.textContent = item.detail;
    text.append(title, detail);
    li.append(text);

    li.addEventListener("click", () => void openItem(item));
    list.append(li);
  });

  list.children[selectedIndex]?.scrollIntoView({ block: "nearest" });
}

function runSearch(): void {
  const query = $<HTMLInputElement>("palette-query").value;
  items = activeSource ? activeSource.search(query) : [];
  selectedIndex = 0;
  renderResults();
}

function setSource(next: PaletteSource): void {
  activeSource = next;
  $<HTMLInputElement>("palette-query").placeholder = next.placeholder;
  runSearch();
}

async function openItem(item: PaletteItem): Promise<void> {
  try {
    await item.open();
  } finally {
    window.close();
  }
}

function repoItem(repo: RepoEntry, prNumber: string | null): PaletteItem {
  const [owner, name] = repo.fullName.split("/");
  let title = name;
  let detail: string;
  if (prNumber === null) {
    detail = repo.description ? `${owner} · ${repo.description}` : owner;
  } else if (prNumber === "") {
    detail = `${owner} · pull requests`;
  } else {
    title = `${name} #${prNumber}`;
    detail = `${owner} · pull request #${prNumber}`;
  }
  return {
    title,
    detail,
    completion:
      prNumber === null ? repo.fullName : `${repo.fullName}#${prNumber}`,
    open: async () => {
      await chrome.tabs.create({ url: repoPageUrl(repo.fullName, prNumber) });
    },
  };
}

function tabItem(tab: chrome.tabs.Tab): PaletteItem {
  return {
    title: tab.title || tab.url || "(untitled)",
    detail: tab.url ?? "",
    iconUrl: tab.favIconUrl,
    open: async () => {
      if (tab.id == null) return;
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    },
  };
}

function repoSource(
  { repos, visitTimes }: RepoCandidates,
  emptyText: string,
): PaletteSource {
  return {
    placeholder: "Open a GitHub repo… (Tab completes, #123 opens a PR)",
    emptyText,
    search: (query) => {
      const { repoText, prNumber } = parseRepoQuery(query);
      return rankRepos(repos, repoText, visitTimes, MAX_RESULTS).map((repo) =>
        repoItem(repo, prNumber),
      );
    },
  };
}

async function showRepos(): Promise<void> {
  let candidates = await loadRepoCandidates();
  // An empty cache means the background fetch hasn't run yet or failed.
  if (candidates.repos.length === 0) {
    setSource(repoSource(candidates, "Loading repos from GitHub…"));
    await refreshRepoCache().catch(() => {});
    candidates = await loadRepoCandidates();
  }
  setSource(
    repoSource(
      candidates,
      candidates.repos.length > 0
        ? "No matching repos."
        : "No repos found. Check the owners and GitHub token in Chromettaur settings.",
    ),
  );
}

async function showTabs(): Promise<void> {
  const [tabs, history, [current]] = await Promise.all([
    chrome.tabs.query({}),
    loadTabHistory(),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ]);
  // Keep incognito and regular tabs apart, whichever window the palette is in.
  const incognito = current?.incognito ?? false;
  const ordered = orderTabsByHistory(
    tabs.filter((tab) => tab.id !== current?.id && tab.incognito === incognito),
    history,
  );
  setSource({
    placeholder: "Jump to a recent tab…",
    emptyText: "No matching tabs.",
    search: (query) =>
      filterTabs(ordered, query).slice(0, MAX_RESULTS).map(tabItem),
  });
}

function handleKeydown(e: KeyboardEvent): void {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (items.length === 0) return;
    const step = e.key === "ArrowDown" ? 1 : -1;
    selectedIndex = (selectedIndex + step + items.length) % items.length;
    renderResults();
  } else if (e.key === "Enter") {
    e.preventDefault();
    const item = items[selectedIndex];
    if (item) void openItem(item);
  } else if (e.key === "Tab") {
    // Keep focus in the search box; Tab only completes.
    e.preventDefault();
    const completion = items[selectedIndex]?.completion;
    if (completion) {
      $<HTMLInputElement>("palette-query").value = completion;
      runSearch();
    }
  } else if (e.key === "Escape") {
    window.close();
  }
}

function bootstrap(): void {
  const input = $<HTMLInputElement>("palette-query");
  input.addEventListener("input", runSearch);
  input.addEventListener("keydown", handleKeydown);
  input.focus();

  const mode = new URLSearchParams(location.search).get("mode");
  void (mode === "repos" ? showRepos() : showTabs());
}

bootstrap();
