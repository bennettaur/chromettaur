import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
} from "../../src/settings";
import { isValidPattern, isValidRegex } from "../../src/matcher";
import {
  clearGithubPat,
  loadGithubPat,
  saveGithubPat,
} from "../../src/githubPat";
import {
  GROUP_COLORS,
  type AutoGroupRule,
  type GroupColor,
  type KeyStrategy,
  type Settings,
  type UniquenessRule,
} from "../../src/types";

const KEY_STRATEGIES: KeyStrategy[] = [
  "exact",
  "ignoreFragment",
  "ignoreQuery",
  "regexCapture",
];

let working: Settings = structuredClone(DEFAULT_SETTINGS);

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

function uid(): string {
  return `rule-${Math.random().toString(36).slice(2, 10)}`;
}

function render(): void {
  // Auto-close
  $<HTMLInputElement>("ac-enabled").checked = working.autoClose.enabled;
  $<HTMLInputElement>("ac-idle").value = String(working.autoClose.idleMinutes);
  $<HTMLInputElement>("ac-sweep").value = String(
    working.autoClose.sweepIntervalMinutes,
  );
  $<HTMLInputElement>("ac-min").value = String(working.autoClose.minTabsOpen);
  $<HTMLSelectElement>("ac-action").value = working.autoClose.action;
  $<HTMLInputElement>("ac-pinned").checked = working.autoClose.protectPinned;
  $<HTMLInputElement>("ac-audible").checked = working.autoClose.protectAudible;
  $<HTMLInputElement>("ac-grouped").checked = working.autoClose.protectGrouped;
  renderAllowlist();

  // Uniqueness
  $<HTMLInputElement>("uq-enabled").checked = working.uniqueness.enabled;
  renderUniquenessRules();

  // Auto-group
  $<HTMLInputElement>("ag-enabled").checked = working.autoGroup.enabled;
  $<HTMLInputElement>("ag-respect").checked =
    working.autoGroup.respectUserOverride;
  renderAutoGroupRules();

  // PR status
  $<HTMLInputElement>("pr-enabled").checked = working.prStatus.enabled;
  $<HTMLInputElement>("pr-poll").value = String(working.prStatus.pollMinutes);
}

function renderAllowlist(): void {
  const list = $<HTMLUListElement>("ac-allowlist");
  list.innerHTML = "";
  working.autoClose.allowlist.forEach((pattern, idx) => {
    const li = document.createElement("li");
    const input = document.createElement("input");
    input.type = "text";
    input.value = pattern;
    input.placeholder = "https://example.com/*";
    input.addEventListener("input", () => {
      working.autoClose.allowlist[idx] = input.value;
      input.classList.toggle(
        "invalid",
        input.value !== "" && !isValidPattern(input.value),
      );
    });
    if (pattern !== "" && !isValidPattern(pattern)) {
      input.classList.add("invalid");
    }

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "row-remove";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      working.autoClose.allowlist.splice(idx, 1);
      renderAllowlist();
    });

    li.append(input, remove);
    list.append(li);
  });
}

function renderUniquenessRules(): void {
  const tbody = document.querySelector<HTMLTableSectionElement>("#uq-table tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  working.uniqueness.rules.forEach((rule, idx) => {
    const row = document.createElement("tr");

    row.append(
      cellInput(rule.name, "PR review", (v) => (rule.name = v)),
      cellInput(
        rule.matchPattern,
        "https://github.com/*/*/pull/*",
        (v) => {
          rule.matchPattern = v;
        },
        (v) => v !== "" && !isValidPattern(v),
      ),
      cellSelect(
        rule.keyStrategy,
        KEY_STRATEGIES,
        (v) => {
          rule.keyStrategy = v as KeyStrategy;
          renderUniquenessRules();
        },
      ),
      cellInput(
        rule.keyRegex ?? "",
        rule.keyStrategy === "regexCapture"
          ? "^https://example\\.com/([^/]+)"
          : "(unused for this strategy)",
        (v) => {
          rule.keyRegex = v;
        },
        (v) => rule.keyStrategy === "regexCapture" && v !== "" && !isValidRegex(v),
        rule.keyStrategy !== "regexCapture",
      ),
      cellRemove(() => {
        working.uniqueness.rules.splice(idx, 1);
        renderUniquenessRules();
      }),
    );

    tbody.append(row);
  });
}

