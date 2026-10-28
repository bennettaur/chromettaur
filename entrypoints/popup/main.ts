import {
  CAPTURE_MESSAGE,
  type CaptureMode,
  type CaptureRequest,
  type CaptureResponse,
} from "../../src/screenshot";
import { loadSettings, saveSettings } from "../../src/settings";
import { clearRecentlyClosed, loadState, updateState } from "../../src/state";
import type { RecentlyClosedEntry } from "../../src/types";

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

async function refreshToggles(): Promise<void> {
  const settings = await loadSettings();
  $<HTMLInputElement>("t-autoclose").checked = settings.autoClose.enabled;
  $<HTMLInputElement>("t-uniqueness").checked = settings.uniqueness.enabled;
  $<HTMLInputElement>("t-autogroup").checked = settings.autoGroup.enabled;
}

async function refreshRecent(): Promise<void> {
  const state = await loadState();
  renderRecent(state.recentlyClosed);
}

function renderRecent(entries: RecentlyClosedEntry[]): void {
  const list = $<HTMLUListElement>("recent-list");
  const empty = $<HTMLParagraphElement>("recent-empty");
  list.innerHTML = "";

  if (entries.length === 0) {
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";

  for (const entry of entries) {
    const li = document.createElement("li");

    const meta = document.createElement("div");
    meta.className = "meta";

    const title = document.createElement("span");
    title.className = "title";
    title.textContent = entry.title || entry.url;
    title.title = entry.title || entry.url;

    const url = document.createElement("span");
    url.className = "url";
    url.textContent = entry.url;
    url.title = entry.url;

    meta.append(title, url);

    const restore = document.createElement("button");
    restore.textContent = "Restore";
    restore.addEventListener("click", () => {
      void handleRestore(entry);
    });

    li.append(meta, restore);
    list.append(li);
  }
}

async function handleRestore(entry: RecentlyClosedEntry): Promise<void> {
  if (entry.url) {
    await chrome.tabs.create({ url: entry.url });
  }
  await updateState((s) => {
    s.recentlyClosed = s.recentlyClosed.filter(
      (e) => !(e.url === entry.url && e.closedAt === entry.closedAt),
    );
  });
  await refreshRecent();
}

async function toggle(
  path: "autoClose" | "uniqueness" | "autoGroup",
  checked: boolean,
): Promise<void> {
  const settings = await loadSettings();
  settings[path].enabled = checked;
  await saveSettings(settings);
}

async function capture(mode: CaptureMode): Promise<void> {
  const status = $<HTMLParagraphElement>("capture-status");
  const buttons = [
    $<HTMLButtonElement>("capture-page"),
    $<HTMLButtonElement>("capture-element"),
  ];
  status.classList.remove("error");
  // Only a full-page capture keeps the popup open long enough to show this.
  status.textContent = mode === "page" ? "Capturing…" : "";
  for (const b of buttons) b.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (tab?.id == null) throw new Error("No active tab.");
    const request: CaptureRequest = {
      type: CAPTURE_MESSAGE,
      mode,
      tabId: tab.id,
    };
    const response = (await chrome.runtime.sendMessage(request)) as
      | CaptureResponse
      | undefined;
    if (!response?.ok) throw new Error(response?.error ?? "no response");
    if (mode === "element") {
      // Gets the popup out of the way so the user can hover the page.
      window.close();
      return;
    }
    status.textContent = "Saved to Downloads.";
  } catch (err) {
    status.textContent = `Capture failed: ${err instanceof Error ? err.message : String(err)}`;
    status.classList.add("error");
  } finally {
    for (const b of buttons) b.disabled = false;
  }
}

async function bootstrap(): Promise<void> {
  await Promise.all([refreshToggles(), refreshRecent()]);

  $<HTMLInputElement>("t-autoclose").addEventListener("change", (e) =>
    toggle("autoClose", (e.target as HTMLInputElement).checked),
  );
  $<HTMLInputElement>("t-uniqueness").addEventListener("change", (e) =>
    toggle("uniqueness", (e.target as HTMLInputElement).checked),
  );
  $<HTMLInputElement>("t-autogroup").addEventListener("change", (e) =>
    toggle("autoGroup", (e.target as HTMLInputElement).checked),
  );

  $("capture-page").addEventListener("click", () => void capture("page"));
  $("capture-element").addEventListener("click", () => void capture("element"));

  $("open-options").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  $("clear-recent").addEventListener("click", async () => {
    await clearRecentlyClosed();
    await refreshRecent();
  });
}

void bootstrap();
