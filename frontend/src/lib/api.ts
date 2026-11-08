import { treaty } from "@elysia/eden";
import type { App } from "@hackutd/api";

// Eden appends its typed /api routes to this prefix. No upstream credentials
// or server implementation are included in the browser bundle.
export const api = treaty<App>(`${typeof window === "undefined" ? "http://localhost:3000" : window.location.origin}/api/backend`, { parseDate: false });

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
  return datasets.find((d) => d.id === "test") ?? datasets.find((d) => d.id.startsWith("mock_test")) ?? datasets[0];
}

import type { DatasetInfo } from "@hackutd/contracts";
