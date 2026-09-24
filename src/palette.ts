export type PaletteMode = "repos" | "tabs";

export const PALETTE_COMMANDS: Record<string, PaletteMode> = {
  "open-repo-switcher": "repos",
  "open-tab-history": "tabs",
};

/**
 * Show the palette in the toolbar popup. The popup path is swapped only while
 * the popup opens, so clicking the toolbar icon still shows the regular popup.
 */
export async function openPalette(mode: PaletteMode): Promise<void> {
  const defaultPopup = chrome.runtime.getManifest().action?.default_popup ?? "";
  await chrome.action.setPopup({ popup: `palette.html?mode=${mode}` });
  try {
    await chrome.action.openPopup();
  } finally {
    await chrome.action.setPopup({ popup: defaultPopup });
  }
}