function renderAutoGroupRules(): void {
  const tbody = document.querySelector<HTMLTableSectionElement>("#ag-table tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  working.autoGroup.rules.forEach((rule, idx) => {
    const row = document.createElement("tr");

    row.append(
      cellInput(rule.name, "GitHub", (v) => (rule.name = v)),
      cellSelect(
        rule.color,
        GROUP_COLORS,
        (v) => (rule.color = v as GroupColor),
      ),
      cellInput(
        rule.matchPattern,
        "https://github.com/*",
        (v) => {
          rule.matchPattern = v;
        },
        (v) => v !== "" && !isValidPattern(v),
      ),
      cellRemove(() => {
        working.autoGroup.rules.splice(idx, 1);
        renderAutoGroupRules();
      }),
    );

    tbody.append(row);
  });
}

function cellInput(
  value: string,
  placeholder: string,
  onChange: (v: string) => void,
  invalidWhen?: (v: string) => boolean,
  disabled = false,
): HTMLTableCellElement {
  const td = document.createElement("td");
  const input = document.createElement("input");
  input.type = "text";
  input.value = value;
  input.placeholder = placeholder;
  input.disabled = disabled;
  if (invalidWhen?.(value)) input.classList.add("invalid");
  input.addEventListener("input", () => {
    onChange(input.value);
    if (invalidWhen) {
      input.classList.toggle("invalid", invalidWhen(input.value));
    }
  });
  td.append(input);
  return td;
}

function cellSelect(
  value: string,
  options: readonly string[],
  onChange: (v: string) => void,
): HTMLTableCellElement {
  const td = document.createElement("td");
  const sel = document.createElement("select");
  for (const opt of options) {
    const o = document.createElement("option");
    o.value = opt;
    o.textContent = opt;
    if (opt === value) o.selected = true;
    sel.append(o);
  }
  sel.addEventListener("change", () => onChange(sel.value));
  td.append(sel);
  return td;
}

function cellRemove(onClick: () => void): HTMLTableCellElement {
  const td = document.createElement("td");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "row-remove";
  btn.textContent = "Remove";
  btn.addEventListener("click", onClick);
  td.append(btn);
  return td;
}

function collectFromInputs(): void {
  working.autoClose.enabled = $<HTMLInputElement>("ac-enabled").checked;
  working.autoClose.idleMinutes = Number(
    $<HTMLInputElement>("ac-idle").value,
  );
  working.autoClose.sweepIntervalMinutes = Number(
    $<HTMLInputElement>("ac-sweep").value,
  );
  working.autoClose.minTabsOpen = Number($<HTMLInputElement>("ac-min").value);
  working.autoClose.action = $<HTMLSelectElement>("ac-action").value as
    | "close"
    | "discard";
  working.autoClose.protectPinned = $<HTMLInputElement>("ac-pinned").checked;
  working.autoClose.protectAudible = $<HTMLInputElement>("ac-audible").checked;
  working.autoClose.protectGrouped = $<HTMLInputElement>("ac-grouped").checked;
  working.uniqueness.enabled = $<HTMLInputElement>("uq-enabled").checked;
  working.autoGroup.enabled = $<HTMLInputElement>("ag-enabled").checked;
  working.autoGroup.respectUserOverride =
    $<HTMLInputElement>("ag-respect").checked;
  working.prStatus.enabled = $<HTMLInputElement>("pr-enabled").checked;
  working.prStatus.pollMinutes = Number(
    $<HTMLInputElement>("pr-poll").value,
  );
}

