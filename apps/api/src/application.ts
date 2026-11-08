import { createHash, randomUUID } from "node:crypto";
import { DomainError, type AnalysisRecord, type ImportedDataset, type OperatorAction, type RunInput, type RunRecord, type ScenarioRecord, type Snapshot, type SystemPlanResult, type TruckAssignment } from "@hackutd/contracts";
import type { Job, Store } from "./store";
import { importDataset } from "./features/datasets/service";
import { findDatasetFolders, readDatasetFolder } from "./features/datasets/folders";
import { buildRunSnapshot, planningInputForSnapshot, readBoardIndex } from "./features/runtimes/service";
import type { RegisteredModel } from "./features/runtimes/model";
import { validateSystemPlan } from "./features/planning/validator";
import { createAnalysisService } from "./features/agents/service";
import { AgentLoopService } from "./features/agents/learning/service";
import type { AppConfig } from "./infrastructure/config";

export class Application {
  readonly agents: ReturnType<typeof createAnalysisService>;
  readonly agentLoop: AgentLoopService;
  readonly cancellations = new Map<string, AbortController>();
  readonly modelFingerprint: string | null;
  constructor(readonly store: Store, readonly config: AppConfig, readonly model?: RegisteredModel) {
    this.agents = createAnalysisService({ store, provider: config.provider, sessionDir: config.sessionDir });
    this.agentLoop = new AgentLoopService({ provider: config.provider, databaseUrl: config.databaseUrl, memory: config.memory, learningFile: config.agentLearningFile, boardJsonl: config.boardJsonl, boardSource: config.boardSource });
    this.modelFingerprint = model ? createHash("sha256").update(JSON.stringify(model)).digest("hex") : null;
  }
  private folderStamps = new Map<string, string>();
  private folderSync: Promise<void> | null = null;
  readonly folderErrors = new Map<string, string>();
  /** Import every dataset folder under DATA_ROOT that is new or changed since the last look. Concurrent callers share
   * one pass; a bad folder is reported (folderErrors, console) and skipped, never fatal. */
  syncFolders(): Promise<void> {
    if (!this.config.dataRoots?.length) return Promise.resolve();
    this.folderSync ??= (async () => {
      try {
        for (const root of this.config.dataRoots!) for (const f of await findDatasetFolders(root)) {
          if (this.folderStamps.get(f.path) === f.stamp) continue;
          try {
            const info = await this.upload(await readDatasetFolder(f.path), f.label);
            this.folderErrors.delete(f.path);
            console.log(`[datasets] ${f.label}: ${info.id.slice(0, 12)} from ${f.path}${info.hardwareEligible ? "" : ` (software only: ${info.hardwareReasons.join("; ")})`}`);
          } catch (e) {
            this.folderErrors.set(f.path, e instanceof Error ? e.message : String(e));
            console.error(`[datasets] ${f.path} not loaded: ${this.folderErrors.get(f.path)}`);
          }
          this.folderStamps.set(f.path, f.stamp);
        }
      } finally { this.folderSync = null; }
    })();
    return this.folderSync;
  }
  async upload(files: { network: string; ops: string; telemetry: string }, label?: string) {
    const dataset = await importDataset(files, label);
    dataset.sourceFiles = { ...files };
    return (await this.store.putDataset(dataset)).info;
  }
  async requireDataset(id: string): Promise<ImportedDataset> {
    const d = await this.store.getDataset(id);
    if (!d) throw new DomainError("NOT_FOUND", "Dataset not found", 404);
    return d;
  }
  async requireRun(id: string): Promise<RunRecord> {
    const r = await this.store.getRun(id);
    if (!r) throw new DomainError("NOT_FOUND", "Run not found", 404);
    return r;
  }
  async requireSnapshot(id: string): Promise<Snapshot> {
    const r = await this.requireRun(id);
    const snapshot = await this.store.snapshot(id);
    if (r.status !== "ready" || !snapshot) throw new DomainError("RUN_NOT_READY", r.error ?? `Run is ${r.status}`, 409);
    return snapshot;
  }
  async createRun(input: RunInput): Promise<RunRecord> {
    const d = await this.requireDataset(input.datasetId);
    const at = input.at ?? d.info.nowUnix;
    if (!Number.isSafeInteger(at) || at < d.info.startUnix || at > d.info.nowUnix || (at - d.info.startUnix) % 300 !== 0) throw new DomainError("INVALID_CUTOFF", "Select a dataset timestamp on its five-minute grid");
    if (input.parentRunId) await this.requireRun(input.parentRunId);
    const id = input.idempotencyKey ? `run-${createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 32)}` : randomUUID();
    const existing = await this.store.getRun(id);
    if (existing) {
      if (existing.datasetId !== input.datasetId || existing.at !== at || existing.requested !== input.runtime || existing.parentRunId !== (input.parentRunId ?? null) || (existing.modelFingerprint ?? null) !== this.modelFingerprint) throw new DomainError("IDEMPOTENCY_CONFLICT", "Idempotency key was already used with different input", 409);
      await this.store.enqueueJob(`run:${id}`, "run", id);
      return existing;
    }
    const r: RunRecord = { id, datasetId: input.datasetId, at, requested: input.runtime, parentRunId: input.parentRunId ?? null, modelFingerprint: this.modelFingerprint, status: "pending", error: null, createdAt: new Date().toISOString(), snapshot: null };
    await this.store.putRun(r);
    await this.store.enqueueJob(`run:${id}`, "run", id);
    return r;
  }
  async cancelRun(id: string) {
    const r = await this.requireRun(id);
    if (["ready", "failed", "cancelled"].includes(r.status)) return r;
    this.cancellations.get(id)?.abort();
    const cancelled: RunRecord = { ...r, status: "cancelled", error: "Cancelled by operator" };
    await this.store.saveRun(cancelled);
    return cancelled;
  }
  async createAnalysis(runId: string, key?: string): Promise<AnalysisRecord> {
    const s = await this.requireSnapshot(runId);
    const id = key ? `analysis-${createHash("sha256").update(`${runId}:${key}`).digest("hex").slice(0, 32)}` : randomUUID();
    const old = await this.store.getAnalysis(id);
    if (old) return old;
    const a: AnalysisRecord = { id, runId, inputRevision: s.revision, state: "pending", source: "draft", steps: [], handoff: "", evidenceIds: [], planIds: [], error: null, createdAt: new Date().toISOString() };
    await this.store.putAnalysis(a);
    await this.store.enqueueJob(`analysis:${id}`, "analysis", id);
    return a;
  }
  /** Starts the Nemotron orchestrator (advice only) on the run's current snapshot; operator approvals feed the decision records. */
  async startAgentRun(runId: string) {
    const s = await this.requireSnapshot(runId);
    return this.agentLoop.start(s, await this.store.listActions(runId));
  }
  async requireAnalysis(id: string) {
    const a = await this.store.getAnalysis(id);
    if (!a) throw new DomainError("NOT_FOUND", "Analysis not found", 404);
    return a;
  }
  async cancelAnalysis(id: string) {
    const a = await this.requireAnalysis(id);
    if (["completed", "failed", "cancelled"].includes(a.state)) return a;
    this.cancellations.get(id)?.abort();
    await this.agents.cancel(id);
    const cancelled: AnalysisRecord = { ...a, state: "cancelled", error: "Cancelled by operator" };
    await this.store.saveAnalysis(cancelled);
    return cancelled;
  }
  async operatorAction(runId: string, body: Pick<OperatorAction, "incidentId" | "kind" | "planId" | "revision">, key: string) {
    const s = await this.requireSnapshot(runId);
    if (body.revision !== s.revision || s.recommendation.state !== "ready") throw new DomainError("STALE_PLAN", "Advice is stale; refresh before acknowledging", 409);
    const i = [...s.alerts, ...s.history].find(i => i.id === body.incidentId);
    if (!i) throw new DomainError("NOT_FOUND", "Incident not found in run", 404);
    if (body.kind === "acknowledge_advice" && (!body.planId || i.plan?.systemPlanId !== body.planId)) throw new DomainError("PLAN_MISMATCH", "Acknowledge the current immutable system plan", 409);
    if (body.kind === "inspection_ticket" && i.category === "pump_failure") throw new DomainError("ACTION_MISMATCH", "Inspection tickets are for leak and degradation advice");
    return this.store.putAction({ id: randomUUID(), runId, ...body, createdAt: new Date().toISOString() }, key);
  }
  async createScenario(runId: string, systemId: string, label: string, key: string, selectedSystemPlanId?: string): Promise<ScenarioRecord> {
    const s = await this.requireSnapshot(runId);
    if (!s.systems.some(sys => sys.id === systemId)) throw new DomainError("NOT_FOUND", "System not found in run", 404);
    const dataset = await this.requireDataset(s.dataset.id);
    const input = planningInputForSnapshot(dataset, s, systemId);
    const incidents = s.alerts.filter(i => i.systemId === systemId && i.category === "pump_failure");
    if (!incidents.length || incidents.some(i => !i.plan || i.planningStatus !== "ready")) throw new DomainError("SCENARIO_UNAVAILABLE", "A complete validated system response is required", 409);
    const planId = selectedSystemPlanId ?? incidents[0].plan!.systemPlanId;
    const recommendedByIncident: SystemPlanResult["recommendedByIncident"] = {};
    const optionsByIncident: SystemPlanResult["optionsByIncident"] = {};
    const assignments: TruckAssignment[] = [];
    let truck = 0;
    for (const i of incidents) {
      const option = i.options?.find(o => o.systemPlanId === planId);
      if (!option) throw new DomainError("INCOHERENT_SCENARIO", "Select a complete system alternative, not unrelated facility options", 409);
      recommendedByIncident[i.id] = structuredClone(option);
      optionsByIncident[i.id] = [structuredClone(option)];
      const job = input.jobs.find(j => j.incidentId === i.id)!;
      for (let n = 0; n < option.trucks; n++) assignments.push({ truck: ++truck, incidentId: i.id, facilityId: i.facilityId, fromUnix: s.nowUnix, toUnix: s.nowUnix + (option.truckArrivalsMin.at(-1)! + job.cycleMin) * 60, tripsArrivalUnix: option.truckArrivalsMin.map(t => s.nowUnix + t * 60) });
    }
    const result: SystemPlanResult = { id: planId, systemId, inputRevision: s.revision, recommendedByIncident, optionsByIncident, assignments,
      totalCost: Object.values(recommendedByIncident).reduce((sum, p) => sum + p.cost, 0), searchStatus: "best_feasible_found", policy: "Independent replay of a selected immutable system alternative", timedOut: false };
    const validation = validateSystemPlan(input, result);
    if (!validation.valid) throw new DomainError("INVALID_SCENARIO", "Selected actions failed independent validation", 409);
    return this.store.putScenario({ id: randomUUID(), runId, inputRevision: s.revision, systemId, label, actions: Object.values(recommendedByIncident), result, createdAt: new Date().toISOString() }, key);
  }
  async processJob(job: Job): Promise<void> {
    const claim = { jobId: job.id, fence: job.fence };
    const controller = new AbortController();
    this.cancellations.set(job.payload.id, controller);
    try {
      if (job.kind === "run") {
        const r = await this.requireRun(job.payload.id);
        if (["ready", "cancelled", "failed"].includes(r.status)) return;
        if ((r.modelFingerprint ?? null) !== this.modelFingerprint) throw new DomainError("MODEL_CHANGED", "The pinned model configuration changed; start a new run", 409);
        await this.store.saveRun({ ...r, status: "running" }, claim);
        const d = await this.requireDataset(r.datasetId);
        const snapshot = await buildRunSnapshot(d, { runId: r.id, at: r.at, runtime: r.requested, parentRunId: r.parentRunId ?? undefined, revision: 1 }, {
          signal: controller.signal, model: this.model,
          // BOARD_JSONL: listen.py's live file; re-read per run. Used only if it covers this dataset and cutoff.
          board: this.config.boardJsonl ? readBoardIndex(this.config.boardJsonl, this.config.boardSource) : undefined,
          onResults: batch => this.store.appendInference(r.id, r.id, batch, claim),
        });
        if (controller.signal.aborted) return;
        await this.store.saveRun({ ...r, status: "ready", snapshot }, claim);
      } else {
        const a = await this.requireAnalysis(job.payload.id);
        if (["completed", "cancelled", "failed"].includes(a.state)) return;
        const s = await this.requireSnapshot(a.runId);
        if (s.revision !== a.inputRevision) throw new DomainError("STALE_ANALYSIS", "Analysis input was superseded", 409);
        await this.store.saveAnalysis({ ...a, state: "running" }, claim);
        const result = await this.agents.generate(a, s, controller.signal, { onSession: async ({ fxSessionId, messageId }) => {
          await this.store.saveAnalysis({ ...a, state: "running", fxSessionId, messageId }, claim);
        } });
        if (controller.signal.aborted) return;
        await this.store.saveAnalysis(result, claim);
      }
    } catch (error) {
      const message = error instanceof DomainError ? error.message : "Processing failed; see server diagnostics";
      if (job.kind === "run") {
        const r = await this.store.getRun(job.payload.id);
        if (r && r.status !== "cancelled") await this.store.saveRun({ ...r, status: "failed", error: message }, claim);
      } else {
        const a = await this.store.getAnalysis(job.payload.id);
        if (a && a.state !== "cancelled") await this.store.saveAnalysis({ ...a, state: "failed", error: message }, claim);
      }
      throw error;
    } finally { this.cancellations.delete(job.payload.id); }
  }
  async close() { for (const c of this.cancellations.values()) c.abort(); await this.agents.close(); await this.agentLoop.close(); }
}
