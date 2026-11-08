import { randomUUID } from "node:crypto";
import type { ImportedDataset, Snapshot } from "@hackutd/contracts";
import type { Case } from "../orchestration/cases";
import type { BoardFact } from "../orchestration/facts";
import { orchestrate, type AgentRunTrace, type PromptChoice, type Strategy, type TaskNode } from "../orchestration/orchestrator";
import { RUN_ROLES, SEED_TEMPLATES, validateCriticOutput, type CriticOutput, type Role } from "../orchestration/roles";
import { runSubAgent, type Model, type SubAgentResult } from "../orchestration/subagent";
import { decisionsFor, measureOutcome } from "./outcomes";
import { champions, type EvalRecord, type LearningStore, type PromptVersion } from "./store";

export interface CycleOptions {
  store: LearningStore; model: Model; cycle: string;
  train: { dataset: ImportedDataset; cases: Case[]; board?: BoardFact[] }; heldout: { dataset: ImportedDataset; cases: Case[]; board?: BoardFact[] };
  outcomeWindowHours?: number; promoteMargin?: number; criticRoles?: number; log?: (line: string) => void;
}
export interface CriticRun { role: Role; fromVersion: number; toVersion: number | null; result: SubAgentResult<CriticOutput> }
export interface CycleReport {
  cycle: string; champion: { prompts: Partial<Record<Role, number>>; strategy: number }; challengers: { prompts: Partial<Record<Role, number>>; strategy: number | null };
  traces: { caseId: string; config: "champion" | "challenger"; traceId: string; score: number; tokens: number }[];
  promotions: string[]; critic: CriticRun[]; heldout: { caseId: string; traceId: string; score: number }[];
}

const choice = (p: PromptVersion): PromptChoice => ({ version: p.version, template: p.template });
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

/** Evaluation rows for one trace: one per scored node plus one run row for the strategy. */
export function evalRows(trace: AgentRunTrace, cycle: string, split: "train" | "heldout", caseId: string): EvalRecord[] {
  const now = new Date().toISOString();
  const nodes = trace.nodes.filter((n) => n.score && n.role !== "orchestrator");
  return [
    ...nodes.map((n) => ({ id: `eval-${randomUUID()}`, cycle, split, caseId, agentRunId: trace.id, role: n.role as Role, version: n.promptVersion ?? 0, strategyVersion: trace.strategy.version,
      score: n.score!.total, parts: n.score, accepted: n.status === "accepted", inputTokens: n.inputTokens, outputTokens: n.outputTokens, latencyMs: n.latencyMs, createdAt: now })),
    { id: `eval-${randomUUID()}`, cycle, split, caseId, agentRunId: trace.id, role: "run", version: trace.strategy.version, strategyVersion: trace.strategy.version, score: trace.score,
      parts: trace.totals, accepted: !!trace.outputs.handoff, inputTokens: trace.totals.inputTokens, outputTokens: trace.totals.outputTokens, latencyMs: trace.totals.latencyMs, createdAt: now },
  ];
}

/**
 * One evaluation cycle ("week"): deploy the champion configuration and the challengers on this window's cases,
 * record decisions and their measured outcomes, promote challengers that beat the champion by a margin, let the
 * critic propose next week's challengers from this week's failures, then score the new champion on held-out cases.
 */
