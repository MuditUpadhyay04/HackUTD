import type { Snapshot } from "@hackutd/contracts";
import { randomUUID } from "node:crypto";
import { alertsView } from "./specialists";
import { priorityOrder, runFacts, type BoardFact, type IncidentFact, type RunFacts } from "./facts";
import { contract, ROLES, scoreNode, type ExplainerOutput, type HandoffOutput, type NodeScore, type ReviewOutput, type Role, type RoleContext, type TriageOutput } from "./roles";
import { runSubAgent, type Model, type ToolDef } from "./subagent";

/** How the orchestrator decomposes a run. Versioned and promoted by outcome history like prompts. */
export interface Strategy { version: number; name: string; explainers: "per_incident" | "on_request"; maxExplainers: number; allowRequests: boolean }
export const SEED_STRATEGIES: Strategy[] = [
  { version: 1, name: "coarse: triage and handoff; explainers only when an agent requests one", explainers: "on_request", maxExplainers: 3, allowRequests: true },
  { version: 2, name: "fine: one plan explainer per pump-failure incident with validated plans, in parallel", explainers: "per_incident", maxExplainers: 3, allowRequests: true },
];

export interface Guards { maxDepth: number; maxNodes: number; maxTokens: number; deadlineMs: number; allowed: Partial<Record<Role, Role[]>> }
export const DEFAULT_GUARDS: Guards = { maxDepth: 3, maxNodes: 10, maxTokens: 150_000, deadlineMs: 150_000,
  allowed: { triage: ["plan_explainer", "evidence_reviewer"], plan_explainer: ["evidence_reviewer"], handoff: ["plan_explainer", "evidence_reviewer"], evidence_reviewer: [] } };

export interface PromptChoice { version: number; template: string }
export interface TaskNode {
  id: string; parentId: string | null; depth: number; role: Role | "orchestrator"; incidentId: string | null;
  requestedBy: string; reason: string; question: string | null; promptVersion: number | null;
  status: "accepted" | "rejected" | "failed" | "denied" | "cached" | "deterministic";
  toolsCalled: string[]; modelCalls: number; inputTokens: number; outputTokens: number; latencyMs: number;
  rejections: string[]; rejectedInputs: string[]; output: unknown; error: string | null; score: NodeScore | null; children: string[];
}
export interface AgentRunTrace {
  id: string; runId: string; revision: number; nowUnix: number; now: string; startedAt: string; cycle: string | null; caseId: string | null;
  strategy: Strategy; prompts: Partial<Record<Role, number>>; guards: Omit<Guards, "allowed">;
  alertsView: ReturnType<typeof alertsView>; board: BoardFact[]; nodes: TaskNode[];
  outputs: { triage: TriageOutput | null; explanations: ExplainerOutput[]; reviews: ReviewOutput[]; handoff: HandoffOutput | null };
  totals: { nodes: number; modelCalls: number; inputTokens: number; outputTokens: number; latencyMs: number; accepted: number; denied: number; maxDepth: number };
  score: number;
}

export interface OrchestrateOptions {
  model: Model; snapshot: Snapshot; board?: BoardFact[]; prompts: Partial<Record<Role, PromptChoice>>; strategy: Strategy;
  guards?: Guards; signal?: AbortSignal; cycle?: string; caseId?: string; onNode?: (node: TaskNode) => void;
}

/**
 * Deterministic orchestrator: it decides which scoped sub-agents run, enforces the guards on every sub-agent's
 * request_subtask, records the task tree, and never lets a model decide a plan (rule 12).
 */