function validate(): string | null {
  const ac = working.autoClose;
  if (!Number.isFinite(ac.idleMinutes) || ac.idleMinutes < 1) {
    return "Idle minutes must be ≥ 1.";
  }
  if (!Number.isFinite(ac.sweepIntervalMinutes) || ac.sweepIntervalMinutes < 0.5) {
    return "Sweep interval must be ≥ 0.5 (Chrome floor).";
  }
  if (!Number.isFinite(ac.minTabsOpen) || ac.minTabsOpen < 0) {
    return "Minimum tabs open must be ≥ 0.";
  }
  for (const p of ac.allowlist) {
    if (p === "") continue;
    if (!isValidPattern(p)) return `Invalid allowlist pattern: ${p}`;
  }
  for (const rule of working.uniqueness.rules) {
    if (!isValidPattern(rule.matchPattern)) {
      return `Invalid uniqueness match pattern in "${rule.name}".`;
    }
    if (rule.keyStrategy === "regexCapture") {
      if (!rule.keyRegex || !isValidRegex(rule.keyRegex)) {
        return `Invalid key regex in "${rule.name}".`;
      }
    }
  }
  for (const rule of working.autoGroup.rules) {
    if (!isValidPattern(rule.matchPattern)) {
      return `Invalid auto-group match pattern in "${rule.name}".`;
    }
    if (!GROUP_COLORS.includes(rule.color)) {
      return `Invalid color for "${rule.name}".`;
    }
  }
  if (
    !Number.isFinite(working.prStatus.pollMinutes) ||
    working.prStatus.pollMinutes < 0.5
  ) {
    return "PR status poll interval must be ≥ 0.5 (Chrome floor).";
  }
  return null;
}

async function handleSave(): Promise<void> {
  collectFromInputs();
  const err = validate();
  const status = $<HTMLDivElement>("save-status");
  if (err) {
    status.textContent = err;
    status.classList.add("error");
    return;
  }
  working.autoClose.allowlist = working.autoClose.allowlist.filter(
    (p) => p.trim() !== "",
  );
  await saveSettings(working);

  const patInput = $<HTMLInputElement>("pr-pat");
  if (patInput.value.trim() !== "") {
    await saveGithubPat(patInput.value.trim());
    patInput.value = "";
    await refreshPatStatus();
  }

  status.classList.remove("error");
  status.textContent = "Saved.";
  setTimeout(() => (status.textContent = ""), 1500);
}

async function handleRunSweepNow(): Promise<void> {
  const status = $<HTMLDivElement>("pr-run-status");
  const btn = $<HTMLButtonElement>("pr-run-now");
  status.classList.remove("error");
  status.textContent = "Running PR sweep…";
  btn.disabled = true;
  try {
    const response = (await chrome.runtime.sendMessage({
      type: "pr-status-sweep",
    })) as { ok: boolean; error?: string } | undefined;
    if (response?.ok) {
      status.textContent = "PR sweep complete.";
    } else {
      status.textContent = `PR sweep failed: ${response?.error ?? "no response"}`;
      status.classList.add("error");
    }
  } catch (e) {
    status.textContent = `PR sweep failed: ${e instanceof Error ? e.message : String(e)}`;
    status.classList.add("error");
  } finally {
    btn.disabled = false;
    setTimeout(() => {
      status.textContent = "";
      status.classList.remove("error");
    }, 3000);
  }
}

async function refreshPatStatus(): Promise<void> {
  const stored = await loadGithubPat();
  const label = $<HTMLSpanElement>("pr-pat-status");
  label.textContent = stored
    ? "A token is currently saved."
    : "No token saved — using unauthenticated GitHub API (60 req/hr).";
}

function addUniquenessRule(): void {
  const rule: UniquenessRule = {
    id: uid(),
    name: "New rule",
    matchPattern: "https://example.com/*",
    keyStrategy: "ignoreFragment",
  };
  working.uniqueness.rules.push(rule);
  renderUniquenessRules();
}

function addAutoGroupRule(): void {
  const rule: AutoGroupRule = {
    id: uid(),
    name: "New group",
    color: "grey",
    matchPattern: "https://example.com/*",
  };
  working.autoGroup.rules.push(rule);
  renderAutoGroupRules();
}

async function bootstrap(): Promise<void> {
  working = await loadSettings();
  render();
  await refreshPatStatus();

  $("save-btn").addEventListener("click", handleSave);
  $("reset-btn").addEventListener("click", () => {
    working = structuredClone(DEFAULT_SETTINGS);
    render();
  });

  $("pr-pat-clear").addEventListener("click", async () => {
    await clearGithubPat();
    $<HTMLInputElement>("pr-pat").value = "";
    await refreshPatStatus();
  });

  $("pr-run-now").addEventListener("click", handleRunSweepNow);

  document.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      switch (btn.dataset.action) {
        case "add-allow":
          working.autoClose.allowlist.push("");
          renderAllowlist();
          break;
        case "add-uq":
          addUniquenessRule();
          break;
        case "add-ag":
          addAutoGroupRule();
          break;
      }
    });
  });
}

void bootstrap();
