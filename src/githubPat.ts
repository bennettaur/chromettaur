const PAT_KEY = "githubPat";

/**
 * GitHub PAT lives in `chrome.storage.local` only — never `sync` (we don't
 * want the token roaming across machines via Chrome sync).
 */
export async function loadGithubPat(): Promise<string | undefined> {
  const r = await chrome.storage.local.get(PAT_KEY);
  const v = r[PAT_KEY];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export async function saveGithubPat(pat: string): Promise<void> {
  if (!pat) {
    await chrome.storage.local.remove(PAT_KEY);
    return;
  }
  await chrome.storage.local.set({ [PAT_KEY]: pat });
}

export async function clearGithubPat(): Promise<void> {
  await chrome.storage.local.remove(PAT_KEY);
}
