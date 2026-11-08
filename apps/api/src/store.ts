import type { AnalysisRecord, ImportedDataset, InferenceObservation, LiveEvent, OperatorAction, RunRecord, ScenarioRecord, Snapshot } from "@hackutd/contracts";

export interface Job { id: string; key: string; kind: "run" | "analysis"; payload: { id: string }; state: "pending" | "running" | "completed" | "failed"; fence: number; leaseUntil: number; attempts: number; error: string | null }
/** Persistence boundary: production PostgreSQL, explicitly selected memory store for tests only. */
export interface Store {
  init(): Promise<void>;
  close(): Promise<void>;
  listDatasets(): Promise<ImportedDataset["info"][]>;
  getDataset(id: string): Promise<ImportedDataset | null>;
  putDataset(dataset: ImportedDataset): Promise<ImportedDataset>;
  listRuns(): Promise<RunRecord[]>;
  getRun(id: string): Promise<RunRecord | null>;
  putRun(run: RunRecord): Promise<void>;
  saveRun(run: RunRecord, claim?: { jobId: string; fence: number }): Promise<void>;
  getAnalysis(id: string): Promise<AnalysisRecord | null>;
  putAnalysis(analysis: AnalysisRecord): Promise<void>;
  saveAnalysis(analysis: AnalysisRecord, claim?: { jobId: string; fence: number }): Promise<void>;
  pendingAnalyses(): Promise<AnalysisRecord[]>;
  appendInference(runId: string, epochId: string, results: InferenceObservation[], claim?: { jobId: string; fence: number }): Promise<void>;
  listActions(runId: string): Promise<OperatorAction[]>;
  putAction(action: OperatorAction, idempotencyKey: string): Promise<OperatorAction>;
  getScenario(id: string): Promise<ScenarioRecord | null>;
  putScenario(scenario: ScenarioRecord, idempotencyKey: string): Promise<ScenarioRecord>;
  enqueueJob(key: string, kind: Job["kind"], id: string): Promise<Job>;
  claimJob(now?: number, leaseMs?: number): Promise<Job | null>;
  renewJob(jobId: string, fence: number, leaseMs?: number): Promise<boolean>;
  finishJob(jobId: string, fence: number, error?: string): Promise<boolean>;
  publish(runId: string, type: LiveEvent["type"], data: unknown, revision?: number): Promise<LiveEvent>;
  events(runId: string, after: number, limit?: number): Promise<LiveEvent[]>;
  snapshot(runId: string): Promise<Snapshot | null>;
}
