import type { DecisionRecord, EvalRecord, PromptVersion, StrategyVersion } from "./store";

const mean = (xs: number[]) => xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000 : null;

export interface VersionRow { role: string; version: number; author: string; status: string; trainMean: number | null; trainN: number; heldoutMean: number | null; heldoutN: number; acceptRate: number | null; meanTokens: number | null; meanLatencyMs: number | null; cycles: string[] }

/** Scores per prompt version and per strategy (run rows), from recorded evaluations only. */
export function versionTable(evals: EvalRecord[], prompts: PromptVersion[], strategies: StrategyVersion[]): VersionRow[] {
  const row = (role: string, version: number, author: string, status: string): VersionRow => {
    const mine = evals.filter((e) => e.role === role && (role === "run" ? e.strategyVersion === version : e.version === version));
    const train = mine.filter((e) => e.split === "train"), held = mine.filter((e) => e.split === "heldout");
    return { role, version, author, status, trainMean: mean(train.map((e) => e.score)), trainN: train.length, heldoutMean: mean(held.map((e) => e.score)), heldoutN: held.length,
      acceptRate: mean(mine.map((e) => (e.accepted ? 1 : 0))), meanTokens: mean(mine.map((e) => e.inputTokens + e.outputTokens)), meanLatencyMs: mean(mine.map((e) => e.latencyMs)), cycles: [...new Set(mine.map((e) => e.cycle))] };
  };
  return [...prompts.filter((p) => p.role !== "critic").map((p) => row(p.role, p.version, p.author, p.status)), ...strategies.map((s) => row("run", s.version, `strategy: ${s.name.split(":")[0]}`, s.status))];
}

/** Per-cycle mean of the champion configuration on held-out cases: the week-by-week trend. */
export function cycleTrend(evals: EvalRecord[]) {
  const cycles = [...new Set(evals.map((e) => e.cycle))];
  return cycles.map((cycle) => {
    const runs = evals.filter((e) => e.cycle === cycle && e.role === "run");
    return { cycle, trainRunScore: mean(runs.filter((e) => e.split === "train").map((e) => e.score)), heldoutRunScore: mean(runs.filter((e) => e.split === "heldout").map((e) => e.score)),
      tokens: runs.reduce((s, e) => s + e.inputTokens + e.outputTokens, 0) };
  });
}

/** Which plans held up: per recommended plan kind, how often the later window matched its tank forecast. */
export function planOutcomes(decisions: DecisionRecord[]) {
  const kinds = [...new Set(decisions.map((d) => d.recommendedKind))];
  return kinds.map((kind) => {
    const mine = decisions.filter((d) => d.recommendedKind === kind);
    const measured = mine.filter((d) => d.outcome?.forecastMatched !== null && d.outcome?.forecastMatched !== undefined);
    return { kind, decisions: mine.length, measured: measured.length, forecastMatchRate: mean(measured.map((d) => (d.outcome!.forecastMatched ? 1 : 0))),
      tankLimitReachedRate: mean(measured.map((d) => (d.outcome!.tankLimitReached ? 1 : 0))), meanCostUsd: mean(mine.map((d) => d.recommendedCostUsd)),
      agentAgreedRate: mean(mine.filter((d) => d.agentPlanId).map((d) => (d.agentPlanId === d.recommendedPlanId ? 1 : 0))) };
  });
}
