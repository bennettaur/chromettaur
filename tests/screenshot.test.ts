import { describe, it, expect } from "vitest";
import { quadToClip, screenshotFilename } from "../src/screenshot";

describe("quadToClip", () => {
  it("offsets a viewport quad by the scroll position", () => {
    const quad = [10, 20, 110, 20, 110, 70, 10, 70];

    expect(quadToClip(quad, 0, 500)).toEqual({
      x: 10,
      y: 520,
      width: 100,
      height: 50,
    });
  });

  it("bounds a transformed quad", () => {
    const quad = [50, 0, 100, 50, 50, 100, 0, 50];

    expect(quadToClip(quad, 0, 0)).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
  });
});

describe("screenshotFilename", () => {
  const now = new Date(2026, 9, 28, 14, 30, 5);

  it("names page captures after the host and time", () => {
    expect(screenshotFilename("https://github.com/a/b?x=1", "page", now)).toBe(
      "github.com-2026-10-28-143005.png",
    );
  });

  it("marks element captures", () => {
    expect(screenshotFilename("https://example.com/", "element", now)).toBe(
      "example.com-element-2026-10-28-143005.png",
    );
  });

  it("falls back when the URL has no host", () => {
    expect(screenshotFilename("file:///tmp/a.html", "page", now)).toBe(
      "page-2026-10-28-143005.png",
    );
    expect(screenshotFilename(undefined, "page", now)).toBe(
      "page-2026-10-28-143005.png",
    );
  });
});
