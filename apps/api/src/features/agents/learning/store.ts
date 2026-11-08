import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SQL } from "bun";
import { SEED_STRATEGIES, type AgentRunTrace, type Strategy } from "../orchestration/orchestrator";
import { SEED_TEMPLATES, type Role } from "../orchestration/roles";

export type VersionStatus = "champion" | "challenger" | "retired";
export interface PromptVersion { role: Role; version: number; parentVersion: number | null; template: string; author: "seed" | "critic"; rationale: string; status: VersionStatus; createdAt: string }
export interface StrategyVersion extends Strategy { parentVersion: number | null; rationale: string; status: VersionStatus; createdAt: string }
export interface EvalRecord {
  id: string; cycle: string; split: "train" | "heldout"; caseId: string; agentRunId: string; role: Role | "run"; version: number; strategyVersion: number;
  score: number; parts: unknown; accepted: boolean; inputTokens: number; outputTokens: number; latencyMs: number; createdAt: string;
}
/** Measured later from telemetry of the following window (a runtime input), never from the answer key. */
export interface Outcome { windowHours: number; observedAtUnix: number; maxLevelPct: number | null; tankLimitReached: boolean | null; incidentStillOngoing: boolean | null; forecastTankTrip: boolean; forecastMatched: boolean | null }
export interface DecisionRecord {
  id: string; cycle: string; caseId: string; runId: string; agentRunId: string; incidentId: string; facilityId: string; recommendedPlanId: string; recommendedKind: string; recommendedCostUsd: number;
  agentPlanId: string | null; approvedPlanId: string | null; approvedBy: "operator" | "simulated" | null; outcome: Outcome | null; createdAt: string;
}

/** Prompt registry, strategy versions, evaluations, decisions/outcomes and traces. Memory (optionally file-backed) or PostgreSQL. */
export interface LearningStore {
  init(): Promise<void>; close(): Promise<void>;
  listPrompts(role?: Role): Promise<PromptVersion[]>; addPrompt(p: PromptVersion): Promise<void>; setPromptStatus(role: Role, version: number, status: VersionStatus): Promise<void>;
  listStrategies(): Promise<StrategyVersion[]>; addStrategy(s: StrategyVersion): Promise<void>; setStrategyStatus(version: number, status: VersionStatus): Promise<void>;
  addEvals(rows: EvalRecord[]): Promise<void>; listEvals(): Promise<EvalRecord[]>;
  addDecisions(rows: DecisionRecord[]): Promise<void>; listDecisions(): Promise<DecisionRecord[]>;
  saveTrace(trace: AgentRunTrace): Promise<void>; getTrace(id: string): Promise<AgentRunTrace | null>; listTraces(runId?: string): Promise<AgentRunTrace[]>;
}

export function seedPrompts(now = new Date().toISOString()): PromptVersion[] {
  return (Object.keys(SEED_TEMPLATES) as Role[]).map((role) => ({ role, version: 1, parentVersion: null, template: SEED_TEMPLATES[role], author: "seed", rationale: "initial template", status: "champion", createdAt: now }));
}
export function seedStrategies(now = new Date().toISOString()): StrategyVersion[] {
  return SEED_STRATEGIES.map((s) => ({ ...s, parentVersion: s.version === 1 ? null : 1, rationale: s.version === 1 ? "initial strategy" : "finer decomposition to compare against v1", status: s.version === 1 ? "champion" : "challenger", createdAt: now }));
}
export async function champions(store: LearningStore) {
  const prompts = await store.listPrompts();
  const roles = [...new Set(prompts.map((p) => p.role))];
  const pick = (role: Role, status: VersionStatus) => prompts.filter((p) => p.role === role && p.status === status).sort((a, b) => b.version - a.version)[0];
  const strategies = await store.listStrategies();
  return {
    prompts: Object.fromEntries(roles.map((r) => [r, pick(r, "champion")!]).filter(([, p]) => p)) as Partial<Record<Role, PromptVersion>>,
    challengers: Object.fromEntries(roles.map((r) => [r, pick(r, "challenger")]).filter(([, p]) => p)) as Partial<Record<Role, PromptVersion>>,
    strategy: strategies.filter((s) => s.status === "champion").sort((a, b) => b.version - a.version)[0]!,
    strategyChallenger: strategies.filter((s) => s.status === "challenger").sort((a, b) => b.version - a.version)[0],
  };
}

