import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelPickersExcept,
  capturePage,
  handleDebuggerDetach,
  handleDebuggerEvent,
  isCaptureRequest,
  startElementPicker,
} from "../src/screenshot";

const TAB_ID = 7;
const PNG = "iVBORw0KGgo=";

/**
 * Stub `chrome` with the debugger, tabs.get and downloads calls the capture
 * code makes. `failOn` makes that CDP method reject.
 */
function installDebuggerFake(
  init: {
    url?: string;
    failOn?: string;
    responses?: Record<string, unknown>;
  } = {},
) {
  let attached = false;
  const commands: { method: string; params?: object }[] = [];
  const responses: Record<string, unknown> = {
    "Page.getLayoutMetrics": {
      cssLayoutViewport: { pageX: 0, pageY: 0 },
      cssContentSize: { width: 1280, height: 3000.4 },
    },
    "Page.captureScreenshot": { data: PNG },
    "Page.getFrameTree": { frameTree: { frame: { id: "top" } } },
    "Page.createIsolatedWorld": { executionContextId: 99 },
    ...init.responses,
  };

  const chrome = {
    debugger: {
      attach: vi.fn(async () => {
        if (attached) throw new Error("Another debugger is already attached");
        attached = true;
      }),
      detach: vi.fn(async () => {
        if (!attached) throw new Error("Debugger is not attached");
        attached = false;
      }),
      sendCommand: vi.fn(
        async (_target: unknown, method: string, params?: object) => {
          commands.push({ method, params });
          if (method === init.failOn) throw new Error(`${method} failed`);
          return responses[method] ?? {};
        },
      ),
    },
    tabs: {
      get: vi.fn(async (id: number) => ({
        id,
        url: init.url ?? "https://example.com/a",
      })),
    },
    downloads: {
      download: vi.fn(async () => 1),
    },
  };
  vi.stubGlobal("chrome", chrome);
  return {
    chrome,
    commands,
    isAttached: () => attached,
    methods: () => commands.map((c) => c.method),
  };
}

// handleDebuggerEvent starts the element capture without awaiting it.
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

afterEach(() => {
  // Clears the module's picker bookkeeping between tests.
  handleDebuggerDetach({ tabId: TAB_ID });
  handleDebuggerDetach({ tabId: TAB_ID + 1 });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("capturePage", () => {
  it("saves the full content size and detaches", async () => {
    const fake = installDebuggerFake();

    await capturePage(TAB_ID);

    const shot = fake.commands.find(
      (c) => c.method === "Page.captureScreenshot",
    );
    expect(shot?.params).toMatchObject({
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 1280, height: 3001 },
    });
    expect(fake.chrome.downloads.download).toHaveBeenCalledWith({
      url: `data:image/png;base64,${PNG}`,
      filename: expect.stringMatching(
        /^example\.com-\d{4}-\d{2}-\d{2}-\d{6}\.png$/,
      ),
    });
    expect(fake.isAttached()).toBe(false);
  });

  it("refuses restricted pages without attaching", async () => {
    const fake = installDebuggerFake({ url: "chrome://settings" });

    await expect(capturePage(TAB_ID)).rejects.toThrow(
      "Chrome doesn't allow capturing this page.",
    );
    expect(fake.chrome.debugger.attach).not.toHaveBeenCalled();
  });

  it("detaches when the capture fails", async () => {
    const fake = installDebuggerFake({ failOn: "Page.captureScreenshot" });

    await expect(capturePage(TAB_ID)).rejects.toThrow();
    expect(fake.isAttached()).toBe(false);
    expect(fake.chrome.downloads.download).not.toHaveBeenCalled();
  });

  it("reports an attach failure", async () => {
    const fake = installDebuggerFake();
    await fake.chrome.debugger.attach();

    await expect(capturePage(TAB_ID)).rejects.toThrow("already attached");
  });
});

describe("element picker", () => {
  const boxModel = {
    "DOM.getBoxModel": {
      model: { border: [10, 20, 110, 20, 110, 70, 10, 70] },
    },
    "Page.getLayoutMetrics": {
      cssLayoutViewport: { pageX: 5, pageY: 400 },
      cssContentSize: { width: 1280, height: 3000 },
    },
  };

  it("saves the clicked element at its page position", async () => {
    const fake = installDebuggerFake({ responses: boxModel });
    await startElementPicker(TAB_ID);

    handleDebuggerEvent({ tabId: TAB_ID }, "Overlay.inspectNodeRequested", {
      backendNodeId: 42,
    });
    await flush();

    const shot = fake.commands.find(
      (c) => c.method === "Page.captureScreenshot",
    );
    expect(shot?.params).toMatchObject({
      clip: { x: 15, y: 420, width: 100, height: 50 },
    });
    expect(fake.chrome.downloads.download).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: expect.stringMatching(/^example\.com-element-/),
      }),
    );
    expect(fake.isAttached()).toBe(false);
  });

  it("removes the highlight before capturing", async () => {
    const fake = installDebuggerFake({ responses: boxModel });
    await startElementPicker(TAB_ID);

    handleDebuggerEvent({ tabId: TAB_ID }, "Overlay.inspectNodeRequested", {
      backendNodeId: 42,
    });
    await flush();

    const methods = fake.methods();
    expect(methods.lastIndexOf("Overlay.hideHighlight")).toBeLessThan(
      methods.indexOf("Page.captureScreenshot"),
    );
  });

  it("detaches and logs when the element is gone", async () => {
    const fake = installDebuggerFake({ failOn: "DOM.getBoxModel" });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await startElementPicker(TAB_ID);

    handleDebuggerEvent({ tabId: TAB_ID }, "Overlay.inspectNodeRequested", {
      backendNodeId: 42,
    });
    await flush();

    expect(error).toHaveBeenCalled();
    expect(fake.isAttached()).toBe(false);
    expect(fake.chrome.downloads.download).not.toHaveBeenCalled();
  });

  it("detaches and rethrows when setup fails", async () => {
    const fake = installDebuggerFake({ failOn: "Overlay.setInspectMode" });

    await expect(startElementPicker(TAB_ID)).rejects.toThrow();
    expect(fake.isAttached()).toBe(false);
  });
});