export async function orchestrate(options: OrchestrateOptions): Promise<AgentRunTrace> {
  const guards = options.guards ?? DEFAULT_GUARDS;
  const facts = runFacts(options.snapshot, options.board);
  const started = Date.now();
  const nodes: TaskNode[] = [];
  const outputs: RoleContext["outputs"] = { explanations: [], reviews: [] };
  const done = new Map<string, TaskNode>();
  let tokens = 0;
  const node = (n: Omit<TaskNode, "id" | "children" | "toolsCalled" | "modelCalls" | "inputTokens" | "outputTokens" | "latencyMs" | "rejections" | "rejectedInputs" | "output" | "error" | "score"> & Partial<TaskNode>): TaskNode => {
    const value: TaskNode = { id: `n${nodes.length}`, children: [], toolsCalled: [], modelCalls: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0, rejections: [], rejectedInputs: [], output: null, error: null, score: null, ...n };
    nodes.push(value);
    if (value.parentId) nodes.find((p) => p.id === value.parentId)?.children.push(value.id);
    return value;
  };
  const root = node({ parentId: null, depth: 0, role: "orchestrator", incidentId: null, requestedBy: "board+software runtime", reason: triggerReason(facts), question: null, promptVersion: null, status: "deterministic",
    output: { strategy: options.strategy.name, alertsView: alertsView(facts) } });

  const spawn = async (role: Exclude<Role, "critic">, parent: TaskNode, incident: IncidentFact | undefined, reason: string, requestedBy: string, question?: string): Promise<TaskNode> => {
    const prompt = options.prompts[role] ?? { version: 0, template: "" };
    const n = node({ parentId: parent.id, depth: parent.depth + 1, role, incidentId: incident?.incidentId ?? null, requestedBy, reason, question: question ?? null, promptVersion: prompt.version, status: "failed" });
    const spec = ROLES[role];
    const ctx: RoleContext = { facts, incident, question, outputs };
    const canRequest = options.strategy.allowRequests && n.depth < guards.maxDepth && (guards.allowed[role] ?? []).length > 0;
    const tools: ToolDef[] = [...spec.tools(ctx)];
    if (canRequest) tools.push(requestTool(n));
    const result = await runSubAgent(options.model, {
      instructions: `${prompt.template}\n\n${contract(spec.submit.name, canRequest)}`, prompt: spec.task(ctx), tools,
      submit: { ...spec.submit, validate: (input) => spec.validate(ctx, input) }, maxSteps: spec.maxSteps, signal: options.signal,
    });
    tokens += result.inputTokens + result.outputTokens;
    Object.assign(n, { status: result.status, toolsCalled: result.toolsCalled, modelCalls: result.modelCalls, inputTokens: result.inputTokens, outputTokens: result.outputTokens,
      latencyMs: result.latencyMs, rejections: result.rejections, rejectedInputs: result.rejectedInputs, output: result.output, error: result.error, score: scoreNode(spec, ctx, result) });
    if (result.status === "accepted") {
      if (role === "triage") outputs.triage = result.output as TriageOutput;
      if (role === "plan_explainer") outputs.explanations.push(result.output as ExplainerOutput);
      if (role === "evidence_reviewer") outputs.reviews.push(result.output as ReviewOutput);
    }
    options.onNode?.(n);
    return n;
  };

  /** request_subtask: a structured request the orchestrator grants or refuses deterministically. */
  const requestTool = (parent: TaskNode): ToolDef => ({
    name: "request_subtask",
    description: `Ask the orchestrator for a specialist subtask. Allowed roles: ${(guards.allowed[parent.role as Role] ?? []).join(", ")}. Returns the child's accepted output or a refusal reason.`,
    inputSchema: { type: "object", properties: { role: { type: "string" }, incidentId: { type: "string" }, question: { type: "string" } }, required: ["role", "incidentId", "question"], additionalProperties: false },
    execute: async (input) => {
      const role = String(input.role) as Role, incidentId = String(input.incidentId), question = String(input.question ?? "").slice(0, 300);
      const refuse = (why: string) => { node({ parentId: parent.id, depth: parent.depth + 1, role: (ROLES as Record<string, unknown>)[role] ? role : "evidence_reviewer", incidentId, requestedBy: parent.id, reason: `refused: ${why}`, question, promptVersion: null, status: "denied" }); return { granted: false, reason: why }; };
      if (!(guards.allowed[parent.role as Role] ?? []).includes(role)) return refuse(`role ${role} is not allowed from ${parent.role}`);
      const incident = facts.incidents.find((i) => i.incidentId === incidentId);
      if (!incident) return refuse("unknown incident");
      if (parent.incidentId && parent.incidentId !== incidentId) return refuse("incident outside the requester's scope");
      if (role === "plan_explainer" && (incident.category !== "pump_failure" || !incident.plans.length)) return refuse("plan explainers need a pump failure with validated plans");
      if (parent.depth + 1 > guards.maxDepth) return refuse(`max depth ${guards.maxDepth}`);
      if (nodes.filter((n) => n.modelCalls > 0 || n.status === "failed").length >= guards.maxNodes) return refuse(`max ${guards.maxNodes} sub-agents per run`);
      if (tokens >= guards.maxTokens) return refuse(`token budget ${guards.maxTokens} used`);
      if (Date.now() - started > guards.deadlineMs * 0.7) return refuse("not enough time left in the run budget");
      const key = `${role}:${incidentId}`;
      const cached = done.get(key);
      if (cached) {
        node({ parentId: parent.id, depth: parent.depth + 1, role, incidentId, requestedBy: parent.id, reason: `duplicate of ${cached.id}; cached result returned`, question, promptVersion: cached.promptVersion, status: "cached", output: cached.output });
        return { granted: true, cached: true, output: cached.output };
      }
      const child = await spawn(role as Exclude<Role, "critic">, parent, incident, `requested by ${parent.role} ${parent.id}`, parent.id, question);
      if (child.status === "accepted") done.set(key, child);
      return child.status === "accepted" ? { granted: true, output: child.output } : { granted: true, failed: child.error };
    },
  });

  const ongoing = facts.incidents.filter((i) => i.status === "ongoing");
  const triage = await spawn("triage", root, undefined, "every run starts with triage", root.id);
  if (options.strategy.explainers === "per_incident") {
    const order = priorityOrder(facts);
    const targets = ongoing.filter((i) => i.category === "pump_failure" && i.plans.length && !done.has(`plan_explainer:${i.incidentId}`))
      .sort((a, b) => order.indexOf(a.incidentId) - order.indexOf(b.incidentId)).slice(0, options.strategy.maxExplainers);
    const children = await Promise.all(targets.map((i) => spawn("plan_explainer", root, i, "strategy: one explainer per pump failure with validated plans", root.id)));
    children.forEach((c) => { if (c.status === "accepted") done.set(`plan_explainer:${c.incidentId}`, c); });
  }
  void triage;
  const handoff = await spawn("handoff", root, undefined, "every run ends with the operator handoff", root.id);
  const scored = nodes.filter((n) => n.score);
  const trace: AgentRunTrace = {
    id: `agents-${randomUUID()}`, runId: facts.runId, revision: facts.revision, nowUnix: facts.nowUnix, now: facts.now, startedAt: new Date(started).toISOString(), cycle: options.cycle ?? null, caseId: options.caseId ?? null,
    strategy: options.strategy, prompts: Object.fromEntries(Object.entries(options.prompts).map(([k, v]) => [k, v!.version])),
    guards: { maxDepth: guards.maxDepth, maxNodes: guards.maxNodes, maxTokens: guards.maxTokens, deadlineMs: guards.deadlineMs }, alertsView: alertsView(facts), board: facts.board, nodes,
    outputs: { triage: outputs.triage ?? null, explanations: outputs.explanations, reviews: outputs.reviews, handoff: handoff.status === "accepted" ? handoff.output as HandoffOutput : null },
    totals: { nodes: scored.length, modelCalls: sum(nodes, "modelCalls"), inputTokens: sum(nodes, "inputTokens"), outputTokens: sum(nodes, "outputTokens"), latencyMs: Date.now() - started,
      accepted: nodes.filter((n) => n.status === "accepted").length, denied: nodes.filter((n) => n.status === "denied").length, maxDepth: Math.max(...nodes.map((n) => n.depth)) },
    score: strategyScore(facts, scored, sum(nodes, "inputTokens")),
  };
  return trace;
}

