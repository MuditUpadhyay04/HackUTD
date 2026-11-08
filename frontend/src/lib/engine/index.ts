// Public, server-side engine API. Import from "@/lib/engine" in server components / route handlers only
// (it reads files with node:fs). Types are safe to import anywhere from "@/lib/engine/types".
import type { DatasetInfo } from "./types";

export type * from "./types";
export { listDatasets, loadDataset } from "./datasets";
export { getSnapshot, buildSnapshot, toEventsJson, type EventsJsonEvent } from "./snapshot";

/** The dataset shown when none is requested: the judging folder "test", then the mock test, then the first. */
export function defaultDataset(datasets: DatasetInfo[]): DatasetInfo | undefined {
  return datasets.find((d) => d.id === "test") ?? datasets.find((d) => d.id.startsWith("mock_test")) ?? datasets[0];
}