export async function runCycle(o: CycleOptions): Promise<CycleReport> {
  const log = o.log ?? (() => {});
  const margin = o.promoteMargin ?? 0.02;
  const current = await champions(o.store);
  const prompts = Object.fromEntries(RUN_ROLES.filter((r) => current.prompts[r]).map((r) => [r, choice(current.prompts[r]!)])) as Partial<Record<Role, PromptChoice>>;
  const challengerPrompts = { ...prompts, ...Object.fromEntries(Object.entries(current.challengers).filter(([r]) => r !== "critic").map(([r, p]) => [r, choice(p!)])) };
  const hasChallenger = Object.keys(current.challengers).some((r) => r !== "critic") || !!current.strategyChallenger;
  const report: CycleReport = { cycle: o.cycle, champion: { prompts: versions(prompts), strategy: current.strategy.version },
    challengers: { prompts: versions(Object.fromEntries(Object.entries(current.challengers).filter(([r]) => r !== "critic").map(([r, p]) => [r, choice(p!)]))), strategy: current.strategyChallenger?.version ?? null },
    traces: [], promotions: [], critic: [], heldout: [] };
  const championTraces: AgentRunTrace[] = [], challengerTraces: AgentRunTrace[] = [];
  const outcomeCache = new Map<number, Snapshot>();

  for (const c of o.train.cases) {
    const runs: [("champion" | "challenger"), Partial<Record<Role, PromptChoice>>, Strategy][] = [["champion", prompts, current.strategy]];
    if (hasChallenger) runs.push(["challenger", challengerPrompts, current.strategyChallenger ?? current.strategy]);
    for (const [config, p, strategy] of runs) {
      const trace = await orchestrate({ model: o.model, snapshot: c.snapshot, board: o.train.board, prompts: p, strategy, cycle: o.cycle, caseId: c.id });
      await o.store.saveTrace(trace);
      await o.store.addEvals(evalRows(trace, o.cycle, "train", c.id).map((e) => ({ ...e, parts: { ...(e.parts as object), config } })));
      (config === "champion" ? championTraces : challengerTraces).push(trace);
      report.traces.push({ caseId: c.id, config, traceId: trace.id, score: trace.score, tokens: trace.totals.inputTokens + trace.totals.outputTokens });
      log(`  ${o.cycle} ${c.id} ${config}: score ${trace.score}, ${trace.totals.accepted}/${trace.totals.nodes} accepted, ${trace.totals.inputTokens + trace.totals.outputTokens} tokens, ${(trace.totals.latencyMs / 1000).toFixed(1)} s`);
      if (config === "champion") {
        const decisions = decisionsFor(trace, c.snapshot, o.cycle, c.id, "simulate");
        for (const d of decisions) {
          const window = o.outcomeWindowHours ?? 6;
          d.outcome = await measureOutcome(o.train.dataset, c.at, d, noActionTripWithin(c.snapshot, d.incidentId, window), window, outcomeCache);
        }
        await o.store.addDecisions(decisions);
      }
    }
  }

  // Promotion: compare each challenger with the champion on this cycle's cases (same cases, same week).
  const roleScores = (traces: AgentRunTrace[], role: Role, version: number) => traces.flatMap((t) => t.nodes.filter((n) => n.role === role && n.score && n.promptVersion === version).map((n) => n.score!.total));
  const history = await o.store.listEvals();
  for (const [role, challenger] of Object.entries(current.challengers) as [Role, PromptVersion][]) {
    if (role === "critic") continue;
    const mine = roleScores(challengerTraces, role, challenger.version);
    // Champion baseline: this week's runs, else its train history. No samples on either side means untested, not lost.
    let base = roleScores(championTraces, role, current.prompts[role]!.version);
    if (!base.length) base = history.filter((e) => e.split === "train" && e.role === role && e.version === current.prompts[role]!.version).map((e) => e.score);
    if (!mine.length || !base.length) { report.promotions.push(`${role} v${challenger.version} untested this week (no ${role} runs); stays a challenger`); continue; }
    const a = mean(base), b = mean(mine);
    if (b >= a + margin) { await o.store.setPromptStatus(role, challenger.version, "champion"); report.promotions.push(`${role} v${challenger.version} promoted (${b.toFixed(3)} vs v${current.prompts[role]!.version} ${a.toFixed(3)})`); }
    else { await o.store.setPromptStatus(role, challenger.version, "retired"); report.promotions.push(`${role} v${challenger.version} retired (${b.toFixed(3)} vs v${current.prompts[role]!.version} ${a.toFixed(3)})`); }
  }
  if (current.strategyChallenger && !challengerTraces.length) report.promotions.push(`strategy v${current.strategyChallenger.version} untested this week (no cases); stays a challenger`);
  else if (current.strategyChallenger) {
    const a = mean(championTraces.map((t) => t.score)), b = mean(challengerTraces.map((t) => t.score));
    const promote = b >= a + margin;
    await o.store.setStrategyStatus(current.strategyChallenger.version, promote ? "champion" : "retired");
    report.promotions.push(`strategy v${current.strategyChallenger.version} ${promote ? "promoted" : "retired"} (run score ${b.toFixed(3)} vs v${current.strategy.version} ${a.toFixed(3)})`);
  }
  // Strategy tuner (deterministic): adjust decomposition granularity from what this cycle measured.
  const tuned = await tuneStrategy(o.store, championTraces);
  if (tuned) report.promotions.push(tuned);
  for (const line of report.promotions) log(`  ${line}`);

  // Critic: next week's challengers for the weakest roles, from this week's champion failures.
  const after = await champions(o.store);
  const allTraces = [...championTraces, ...challengerTraces];
  const weakest = RUN_ROLES.map((role) => ({ role, nodes: allTraces.flatMap((t) => t.nodes.filter((n) => n.role === role && n.score && n.promptVersion === after.prompts[role]?.version)) }))
    .filter((r) => r.nodes.length && mean(r.nodes.map((n) => n.score!.total)) < 0.9)
    .sort((a, b) => mean(a.nodes.map((n) => n.score!.total)) - mean(b.nodes.map((n) => n.score!.total))).slice(0, o.criticRoles ?? 2);
  const critic = after.prompts.critic;
  for (const { role, nodes } of weakest) {
    const base = after.prompts[role]!;
    const result = await runCritic(o.model, critic ? choice(critic) : { version: 1, template: SEED_TEMPLATES.critic }, role, base.template, nodes);
    let toVersion: number | null = null;
    if (result.status === "accepted" && result.output) {
      toVersion = Math.max(...(await o.store.listPrompts(role)).map((p) => p.version)) + 1;
      await o.store.addPrompt({ role, version: toVersion, parentVersion: base.version, template: result.output.template, author: "critic", rationale: result.output.rationale, status: "challenger", createdAt: new Date().toISOString() });
    }
    report.critic.push({ role, fromVersion: base.version, toVersion, result });
    log(`  critic on ${role} v${base.version}: ${result.status}${toVersion ? ` -> challenger v${toVersion}: ${result.output!.rationale}` : ` (${result.error})`}`);
  }

  // Held-out: the champion after promotion, on cases from a dataset never used for critique or promotion.
  const champ = await champions(o.store);
  const heldPrompts = Object.fromEntries(RUN_ROLES.filter((r) => champ.prompts[r]).map((r) => [r, choice(champ.prompts[r]!)])) as Partial<Record<Role, PromptChoice>>;
  for (const c of o.heldout.cases) {
    const trace = await orchestrate({ model: o.model, snapshot: c.snapshot, board: o.heldout.board, prompts: heldPrompts, strategy: champ.strategy, cycle: o.cycle, caseId: c.id });
    await o.store.saveTrace(trace);
    await o.store.addEvals(evalRows(trace, o.cycle, "heldout", c.id));
    report.heldout.push({ caseId: c.id, traceId: trace.id, score: trace.score });
    log(`  ${o.cycle} held-out ${c.id}: score ${trace.score} (prompts ${JSON.stringify(versions(heldPrompts))}, strategy v${champ.strategy.version})`);
  }
  return report;
}