function triggerReason(facts: RunFacts): string {
  const board = facts.board.filter((b) => b.heads.length).map((b) => b.facilityId);
  const ongoing = facts.incidents.filter((i) => i.status === "ongoing").length;
  return `${ongoing} ongoing incidents from the software runtime${board.length ? `; board heads active at ${board.join(", ")}` : ""}`;
}
const sum = (nodes: TaskNode[], key: "modelCalls" | "inputTokens" | "outputTokens") => nodes.reduce((s, n) => s + n[key], 0);

/** Run score: mean node score, plus coverage of pump failures by an accepted explanation, minus token cost. */
export function strategyScore(facts: RunFacts, scored: TaskNode[], inputTokens: number): number {
  if (!scored.length) return 0;
  const mean = scored.reduce((s, n) => s + n.score!.total, 0) / scored.length;
  const pumps = facts.incidents.filter((i) => i.status === "ongoing" && i.category === "pump_failure" && i.plans.length);
  const explained = pumps.filter((i) => scored.some((n) => n.role === "plan_explainer" && n.status === "accepted" && n.incidentId === i.incidentId)).length;
  const coverage = pumps.length ? explained / pumps.length : 1;
  return Math.round((0.75 * mean + 0.25 * coverage - Math.min(0.1, inputTokens / 1_000_000)) * 1000) / 1000;
}
