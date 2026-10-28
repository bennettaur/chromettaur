import { isRestrictedUrl } from "./matcher";

// Captures go through the DevTools protocol rather than
// tabs.captureVisibleTab: it can render past the viewport in one shot, and
// its inspect mode gives the same hover highlight as the DevTools picker.

export const CAPTURE_MESSAGE = "capture-screenshot";

export type CaptureMode = "page" | "element";

export interface CaptureRequest {
  type: typeof CAPTURE_MESSAGE;
  mode: CaptureMode;
  tabId: number;
}

export interface CaptureResponse {
  ok: boolean;
  error?: string;
}

export interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LayoutMetrics {
  cssLayoutViewport: { pageX: number; pageY: number };
  cssContentSize: { width: number; height: number };
}

const PROTOCOL_VERSION = "1.3";
const CANCEL_BINDING = "__cancelPick";
// The Escape hook runs in its own world so page scripts can't see or block it.
const PICKER_WORLD = "chromettaur-picker";

// Tabs showing the hover highlight, and tabs whose element capture is running.
// An attached debugger keeps the service worker alive, so these survive the pick.
const pickingTabs = new Set<number>();
const capturingTabs = new Set<number>();

// Colors match the DevTools element picker.
const HIGHLIGHT_CONFIG = {
  showInfo: true,
  contentColor: { r: 111, g: 168, b: 220, a: 0.66 },
  paddingColor: { r: 147, g: 196, b: 125, a: 0.55 },
  borderColor: { r: 255, g: 229, b: 153, a: 0.66 },
  marginColor: { r: 246, g: 178, b: 107, a: 0.66 },
};

function sendCommand<T = unknown>(
  target: chrome.debugger.Debuggee,
  method: string,
  params?: object,
): Promise<T> {
  return chrome.debugger.sendCommand(target, method, params) as Promise<T>;
}

async function detachFromTab(tabId: number): Promise<void> {
  pickingTabs.delete(tabId);
  // Already detached when the user cancels from Chrome's debugging infobar.
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

async function attachToTab(tabId: number): Promise<chrome.tabs.Tab> {
  const tab = await chrome.tabs.get(tabId);
  if (isRestrictedUrl(tab.url)) {
    throw new Error("Chrome doesn't allow capturing this page.");
  }
  await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
  return tab;
}

/** The smallest rectangle around a DOM.getBoxModel quad, in page coordinates. */
export function quadToClip(
  quad: number[],
  scrollX: number,
  scrollY: number,
): Clip {
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return {
    x: left + scrollX,
    y: top + scrollY,
    width: Math.max(...xs) - left,
    height: Math.max(...ys) - top,
  };
}

/** Download name like `github.com-2026-10-28-143005.png`. */
export function screenshotFilename(
  url: string | undefined,
  mode: CaptureMode,
  now: Date,
): string {
  let host = "page";
  try {
    if (url) host = new URL(url).hostname || host;
  } catch {
    // Keeps the fallback name for unparseable URLs.
  }
  host = host.replace(/[^a-zA-Z0-9.-]/g, "_");
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const suffix = mode === "element" ? "-element" : "";
  return `${host}${suffix}-${stamp}.png`;
}

async function captureClip(tabId: number, clip: Clip): Promise<string> {
  const { data: pngBase64 } = await sendCommand<{ data: string }>(
    { tabId },
    "Page.captureScreenshot",
    {
      format: "png",
      captureBeyondViewport: true,
      clip: { ...clip, scale: 1 },
    },
  );
  return pngBase64;
}

async function savePng(
  pngBase64: string,
  url: string | undefined,
  mode: CaptureMode,
): Promise<void> {
  // Service workers have no URL.createObjectURL, so the PNG goes as a data URL.
  await chrome.downloads.download({
    url: `data:image/png;base64,${pngBase64}`,
    filename: screenshotFilename(url, mode, new Date()),
  });
}

/** Saves the whole document, including the parts scrolled out of view. */
export async function capturePage(tabId: number): Promise<void> {
  const tab = await attachToTab(tabId);
  try {
    const { cssContentSize } = await sendCommand<LayoutMetrics>(
      { tabId },
      "Page.getLayoutMetrics",
    );
    const pngBase64 = await captureClip(tabId, {
      x: 0,
      y: 0,
      width: Math.ceil(cssContentSize.width),
      height: Math.ceil(cssContentSize.height),
    });
    await savePng(pngBase64, tab.url, "page");
  } finally {
    await detachFromTab(tabId);
  }
}

/**
 * Highlights elements under the cursor. A click saves that element; Escape or
 * navigating away cancels. The capture itself runs in
 * `handleDebuggerEvent`, since it happens after this returns.
 */
export async function startElementPicker(tabId: number): Promise<void> {
  await attachToTab(tabId);
  const target = { tabId };
  try {
    await sendCommand(target, "DOM.enable");
    await sendCommand(target, "Overlay.enable");
    await sendCommand(target, "Page.enable");
    await sendCommand(target, "Runtime.enable");
    // Inspect mode has no cancel key, so a keydown listener reports Escape
    // back through a binding.
    await sendCommand(target, "Runtime.addBinding", {
      name: CANCEL_BINDING,
      executionContextName: PICKER_WORLD,
    });
    const { frameTree } = await sendCommand<{
      frameTree: { frame: { id: string } };
    }>(target, "Page.getFrameTree");
    const { executionContextId } = await sendCommand<{
      executionContextId: number;
    }>(target, "Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: PICKER_WORLD,
    });
    await sendCommand(target, "Runtime.evaluate", {
      contextId: executionContextId,
      expression: `document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") ${CANCEL_BINDING}("");
      }, true);`,
    });
    await sendCommand(target, "Overlay.setInspectMode", {
      mode: "searchForNode",
      highlightConfig: HIGHLIGHT_CONFIG,
    });
    pickingTabs.add(tabId);
  } catch (err) {
    await detachFromTab(tabId);
    throw err;
  }
}