describe("element picker re-entry", () => {
  const boxModel = {
    "DOM.getBoxModel": {
      model: { border: [0, 0, 10, 0, 10, 10, 0, 10] },
    },
  };

  it("saves once on a double click", async () => {
    const fake = installDebuggerFake({ responses: boxModel });
    await startElementPicker(TAB_ID);

    const click = { backendNodeId: 42 };
    handleDebuggerEvent(
      { tabId: TAB_ID },
      "Overlay.inspectNodeRequested",
      click,
    );
    handleDebuggerEvent(
      { tabId: TAB_ID },
      "Overlay.inspectNodeRequested",
      click,
    );
    await flush();

    expect(fake.chrome.downloads.download).toHaveBeenCalledTimes(1);
  });

  it("finishes the capture when Escape arrives mid-capture", async () => {
    const fake = installDebuggerFake({ responses: boxModel });
    await startElementPicker(TAB_ID);

    handleDebuggerEvent({ tabId: TAB_ID }, "Overlay.inspectNodeRequested", {
      backendNodeId: 42,
    });
    handleDebuggerEvent({ tabId: TAB_ID }, "Runtime.bindingCalled", {
      name: "__cancelPick",
    });
    await flush();

    expect(fake.chrome.downloads.download).toHaveBeenCalledTimes(1);
  });

  it("runs the Escape hook in an isolated world", async () => {
    const fake = installDebuggerFake();
    await startElementPicker(TAB_ID);

    const hook = fake.commands.find((c) => c.method === "Runtime.evaluate");
    expect(hook?.params).toMatchObject({ contextId: 99 });
  });
});

describe("picker cancellation", () => {
  it("detaches when the user switches to another tab", async () => {
    const fake = installDebuggerFake();
    await startElementPicker(TAB_ID);

    cancelPickersExcept(TAB_ID);
    await flush();
    expect(fake.isAttached()).toBe(true);

    cancelPickersExcept(TAB_ID + 1);
    await flush();
    expect(fake.isAttached()).toBe(false);
  });

  it("detaches when the cancel binding fires", async () => {
    const fake = installDebuggerFake();
    await startElementPicker(TAB_ID);

    handleDebuggerEvent({ tabId: TAB_ID }, "Runtime.bindingCalled", {
      name: "__cancelPick",
    });
    await flush();

    expect(fake.isAttached()).toBe(false);
    expect(fake.chrome.downloads.download).not.toHaveBeenCalled();
  });

  it("ignores other bindings", async () => {
    const fake = installDebuggerFake();
    await startElementPicker(TAB_ID);

    handleDebuggerEvent({ tabId: TAB_ID }, "Runtime.bindingCalled", {
      name: "somethingElse",
    });
    await flush();

    expect(fake.isAttached()).toBe(true);
  });

  it("detaches when the top frame navigates but not a child frame", async () => {
    const fake = installDebuggerFake();
    await startElementPicker(TAB_ID);

    handleDebuggerEvent({ tabId: TAB_ID }, "Page.frameNavigated", {
      frame: { id: "child", parentId: "top" },
    });
    await flush();
    expect(fake.isAttached()).toBe(true);

    handleDebuggerEvent({ tabId: TAB_ID }, "Page.frameNavigated", {
      frame: { id: "top" },
    });
    await flush();
    expect(fake.isAttached()).toBe(false);
  });

  it("ignores events without a tab", async () => {
    const fake = installDebuggerFake();
    await startElementPicker(TAB_ID);

    handleDebuggerEvent({}, "Runtime.bindingCalled", {
      name: "__cancelPick",
    });
    await flush();

    expect(fake.isAttached()).toBe(true);
  });
});

describe("isCaptureRequest", () => {
  it("accepts page and element requests", () => {
    expect(
      isCaptureRequest({ type: "capture-screenshot", mode: "page", tabId: 1 }),
    ).toBe(true);
    expect(
      isCaptureRequest({
        type: "capture-screenshot",
        mode: "element",
        tabId: 1,
      }),
    ).toBe(true);
  });

  it("rejects other messages and unknown modes", () => {
    expect(isCaptureRequest({ type: "pr-status-sweep" })).toBe(false);
    expect(
      isCaptureRequest({ type: "capture-screenshot", mode: "video", tabId: 1 }),
    ).toBe(false);
    expect(isCaptureRequest(undefined)).toBe(false);
  });
});
