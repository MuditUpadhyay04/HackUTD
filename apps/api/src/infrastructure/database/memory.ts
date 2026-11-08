import { DomainError, type AnalysisRecord, type ImportedDataset, type InferenceObservation, type LiveEvent, type OperatorAction, type RunRecord, type ScenarioRecord, type Snapshot } from "@hackutd/contracts";
import type { Job, Store } from "../../store";

const copy = <T>(v: T): T => structuredClone(v);
export const cleanAnalysis = (a: AnalysisRecord): AnalysisRecord => ({ id:a.id, runId:a.runId, inputRevision:a.inputRevision, state:a.state, source:a.source, ...(a.model === undefined ? {} : {model:a.model}), ...(a.fxSessionId === undefined ? {} : {fxSessionId:a.fxSessionId}), ...(a.messageId === undefined ? {} : {messageId:a.messageId}), steps:a.steps.map(s => ({agent:s.agent,model:s.model,text:s.text})), handoff:a.handoff, evidenceIds:a.evidenceIds, planIds:a.planIds, error:a.error, createdAt:a.createdAt });
const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
export function normalizeObservation(observation: InferenceObservation): {value: InferenceObservation; serialized: string} {
  const {facilityId,tsUnix,resultNo,provenance,status,body} = observation;
  if (typeof facilityId !== "string" || typeof provenance !== "string" || !Number.isFinite(tsUnix) || !Number.isSafeInteger(resultNo) || !Number.isInteger(status) || status < -2147483648 || status > 2147483647 || body === undefined) throw new DomainError("invalid_request", "Invalid inference observation", 400);
  let serialized: string;
  try { serialized = JSON.stringify(canonical({facilityId,tsUnix,resultNo,provenance,status,body})); } catch { throw new DomainError("invalid_request", "Inference observation must be JSON serializable", 400); }
  return {value:JSON.parse(serialized),serialized};
}
export function requestBody(value: OperatorAction | ScenarioRecord): string {
  const { id, createdAt, ...body } = value;
  return JSON.stringify(canonical(body));
}
export class MemoryStore implements Store {
  readonly mode = "memory";
  private datasets = new Map<string, ImportedDataset>(); private runs = new Map<string, RunRecord>();
  private analyses = new Map<string, AnalysisRecord>(); private actions = new Map<string, { request: string; value: OperatorAction }>();
  private scenarios = new Map<string, { request: string; value: ScenarioRecord }>(); private jobs = new Map<string, Job>();
  private outbox = new Map<string, LiveEvent[]>();
  private inference = new Map<string, string>();
  async init() {} async close() {}
  async listDatasets() { return copy([...this.datasets.values()].map(d => d.info)); }
  async getDataset(id: string) { return copy(this.datasets.get(id) ?? null); }
  async putDataset(d: ImportedDataset) { const existing = this.datasets.get(d.info.id); if (!existing) this.datasets.set(d.info.id, copy(d)); return copy(existing ?? d); }
  async listRuns() { return copy([...this.runs.values()]); }
  async getRun(id: string) { return copy(this.runs.get(id) ?? null); }
  async putRun(run: RunRecord) { if (!this.runs.has(run.id)) this.runs.set(run.id, copy(run)); }
  private check(claim: { jobId: string; fence: number } | undefined, kind: Job["kind"], id: string) { if (!claim) return; const j = this.jobs.get(claim.jobId); if (!j || j.state !== "running" || j.fence !== claim.fence || j.kind !== kind || j.payload.id !== id || j.leaseUntil <= Date.now()) throw new DomainError("stale_claim", "Job lease is no longer valid", 409); }
  async saveRun(run: RunRecord, claim?: { jobId: string; fence: number }) { this.check(claim, "run", run.id); const old = this.runs.get(run.id); if (!old) throw new DomainError("not_found", "Run not found", 404); if (old.status === "cancelled" && run.status !== "cancelled") throw new DomainError("cancelled", "Run is cancelled", 409); const value = copy(run); this.runs.set(run.id, value); if (value.status === "ready" && value.snapshot) { const event = this.emit(value.id, "snapshot", value.snapshot, value.snapshot.revision); value.snapshot.cursor = event.cursor; event.data = copy(value.snapshot); } }
  async getAnalysis(id: string) { return copy(this.analyses.get(id) ?? null); }
  async pendingAnalyses() { return copy([...this.analyses.values()].filter(a => a.state === "pending" || a.state === "running")); }
  async putAnalysis(a: AnalysisRecord) { if (!this.analyses.has(a.id)) this.analyses.set(a.id, copy(cleanAnalysis(a))); }
  async saveAnalysis(a: AnalysisRecord, claim?: { jobId: string; fence: number }) { this.check(claim, "analysis", a.id); const old = this.analyses.get(a.id); if (!old) throw new DomainError("not_found", "Analysis not found", 404); if (old.state === "cancelled" && a.state !== "cancelled") throw new DomainError("cancelled", "Analysis is cancelled", 409); this.analyses.set(a.id, copy(cleanAnalysis(a))); this.emit(a.runId, "analysis", cleanAnalysis(a), a.inputRevision); }
  async listActions(runId: string) { return copy([...this.actions.values()].map(x => x.value).filter(x => x.runId === runId)); }
  async putAction(a: OperatorAction, key: string) { const k = JSON.stringify([a.runId,key]), request = requestBody(a), old = this.actions.get(k); if (old) { if (old.request !== request) throw new DomainError("idempotency_conflict", "Idempotency key reused with different request", 409); return copy(old.value); } if (!this.runs.has(a.runId)) throw new DomainError("not_found", "Run not found", 404); this.actions.set(k,{request,value:copy(a)}); this.emit(a.runId,"operator_action",a,a.revision); return copy(a); }
  async getScenario(id: string) { return copy([...this.scenarios.values()].find(x => x.value.id === id)?.value ?? null); }
  async putScenario(s: ScenarioRecord, key: string) { const k = JSON.stringify([s.runId,key]), request = requestBody(s), old = this.scenarios.get(k); if (old) { if (old.request !== request) throw new DomainError("idempotency_conflict", "Idempotency key reused with different request", 409); return copy(old.value); } if (!this.runs.has(s.runId)) throw new DomainError("not_found", "Run not found", 404); this.scenarios.set(k,{request,value:copy(s)}); this.emit(s.runId,"scenario",s,s.inputRevision); return copy(s); }
  async enqueueJob(key: string, kind: Job["kind"], id: string) { const old = [...this.jobs.values()].find(j => j.key === key); if (old) { if (old.kind !== kind || old.payload.id !== id) throw new DomainError("idempotency_conflict", "Job key reused", 409); return copy(old); } const j: Job = { id: crypto.randomUUID(), key, kind, payload: { id }, state: "pending", fence: 0, leaseUntil: 0, attempts: 0, error: null }; this.jobs.set(j.id,j); return copy(j); }
  async claimJob(now = Date.now(), leaseMs = 30000) { const j = [...this.jobs.values()].find(j => j.state === "pending" || (j.state === "running" && j.leaseUntil <= now)); if (!j) return null; j.state = "running"; j.fence++; j.attempts++; j.leaseUntil = now + leaseMs; return copy(j); }
  async renewJob(id: string, fence: number, leaseMs = 30000) { const j = this.jobs.get(id), now = Date.now(); if (!j || j.state !== "running" || j.fence !== fence || j.leaseUntil <= now) return false; j.leaseUntil = now + leaseMs; return true; }
  async finishJob(id: string, fence: number, error?: string) { const j = this.jobs.get(id); if (!j || j.state !== "running" || j.fence !== fence || j.leaseUntil <= Date.now()) return false; j.state = error ? "failed" : "completed"; j.error = error ?? null; j.leaseUntil = 0; return true; }
  async appendInference(runId: string, epochId: string, results: InferenceObservation[], claim?: {jobId: string; fence: number}) {
    this.check(claim,"run",runId);
    const run = this.runs.get(runId);
    if (!run) throw new DomainError("not_found", "Run not found", 404);
    if (run.status === "cancelled") throw new DomainError("cancelled", "Run is cancelled", 409);
    const staged = new Map<string,string>();
    for (const observation of results) {
      const {value,serialized} = normalizeObservation(observation);
      const key = JSON.stringify([runId,epochId,value.resultNo]);
      const old = staged.get(key) ?? this.inference.get(key);
      if (old !== undefined && old !== serialized) throw new DomainError("inference_conflict", "Inference receipt has conflicting contents", 409);
      staged.set(key,serialized);
    }
    for (const [key,value] of staged) this.inference.set(key,value);
  }
  private emit(runId: string, type: LiveEvent["type"], data: unknown, revision = 0): LiveEvent { if (!this.runs.has(runId)) throw new DomainError("not_found", "Run not found", 404); const events = this.outbox.get(runId) ?? []; const e: LiveEvent = { runId, cursor: events.length + 1, revision, type, data: copy(data), createdAt: new Date().toISOString() }; events.push(e); this.outbox.set(runId,events); return e; }
  async publish(runId: string, type: LiveEvent["type"], data: unknown, revision = 0) { return copy(this.emit(runId,type,data,revision)); }
  async events(runId: string, after: number, limit = 100) { return copy((this.outbox.get(runId) ?? []).filter(e => e.cursor > after).slice(0,Math.max(0,Math.min(limit,1000)))); }
  async snapshot(runId: string): Promise<Snapshot | null> { const s = this.runs.get(runId)?.snapshot; return s ? { ...copy(s), cursor: (this.outbox.get(runId) ?? []).length } : null; }
}