interface MemoryState { prompts: PromptVersion[]; strategies: StrategyVersion[]; evals: EvalRecord[]; decisions: DecisionRecord[]; traces: AgentRunTrace[] }

export class MemoryLearningStore implements LearningStore {
  private state: MemoryState = { prompts: [], strategies: [], evals: [], decisions: [], traces: [] };
  /** With a file, state survives restarts and is shared between the loop script and the API in memory mode. */
  constructor(private readonly file?: string) {}
  async init() {
    if (this.file && existsSync(this.file)) this.state = { ...this.state, ...JSON.parse(readFileSync(this.file, "utf8")) as Partial<MemoryState> };
    if (!this.state.prompts.length) this.state.prompts = seedPrompts();
    if (!this.state.strategies.length) this.state.strategies = seedStrategies();
    this.flush();
  }
  async close() { this.flush(); }
  private flush() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify({ ...this.state, traces: this.state.traces.slice(-200) }));
    renameSync(`${this.file}.tmp`, this.file);
  }
  async listPrompts(role?: Role) { return structuredClone(this.state.prompts.filter((p) => !role || p.role === role)); }
  async addPrompt(p: PromptVersion) { if (this.state.prompts.some((x) => x.role === p.role && x.version === p.version)) throw new Error("Prompt version exists"); this.state.prompts.push(structuredClone(p)); this.flush(); }
  async setPromptStatus(role: Role, version: number, status: VersionStatus) {
    for (const p of this.state.prompts) {
      if (p.role === role && p.version === version) p.status = status;
      else if (status === "champion" && p.role === role && p.status === "champion") p.status = "retired";
    }
    this.flush();
  }
  async listStrategies() { return structuredClone(this.state.strategies); }
  async addStrategy(s: StrategyVersion) { this.state.strategies.push(structuredClone(s)); this.flush(); }
  async setStrategyStatus(version: number, status: VersionStatus) {
    for (const s of this.state.strategies) { if (s.version === version) s.status = status; else if (status === "champion" && s.status === "champion") s.status = "retired"; }
    this.flush();
  }
  async addEvals(rows: EvalRecord[]) { this.state.evals.push(...structuredClone(rows)); this.flush(); }
  async listEvals() { return structuredClone(this.state.evals); }
  async addDecisions(rows: DecisionRecord[]) { this.state.decisions.push(...structuredClone(rows)); this.flush(); }
  async listDecisions() { return structuredClone(this.state.decisions); }
  async saveTrace(trace: AgentRunTrace) { this.state.traces = [...this.state.traces.filter((t) => t.id !== trace.id), structuredClone(trace)]; this.flush(); }
  async getTrace(id: string) { return structuredClone(this.state.traces.find((t) => t.id === id) ?? null); }
  async listTraces(runId?: string) { return structuredClone(this.state.traces.filter((t) => !runId || t.runId === runId)).reverse(); }
}

const parsed = (v: unknown) => typeof v === "string" ? JSON.parse(v) : v;
const json = (v: unknown) => JSON.stringify(v);

