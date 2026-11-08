import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { DomainError, type OperatorAction, type Snapshot } from "@hackutd/contracts";
import type { Provider } from "../runtime";
import { createModel } from "../orchestration/subagent";
import { orchestrate, type AgentRunTrace, type PromptChoice, type TaskNode } from "../orchestration/orchestrator";
import { readBoardJsonl } from "../orchestration/cases";
import type { BoardFact } from "../orchestration/facts";
import type { Role } from "../orchestration/roles";
import { champions, MemoryLearningStore, PostgresLearningStore, type LearningStore } from "./store";
import { decisionsFor } from "./outcomes";
import { cycleTrend, planOutcomes, versionTable } from "./rollup";

export interface AgentLoopOptions { provider?: Provider; databaseUrl?: string; memory: boolean; learningFile?: string; boardJsonl?: string; boardSource?: "fpga" | "fakeboard" }
export interface LiveAgentRun { id: string; runId: string; status: "running" | "done" | "failed"; error: string | null; nodes: TaskNode[]; trace: AgentRunTrace | null; startedAt: string }

/**
 * Runs the deterministic orchestrator for an operator run using the learning store's champion prompts and strategy.
 * Advice only: the trace and decision rows are records; nothing here changes plans, actions or the snapshot.
 */
export class AgentLoopService {
  readonly learning: LearningStore;
  private readonly live = new Map<string, LiveAgentRun>();
  private readonly model;
  private readonly controller = new AbortController();
  private sql?: SQL;
  constructor(private readonly o: AgentLoopOptions) {
    if (!o.memory && o.databaseUrl) { this.sql = new SQL({ url: o.databaseUrl, max: 2 }); this.learning = new PostgresLearningStore(this.sql); }
    else this.learning = new MemoryLearningStore(o.learningFile);
    this.model = o.provider ? createModel(o.provider, { concurrency: 3 }) : null;
  }
  private ready?: Promise<void>;
  init() { return (this.ready ??= this.learning.init()); }
  board(): BoardFact[] { return this.o.boardJsonl ? readBoardJsonl(this.o.boardJsonl, this.o.boardSource) : []; }

  async start(snapshot: Snapshot, actions: OperatorAction[], test?: { model: NonNullable<AgentLoopService["model"]> }): Promise<LiveAgentRun> {
    const model = test?.model ?? this.model;
    if (!model) throw new DomainError("AGENTS_UNAVAILABLE", "Set NVIDIA_BASE_URL, NEMOTRON_MODEL and NVIDIA_API_KEY, or OPENROUTER_API_KEYS, to run the agent orchestrator", 409);
    await this.init();
    const champ = await champions(this.learning);
    const prompts = Object.fromEntries(Object.entries(champ.prompts).map(([r, p]) => [r, { version: p!.version, template: p!.template }])) as Partial<Record<Role, PromptChoice>>;
    const run: LiveAgentRun = { id: `agents-${randomUUID()}`, runId: snapshot.runId, status: "running", error: null, nodes: [], trace: null, startedAt: new Date().toISOString() };
    this.live.set(run.id, run);
    // Operators acknowledge a system plan ID (I-13); map it to the incident option it belongs to.
    const approvals = new Map<string, string>();
    for (const a of actions) {
      if (a.kind !== "acknowledge_advice" || !a.planId || a.revision !== snapshot.revision) continue;
      const option = snapshot.alerts.find((i) => i.id === a.incidentId)?.options?.find((p) => p.systemPlanId === a.planId || p.id === a.planId);
      if (option) approvals.set(a.incidentId, option.id);
    }
    void orchestrate({ model, snapshot, board: this.board(), prompts, strategy: champ.strategy, signal: this.controller.signal, cycle: "live", caseId: run.id, onNode: (n) => { if (!run.nodes.includes(n)) run.nodes.push(n); } })
      .then(async (trace) => {
        trace.id = run.id;
        run.trace = trace; run.nodes = trace.nodes; run.status = "done";
        await this.learning.saveTrace(trace);
        await this.learning.addDecisions(decisionsFor(trace, snapshot, "live", run.id, approvals));
      })
      .catch((e: unknown) => { run.status = "failed"; run.error = e instanceof Error ? e.message : String(e); });
    return run;
  }
  async get(id: string): Promise<LiveAgentRun> {
    const live = this.live.get(id);
    if (live) return live;
    await this.init();
    const trace = await this.learning.getTrace(id);
    if (!trace) throw new DomainError("NOT_FOUND", "Agent run not found", 404);
    return { id, runId: trace.runId, status: "done", error: null, nodes: trace.nodes, trace, startedAt: trace.startedAt };
  }
  async listForRun(runId: string) {
    await this.init();
    const saved = await this.learning.listTraces(runId);
    const running = [...this.live.values()].filter((r) => r.runId === runId && r.status === "running").map((r) => ({ id: r.id, status: r.status, startedAt: r.startedAt, score: null }));
    return [...running, ...saved.map((t) => ({ id: t.id, status: "done" as const, startedAt: t.startedAt, score: t.score }))];
  }
  /** Prompt versions, scores per version, the weekly trend and plan outcomes (no answer key anywhere). */
  async summary() {
    await this.init();
    if (this.learning instanceof MemoryLearningStore) this.learning.refresh();
    const [prompts, strategies, evals, decisions, traces] = await Promise.all([this.learning.listPrompts(), this.learning.listStrategies(), this.learning.listEvals(), this.learning.listDecisions(), this.learning.listTraces()]);
    const champ = await champions(this.learning);
    return { champions: { prompts: Object.fromEntries(Object.entries(champ.prompts).map(([r, p]) => [r, p!.version])), strategy: champ.strategy.version },
      versions: versionTable(evals, prompts, strategies), trend: cycleTrend(evals), plans: planOutcomes(decisions),
      prompts: prompts.map(({ role, version, parentVersion, author, rationale, status, template }) => ({ role, version, parentVersion, author, rationale, status, template })),
      strategies, recentTraces: traces.slice(-12).reverse().map((t) => ({ id: t.id, runId: t.runId, cycle: t.cycle, caseId: t.caseId, strategy: t.strategy.version, score: t.score, nodes: t.totals.nodes, accepted: t.totals.accepted })) };
  }
  async close() { this.controller.abort(); await this.learning.close(); await this.sql?.close(); }
}
