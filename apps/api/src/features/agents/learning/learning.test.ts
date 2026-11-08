import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ImportedDataset } from "@hackutd/contracts";
import { A, C, LEAK, scripted, snapshot } from "../orchestration/testing";
import { champions, MemoryLearningStore } from "./store";
import { runCycle, tuneStrategy } from "./cycle";
import { cycleTrend, planOutcomes, versionTable } from "./rollup";
import { decisionsFor } from "./outcomes";
import { AgentLoopService } from "./service";

const dataset = { info: { label: "synthetic", startUnix: 1791000000, nowUnix: 1791460000 } } as unknown as ImportedDataset;
const goodTriage = () => ({ name: "submit_triage", args: { order: [A, C, LEAK], notes: [{ incidentId: A, note: "S4 A has 30m to the limit." }, { incidentId: C, note: "S4 C has 2h47m to the limit." }, { incidentId: LEAK, note: "S5 B pipeline leak needs a field inspection." }] } });

describe("learning store", () => {
  test("seeds v1 champions, keeps one champion per role, and persists to a file", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "learn-")), "state.json");
    const store = new MemoryLearningStore(file);
    await store.init();
    let c = await champions(store);
    expect(c.prompts.handoff!.version).toBe(1);
    expect(c.strategy.version).toBe(1);
    expect(c.strategyChallenger!.version).toBe(2);
    await store.addPrompt({ role: "handoff", version: 2, parentVersion: 1, template: "x".repeat(130), author: "critic", rationale: "r", status: "challenger", createdAt: "" });
    await store.setPromptStatus("handoff", 2, "champion");
    const reopened = new MemoryLearningStore(file);
    await reopened.init();
    c = await champions(reopened);
    expect(c.prompts.handoff!.version).toBe(2);
    expect((await reopened.listPrompts("handoff")).find((p) => p.version === 1)!.status).toBe("retired");
    expect(existsSync(file)).toBe(true);
  });
});

describe("weekly cycle", () => {
  test("A/B against challengers, promotes on a measured win, critic proposes a challenger, held-out scored", async () => {
    const store = new MemoryLearningStore();
    await store.init();
    // The champion handoff pastes an ID (lint), the critic-proposed version would not; strategy v2 adds explainers.
    const { model } = scripted({
      triage: goodTriage,
      plan_explainer: (_s, prompt) => prompt.includes(C)
        ? { name: "submit_explanation", args: { incidentId: C, presentFirstPlanId: "opt-C-1", explanation: "Truck haul costs $1,500 with 2h47m to the limit." } }
        : { name: "submit_explanation", args: { incidentId: A, presentFirstPlanId: "opt-A-1", explanation: "Truck haul costs $1,500 with 30m to the limit." } },
      evidence_reviewer: () => ({ name: "submit_review", args: { incidentId: A, answer: "Pump status reports fault (2)." } }),
      handoff: () => ({ name: "submit_handoff", args: { handoff: `S4 A, S4 C and S5 B need review; see ${A}:evidence:0 and plan opt-A-1.`, evidenceIds: [`${A}:evidence:0`], planIds: [] } }),
      critic: (step) => step === 0 ? { name: "read_failures", args: {} } : { name: "submit_prompt", args: { template: "You write the shift handoff for the next operator. Use the console's short facility names such as S4 A, never paste evidence or plan IDs into the prose (they go in the arrays), and keep it to three sentences.", rationale: "Readability lint flagged pasted IDs." } },
    });
    const cases = [{ id: "case-1", dataset: "synthetic", at: 1791460000, snapshot, systems: ["S4", "S5"], pumpIncidents: 2 }];
    const report = await runCycle({ store, model, cycle: "week1", train: { dataset, cases }, heldout: { dataset, cases }, outcomeWindowHours: 0 });
    expect(report.traces.map((t) => t.config)).toEqual(["champion", "challenger"]);
    expect(report.promotions.some((p) => p.startsWith("strategy v2 promoted"))).toBe(true);
    expect(report.critic.some((c) => c.role === "handoff" && c.toVersion === 2)).toBe(true);
    const after = await champions(store);
    expect(after.strategy.version).toBe(2);
    expect(after.challengers.handoff!.author).toBe("critic");
    expect(report.heldout).toHaveLength(1);
    const evals = await store.listEvals();
    expect(evals.some((e) => e.split === "heldout" && e.role === "run" && e.strategyVersion === 2)).toBe(true);
    const table = versionTable(evals, await store.listPrompts(), await store.listStrategies());
    expect(table.find((r) => r.role === "handoff" && r.version === 1)!.trainN).toBe(2);
    expect(cycleTrend(evals)[0]!.cycle).toBe("week1");
    const week2 = await runCycle({ store, model, cycle: "week2", train: { dataset, cases }, heldout: { dataset, cases: [] }, outcomeWindowHours: 0 });
    const repeat = week2.critic.find((c) => c.role === "handoff")!;
    expect(repeat.toVersion).toBeNull(); // the scripted critic repeats its template: not a new version
    expect(repeat.result.error).toContain("identical");
    const decisions = (await store.listDecisions()).filter((d) => d.cycle === "week1");
    expect(decisions.map((d) => [d.facilityId, d.approvedBy, d.outcome])).toEqual([["S4_FACILITY_C", "simulated", null], ["S4_FACILITY_A", "simulated", null]]);
  });
  test("strategy tuner proposes a fine challenger when coarse runs leave pump failures unexplained", async () => {
    const store = new MemoryLearningStore();
    await store.init();
    const trace = { alertsView: [{ rank: 1, incidentId: A, line: "S4 A pump down" }, { rank: 2, incidentId: C, line: "S4 C pump down" }], nodes: [] } as never;
    expect(await tuneStrategy(store, [trace])).toBeNull(); // a challenger is already under test
    await store.setStrategyStatus(2, "retired");
    expect(await tuneStrategy(store, [trace])).toBeNull(); // fine with this cap already lost once
    await store.setStrategyStatus(2, "champion");
    const busy = { alertsView: [1, 2, 3, 4].map((k) => ({ rank: k, incidentId: `i${k}`, line: "S2 A pump down" })), nodes: [] } as never;
    expect(await tuneStrategy(store, [busy])).toContain("cap 5");
    expect((await champions(store)).strategyChallenger!.maxExplainers).toBe(5);
  });
});