function versions(p: Partial<Record<Role, PromptChoice>>) { return Object.fromEntries(Object.entries(p).map(([r, c]) => [r, c!.version])) as Partial<Record<Role, number>>; }
/**
 * The historical telemetry after the cutoff is what happened with nobody following the advice, so the forecast it
 * can check is the do-nothing option's: does it trip the tank within the window? Null when there is no such option.
 */
function noActionTripWithin(snapshot: Snapshot, incidentId: string, windowHours: number): boolean | null {
  const option = snapshot.alerts.find((i) => i.id === incidentId)?.options?.find((p) => p.kind === "do_nothing");
  if (!option) return null;
  return option.tankTrips && option.tripAtMin !== null && option.tripAtMin <= windowHours * 60;
}

/** The critic sees failures, rejected inputs and lint for one role, and proposes a full replacement template. */
export async function runCritic(model: Model, critic: PromptChoice, role: Role, template: string, nodes: TaskNode[]): Promise<SubAgentResult<CriticOutput>> {
  const failures = nodes.map((n) => ({ status: n.status, score: n.score, rejections: n.rejections.slice(-3), rejectedInputs: n.rejectedInputs.slice(-2).map((s) => s.slice(0, 400)),
    acceptedOutput: n.status === "accepted" ? JSON.stringify(n.output).slice(0, 500) : null, modelCalls: n.modelCalls, toolsCalled: n.toolsCalled }));
  return runSubAgent<CriticOutput>(model, {
    instructions: `${critic.template}\n\nRules: keep the agent's task and tools the same; the harness appends a fixed contract (advice only, grounded numbers, no completed actions), so do not repeat it. Write plain instructions without markup.`,
    prompt: `Improve the instructions for the ${role} agent. Call read_current_template and read_failures, then submit_prompt.`,
    tools: [
      { name: "read_current_template", description: "The agent's current instructions.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, execute: () => ({ role, template }) },
      { name: "read_failures", description: "This cycle's runs of the agent: scores (accepted, first try, readability lint of raw unix times / IDs / snake_case labels, agreement with the deterministic layer, brevity, efficiency), validator rejections and rejected inputs.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, execute: () => failures },
    ],
    submit: { name: "submit_prompt", description: "Submit the complete new instructions and a one-sentence rationale.", inputSchema: { type: "object", properties: { template: { type: "string" }, rationale: { type: "string" } }, required: ["template", "rationale"], additionalProperties: false }, validate: validateCriticOutput },
    maxSteps: 5,
  });
}

/**
 * Proposes the next strategy challenger from measured coverage: a coarse champion whose runs left most pump
 * failures unexplained gets a fine challenger; a fine champion capped below the number of pump failures gets a
 * higher cap. Promotion still needs a measured win.
 */
export async function tuneStrategy(store: LearningStore, traces: AgentRunTrace[]): Promise<string | null> {
  const { strategy, strategyChallenger } = await champions(store);
  if (strategyChallenger || !traces.length) return null;
  const pumps = traces.map((t) => t.alertsView.filter((a) => a.line.includes("pump down")).length);
  const explained = traces.map((t) => t.nodes.filter((n) => n.role === "plan_explainer" && n.status === "accepted").length);
  const coverage = mean(traces.map((_, k) => (pumps[k] ? Math.min(1, explained[k]! / pumps[k]!) : 1)));
  const version = Math.max(...(await store.listStrategies()).map((s) => s.version)) + 1;
  const now = new Date().toISOString();
  const tried = (await store.listStrategies()).filter((s) => s.status === "retired");
  // A plan-explainer prompt waiting for evaluation needs runs that spawn explainers, so a lost strategy may be retried.
  const explainerPending = !!(await champions(store)).challengers.plan_explainer;
  const seen = (explainers: string, cap: number) => !explainerPending && tried.some((s) => s.explainers === explainers && s.maxExplainers === cap);
  if (strategy.explainers === "on_request" && coverage < 0.5 && !seen("per_incident", strategy.maxExplainers)) {
    await store.addStrategy({ version, name: "fine: one plan explainer per pump-failure incident with validated plans, in parallel", explainers: "per_incident", maxExplainers: strategy.maxExplainers, allowRequests: true, parentVersion: strategy.version, rationale: `coverage ${coverage.toFixed(2)} under the coarse strategy${explainerPending ? "; a plan-explainer prompt is waiting for evaluation" : ""}`, status: "challenger", createdAt: now });
    return `strategy tuner: challenger v${version} (fine) because explainer coverage was ${coverage.toFixed(2)}`;
  }
  if (strategy.explainers === "per_incident" && Math.max(...pumps) > strategy.maxExplainers && strategy.maxExplainers < 6 && !seen("per_incident", Math.min(6, strategy.maxExplainers + 2))) {
    const cap = Math.min(6, strategy.maxExplainers + 2);
    await store.addStrategy({ ...strategy, version, name: `fine: up to ${cap} plan explainers in parallel`, maxExplainers: cap, parentVersion: strategy.version, rationale: `up to ${Math.max(...pumps)} pump failures per run exceeded the cap of ${strategy.maxExplainers}`, status: "challenger", createdAt: now });
    return `strategy tuner: challenger v${version} (cap ${cap}) because runs had up to ${Math.max(...pumps)} pump failures`;
  }
  return null;
}
