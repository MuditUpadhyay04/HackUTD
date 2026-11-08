import { treaty } from "@elysia/eden";
import type { App } from "@hackutd/api";

// Eden appends its typed /api routes to this prefix. In the browser that is this console's own proxy
// (/api/backend); on the server (page.tsx renders the dataset list) it is the operator API itself, reached
// the way the proxy reaches it (API_URL, bearer API_TOKEN). "http://localhost" here meant port 80, where
// nothing listens, so the page failed with 503. No upstream credentials reach the browser bundle: API_TOKEN
// is server-only and unset in the client.
const server = typeof window === "undefined";
export const api = treaty<App>(server ? (process.env.API_URL || "http://127.0.0.1:3001") : `${window.location.origin}/api/backend`, {
  parseDate: false,
  ...(server && process.env.API_TOKEN ? { headers: { authorization: `Bearer ${process.env.API_TOKEN}` } } : {}),
});

export function unwrap<T>(result: { data: T | null; error: unknown }): Exclude<T, Response | { error: string; code: string }> {
  if (result.error) {
    const error = result.error as { value?: { error?: string; issues?: { file?: string; path?: string; message: string }[] } | string; status?: number };
    const value = error.value;
    if (typeof value === "string") throw new Error(value);
    if (value?.error) throw new Error([value.error, ...(value.issues ?? []).map((i) => `${i.file ?? ""} ${i.path ?? ""}: ${i.message}`.trim())].join("\n"));
    throw new Error(`Request failed${error.status ? ` (${error.status})` : ""}`);
  }
  if (result.data === null) throw new Error("Empty response from backend");
  if (result.data instanceof Response) throw new Error(`Unexpected backend response (${result.data.status})`);
  if (typeof result.data === "object" && result.data !== null && "code" in result.data && "error" in result.data) {
    throw new Error(String(result.data.error));
  }
  return result.data as Exclude<T, Response | { error: string; code: string }>;
}

export function commandKey() { return crypto.randomUUID(); }

export async function listDatasets(): Promise<DatasetInfo[]> {
  const result = await api.api.datasets.get();
  return unwrap(result);
}

export function defaultDataset(datasets: DatasetInfo[]): DatasetInfo | undefined {
  // Labels are folder names when the API loads DATA_ROOT; ids are content hashes.
  const named = (name: string) => datasets.find((d) => d.label === name || d.id === name);
  return named("test") ?? datasets.find((d) => d.label.startsWith("mock_test") || d.id.startsWith("mock_test")) ?? datasets[0];
}

import type { DatasetInfo } from "@hackutd/contracts";
