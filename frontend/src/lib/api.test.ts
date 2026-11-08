import { afterEach, expect, test } from "bun:test";
import { api, unwrap } from "./api";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("Eden retains the same-origin proxy prefix", async () => {
  let url = "";
  globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
    url = String(input);
    return new Response("[]", { headers: { "content-type": "application/json" } });
  }, { preconnect: originalFetch.preconnect });
  expect(unwrap(await api.api.datasets.get())).toEqual([]);
  expect(url).toBe("http://localhost/api/backend/api/datasets");
});
