import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { loadViewerLogin } from "../src/github";
import { saveGithubPat } from "../src/githubPat";
import { installChromeStorageFake } from "./chromeStorageFake";
import { jsonResponse, stubGithub } from "./githubStub";

beforeEach(() => {
  installChromeStorageFake();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadViewerLogin", () => {
  it("returns null without a PAT and makes no request", async () => {
    const fetchMock = stubGithub({});
    expect(await loadViewerLogin(undefined)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caches the login", async () => {
    const fetchMock = stubGithub({
      "/user": () => jsonResponse({ login: "me" }),
    });
    await loadViewerLogin("pat");
    expect(await loadViewerLogin("pat")).toBe("me");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the new account's login after the PAT is replaced", async () => {
    stubGithub({ "/user": () => jsonResponse({ login: "old" }) });
    await loadViewerLogin("pat-old");
    await saveGithubPat("pat-new");
    stubGithub({ "/user": () => jsonResponse({ login: "new" }) });
    expect(await loadViewerLogin("pat-new")).toBe("new");
  });

  it("throws when GitHub can't be reached", async () => {
    stubGithub({ "/user": () => jsonResponse({}, 401) });
    await expect(loadViewerLogin("pat")).rejects.toThrow();
  });
});