async function captureElement(
  tabId: number,
  backendNodeId: number,
): Promise<void> {
  const target = { tabId };
  try {
    // Off before capturing so the highlight isn't in the image.
    await sendCommand(target, "Overlay.setInspectMode", { mode: "none" });
    await sendCommand(target, "Overlay.hideHighlight");
    const { model } = await sendCommand<{ model: { border: number[] } }>(
      target,
      "DOM.getBoxModel",
      { backendNodeId },
    );
    const { cssLayoutViewport } = await sendCommand<LayoutMetrics>(
      target,
      "Page.getLayoutMetrics",
    );
    const clip = quadToClip(
      model.border,
      cssLayoutViewport.pageX,
      cssLayoutViewport.pageY,
    );
    const pngBase64 = await captureClip(tabId, clip);
    const tab = await chrome.tabs.get(tabId);
    await savePng(pngBase64, tab.url, "element");
  } finally {
    capturingTabs.delete(tabId);
    await detachFromTab(tabId);
  }
}

/** Listener for chrome.debugger.onEvent; drives the element picker. */
export function handleDebuggerEvent(
  source: chrome.debugger.Debuggee,
  method: string,
  params?: object,
): void {
  const tabId = source.tabId;
  // Ignores a double click or Escape once the capture has started.
  if (tabId == null || capturingTabs.has(tabId)) return;

  if (method === "Overlay.inspectNodeRequested") {
    const { backendNodeId } = params as { backendNodeId: number };
    capturingTabs.add(tabId);
    // The popup is closed by now, so the log is the only place to report this.
    captureElement(tabId, backendNodeId).catch((err: unknown) => {
      console.error("Element capture failed", err);
    });
    return;
  }

  const pressedEscape =
    method === "Runtime.bindingCalled" &&
    (params as { name: string }).name === CANCEL_BINDING;
  const leftPage =
    method === "Page.frameNavigated" &&
    !(params as { frame: { parentId?: string } }).frame.parentId;
  if (pressedEscape || leftPage) void detachFromTab(tabId);
}

/** Listener for chrome.debugger.onDetach, e.g. Cancel on Chrome's debugging bar. */
export function handleDebuggerDetach(source: chrome.debugger.Debuggee): void {
  if (source.tabId == null) return;
  pickingTabs.delete(source.tabId);
  capturingTabs.delete(source.tabId);
}

/** Cancels pickers on tabs the user switched away from. */
export function cancelPickersExcept(activeTabId: number): void {
  for (const tabId of pickingTabs) {
    if (tabId !== activeTabId && !capturingTabs.has(tabId)) {
      void detachFromTab(tabId);
    }
  }
}

export function isCaptureRequest(msg: unknown): msg is CaptureRequest {
  const m = msg as Partial<CaptureRequest> | undefined;
  return (
    m?.type === CAPTURE_MESSAGE &&
    (m.mode === "page" || m.mode === "element") &&
    typeof m.tabId === "number"
  );
}