describe("plan outcomes", () => {
  test("decisions keep solver recommendation, agent advice and operator approval apart", () => {
    const trace = { id: "t", runId: "run", nodes: [{ role: "plan_explainer", status: "accepted", incidentId: C, output: { incidentId: C, presentFirstPlanId: "opt-C-2", explanation: "" } }] } as never;
    const rows = decisionsFor(trace, snapshot, "w", "case", new Map([[C, "opt-C-1"]]));
    const c = rows.find((r) => r.incidentId === C)!;
    expect(c).toMatchObject({ recommendedPlanId: "opt-C-1", agentPlanId: "opt-C-2", approvedPlanId: "opt-C-1", approvedBy: "operator" });
    expect(rows.find((r) => r.incidentId === A)!.approvedBy).toBeNull();
    const withOutcome = rows.map((r, k) => ({ ...r, outcome: { windowHours: 6, observedAtUnix: 1, maxLevelPct: 95, tankLimitReached: k === 0, incidentStillOngoing: false, forecastTankTrip: false, forecastMatched: k !== 0, recommendationJustified: k === 0 } }));
    expect(planOutcomes(withOutcome)[0]).toMatchObject({ kind: "trucks", decisions: 2, measured: 2, forecastMatchRate: 0.5, justifiedRate: 0.5, agentAgreedRate: 0 });
  });
});

describe("agent loop service", () => {
  test("runs champions in the background, records the tree and maps operator approvals to plan options", async () => {
    const service = new AgentLoopService({ memory: true });
    const { model } = scripted({ triage: goodTriage, plan_explainer: () => ({ text: "unused" }), evidence_reviewer: () => ({ text: "unused" }),
      handoff: () => ({ name: "submit_handoff", args: { handoff: "S4 A, S4 C and S5 B need review.", evidenceIds: [`${A}:evidence:0`], planIds: [] } }) });
    const ack = { id: "a1", runId: "run", incidentId: C, planId: "sys-opt-C-1", revision: 1, kind: "acknowledge_advice" as const, createdAt: "" };
    const run = await service.start(snapshot as never, [ack], { model });
    expect(run.status).toBe("running");
    for (let k = 0; k < 50 && run.status === "running"; k++) await Bun.sleep(10);
    const done = await service.get(run.id);
    expect(done.status).toBe("done");
    expect(done.trace!.nodes.map((n) => [n.role, n.status])).toEqual([["orchestrator", "deterministic"], ["triage", "accepted"], ["handoff", "accepted"]]);
    expect((await service.listForRun("run"))[0]!.id).toBe(run.id);
    const decisions = await service.learning.listDecisions();
    expect(decisions.find((d) => d.incidentId === C)).toMatchObject({ approvedPlanId: "opt-C-1", approvedBy: "operator" });
    expect((await service.summary()).recentTraces[0]!.id).toBe(run.id);
    await service.close();
  });
});
