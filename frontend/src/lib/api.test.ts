import { afterEach, expect, test } from "bun:test";
import { api, unwrap } from "./api";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

// Server side (no window: page.tsx renders the dataset list) calls the operator API directly, like the proxy route
// does; the old "http://localhost/api/backend" base meant port 80 and the page failed with 503. In the browser the
// base is window.location.origin + "/api/backend" (the same-origin proxy).
test("server-side calls reach the operator API, not port 80", async () => {
  let url = "";
  globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
    url = String(input);
    return new Response("[]", { headers: { "content-type": "application/json" } });
  }, { preconnect: originalFetch.preconnect });
  expect(unwrap(await api.api.datasets.get())).toEqual([]);
  expect(url).toBe(`${process.env.API_URL || "http://127.0.0.1:3001"}/api/datasets`);
});
