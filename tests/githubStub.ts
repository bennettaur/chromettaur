import { vi } from "vitest";

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

/** Route fetches by the first matching URL fragment, in insertion order. */
export function stubGithub(routes: Record<string, () => Response>) {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    const match = Object.keys(routes).find((fragment) =>
      url.includes(fragment),
    );
    if (!match) throw new Error(`Unexpected fetch: ${url}`);
    return routes[match]();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