/** Same contract on PostgreSQL (db/migrations/002_agent_learning.sql); rows keep the full record as jsonb. */
export class PostgresLearningStore implements LearningStore {
  constructor(private readonly sql: SQL) {}
  async init() {
    const count = await this.sql`SELECT count(*)::int AS n FROM agent_prompt_versions`;
    if (!count[0].n) for (const p of seedPrompts()) await this.addPrompt(p);
    const strategies = await this.sql`SELECT count(*)::int AS n FROM agent_strategies`;
    if (!strategies[0].n) for (const s of seedStrategies()) await this.addStrategy(s);
  }
  async close() {}
  async listPrompts(role?: Role) {
    const rows = role ? await this.sql`SELECT body FROM agent_prompt_versions WHERE role=${role} ORDER BY role, version` : await this.sql`SELECT body FROM agent_prompt_versions ORDER BY role, version`;
    return rows.map((r: { body: unknown }) => parsed(r.body) as PromptVersion);
  }
  async addPrompt(p: PromptVersion) { await this.sql`INSERT INTO agent_prompt_versions(role,version,status,body) VALUES (${p.role},${p.version},${p.status},${json(p)}::text::jsonb)`; }
  async setPromptStatus(role: Role, version: number, status: VersionStatus) {
    await this.sql.begin(async (tx) => {
      if (status === "champion") await tx`UPDATE agent_prompt_versions SET status='retired', body=jsonb_set(body,'{status}','"retired"') WHERE role=${role} AND status='champion' AND version<>${version}`;
      await tx`UPDATE agent_prompt_versions SET status=${status}, body=jsonb_set(body,'{status}',to_jsonb(${status}::text)) WHERE role=${role} AND version=${version}`;
    });
  }
  async listStrategies() { return (await this.sql`SELECT body FROM agent_strategies ORDER BY version`).map((r: { body: unknown }) => parsed(r.body) as StrategyVersion); }
  async addStrategy(s: StrategyVersion) { await this.sql`INSERT INTO agent_strategies(version,status,body) VALUES (${s.version},${s.status},${json(s)}::text::jsonb)`; }
  async setStrategyStatus(version: number, status: VersionStatus) {
    await this.sql.begin(async (tx) => {
      if (status === "champion") await tx`UPDATE agent_strategies SET status='retired', body=jsonb_set(body,'{status}','"retired"') WHERE status='champion' AND version<>${version}`;
      await tx`UPDATE agent_strategies SET status=${status}, body=jsonb_set(body,'{status}',to_jsonb(${status}::text)) WHERE version=${version}`;
    });
  }
  async addEvals(rows: EvalRecord[]) { for (const r of rows) await this.sql`INSERT INTO agent_evals(id,cycle,split,role,version,score,body) VALUES (${r.id},${r.cycle},${r.split},${r.role},${r.version},${r.score},${json(r)}::text::jsonb)`; }
  async listEvals() { return (await this.sql`SELECT body FROM agent_evals ORDER BY created_at, id`).map((r: { body: unknown }) => parsed(r.body) as EvalRecord); }
  async addDecisions(rows: DecisionRecord[]) { for (const r of rows) await this.sql`INSERT INTO agent_decisions(id,cycle,incident_id,body) VALUES (${r.id},${r.cycle},${r.incidentId},${json(r)}::text::jsonb)`; }
  async listDecisions() { return (await this.sql`SELECT body FROM agent_decisions ORDER BY created_at, id`).map((r: { body: unknown }) => parsed(r.body) as DecisionRecord); }
  async saveTrace(t: AgentRunTrace) { await this.sql`INSERT INTO agent_runs(id,run_id,body) VALUES (${t.id},${t.runId},${json(t)}::text::jsonb) ON CONFLICT (id) DO UPDATE SET body=excluded.body`; }
  async getTrace(id: string) { const rows = await this.sql`SELECT body FROM agent_runs WHERE id=${id}`; return rows[0] ? parsed(rows[0].body) as AgentRunTrace : null; }
  async listTraces(runId?: string) {
    const rows = runId ? await this.sql`SELECT body FROM agent_runs WHERE run_id=${runId} ORDER BY created_at DESC LIMIT 50` : await this.sql`SELECT body FROM agent_runs ORDER BY created_at DESC LIMIT 50`;
    return rows.map((r: { body: unknown }) => parsed(r.body) as AgentRunTrace);
  }
}
