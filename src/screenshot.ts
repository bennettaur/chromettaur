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
const CANCEL_BINDING = "__chromettaurCancelPick";

// Colors match the DevTools element picker.
const HIGHLIGHT_CONFIG = {
  showInfo: true,
  contentColor: { r: 111, g: 168, b: 220, a: 0.66 },
  paddingColor: { r: 147, g: 196, b: 125, a: 0.55 },
  borderColor: { r: 255, g: 229, b: 153, a: 0.66 },
  marginColor: { r: 246, g: 178, b: 107, a: 0.66 },
};

function send<T = unknown>(
  target: chrome.debugger.Debuggee,
  method: string,
  params?: object,
): Promise<T> {
  return chrome.debugger.sendCommand(target, method, params) as Promise<T>;
}

async function detach(tabId: number): Promise<void> {
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
export function quadToClip(quad: number[], pageX: number, pageY: number): Clip {
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return {
    x: left + pageX,
    y: top + pageY,
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
  const { data } = await send<{ data: string }>(
    { tabId },
    "Page.captureScreenshot",
    {
      format: "png",
      captureBeyondViewport: true,
      clip: { ...clip, scale: 1 },
    },
  );
  return data;
}

async function savePng(
  data: string,
  url: string | undefined,
  mode: CaptureMode,
): Promise<void> {
  // Service workers have no URL.createObjectURL, so the PNG goes as a data URL.
  await chrome.downloads.download({
    url: `data:image/png;base64,${data}`,
    filename: screenshotFilename(url, mode, new Date()),
  });
}

/** Saves the whole document, including the parts scrolled out of view. */
export async function capturePage(tabId: number): Promise<void> {
  const tab = await attachToTab(tabId);
  try {
    const { cssContentSize } = await send<LayoutMetrics>(
      { tabId },
      "Page.getLayoutMetrics",
    );
    const data = await captureClip(tabId, {
      x: 0,
      y: 0,
      width: Math.ceil(cssContentSize.width),
      height: Math.ceil(cssContentSize.height),
    });
    await savePng(data, tab.url, "page");
  } finally {
    await detach(tabId);
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
    await send(target, "DOM.enable");
    await send(target, "Overlay.enable");
    await send(target, "Page.enable");
    await send(target, "Runtime.enable");
    await send(target, "Runtime.addBinding", { name: CANCEL_BINDING });
    await send(target, "Runtime.evaluate", {
      expression: `document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") ${CANCEL_BINDING}("");
      }, true);`,
    });
    await send(target, "Overlay.setInspectMode", {
      mode: "searchForNode",
      highlightConfig: HIGHLIGHT_CONFIG,
    });
  } catch (err) {
    await detach(tabId);
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
    await send(target, "Overlay.setInspectMode", { mode: "none" });
    await send(target, "Overlay.hideHighlight");
    const { model } = await send<{ model: { border: number[] } }>(
      target,
      "DOM.getBoxModel",
      { backendNodeId },
    );
    const { cssLayoutViewport } = await send<LayoutMetrics>(
      target,
      "Page.getLayoutMetrics",
    );
    const clip = quadToClip(
      model.border,
      cssLayoutViewport.pageX,
      cssLayoutViewport.pageY,
    );
    const data = await captureClip(tabId, clip);
    const tab = await chrome.tabs.get(tabId);
    await savePng(data, tab.url, "element");
  } finally {
    await detach(tabId);
  }
}

/** Listener for chrome.debugger.onEvent; drives the element picker. */
export function handleDebuggerEvent(
  source: chrome.debugger.Debuggee,
  method: string,
  params?: object,
): void {
  const tabId = source.tabId;
  if (tabId == null) return;

  if (method === "Overlay.inspectNodeRequested") {
    const { backendNodeId } = params as { backendNodeId: number };
    captureElement(tabId, backendNodeId).catch((err: unknown) => {
      console.error("Element capture failed", err);
    });
  } else if (
    method === "Runtime.bindingCalled" &&
    (params as { name: string }).name === CANCEL_BINDING
  ) {
    void detach(tabId);
  } else if (
    method === "Page.frameNavigated" &&
    !(params as { frame: { parentId?: string } }).frame.parentId
  ) {
    void detach(tabId);
  }
}
