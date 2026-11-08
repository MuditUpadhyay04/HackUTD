import { describe, expect, test } from "bun:test";
import { boardFacts, priorityOrder, runFacts } from "./facts";
import { DEFAULT_GUARDS, orchestrate, SEED_STRATEGIES } from "./orchestrator";
import { validateCriticOutput } from "./roles";
import { A, C, LEAK, prompts, scripted, snapshot } from "./testing";

describe("deterministic facts", () => {
  test("rule 7 order and display fields", () => {
    const facts = runFacts(snapshot);
    expect(priorityOrder(facts)).toEqual([A, C, LEAK]);
    const c = facts.incidents.find((i) => i.incidentId === C)!;
    expect(c.countdown).toBe("2h47m");
    expect(c.facilityLabel).toBe("S4 C");
    expect(c.plans.map((p) => [p.planId, p.costUsd, p.recommended])).toEqual([["opt-C-1", 1500, true], ["opt-C-2", 2858, false]]);
  });
  test("board facts keep the latest result per facility at or before the cutoff", () => {
    const board = boardFacts([{ type: "result", facility: "S4_FACILITY_A", ts_unix: 1, status: "VALID", active: [] }, { type: "result", facility: "S4_FACILITY_A", ts_unix: 2, status: "VALID", active: ["pump_failure"], countdown_min: { p50: 167 } },
      { type: "result", facility: "S4_FACILITY_A", ts_unix: 1791460500, status: "VALID", active: [] },
      { type: "result", facility: "S4_FACILITY_C", ts_unix: 1791460300, status: "VALID", active: ["pump_failure"] }, { type: "alert", facility: "S4_FACILITY_A" }], "fakeboard");
    expect(board).toHaveLength(4);
    const now = runFacts(snapshot, board).board;
    expect(now).toHaveLength(1);
    expect(now[0]).toMatchObject({ facilityId: "S4_FACILITY_A", tsUnix: 2, heads: ["pump_failure"], countdown: "2h47m", source: "fakeboard" });
  });
});

describe("board provenance", () => {
  test("each line keeps its own source and model version; unlabeled lines are unverified; old results are stale", () => {
    const board = boardFacts([
      { type: "result", facility: "S4_FACILITY_A", ts_unix: snapshot.nowUnix - 300, status: "VALID", active: ["pump_failure"], source: "fpga", weights_ver: 4 },
      { type: "result", facility: "S4_FACILITY_C", ts_unix: snapshot.nowUnix - 3600, status: "VALID", active: [], weights_ver: 4 },
    ]);
    const now = runFacts(snapshot, board).board;
    expect(now.find((b) => b.facilityId === "S4_FACILITY_A")).toMatchObject({ source: "fpga", weightsVer: 4, stale: false });
    expect(now.find((b) => b.facilityId === "S4_FACILITY_C")).toMatchObject({ source: "unverified", weightsVer: 4, stale: true });
  });
});

describe("empty shift", () => {
  test("with no ongoing incidents the orchestrator writes the handoff itself and never asks the model for one", async () => {
    const empty = { ...snapshot, alerts: [] } as unknown as typeof snapshot;
    const { requests, model } = scripted({ triage: () => ({ name: "submit_triage", args: { order: [], notes: [] } }), handoff: () => ({ text: "should not be called" }) });
    const trace = await orchestrate({ model, snapshot: empty, prompts, strategy: SEED_STRATEGIES[1]! });
    expect(requests.some((r) => r.role === "handoff")).toBe(false);
    const handoff = trace.nodes.find((n) => n.role === "handoff")!;
    expect(handoff.status).toBe("deterministic");
    expect(trace.outputs.handoff?.handoff).toStartWith("No ongoing incidents at ");
  });
});

describe("fallbacks", () => {
  test("when Nemotron's triage and handoff are never accepted, the orchestrator writes them from the facts and says so", async () => {
    const { model } = scripted({ triage: () => ({ text: "thinking..." }), plan_explainer: () => ({ text: "..." }), handoff: () => ({ text: "..." }) });
    const trace = await orchestrate({ model, snapshot, prompts, strategy: SEED_STRATEGIES[0]! });
    expect(trace.fallbacks).toEqual(["triage", "handoff"]);
    expect(trace.outputs.handoff).toBeNull(); // the learning loop must not count a fallback as an accepted handoff
    const fb = trace.nodes.filter((n) => n.status === "deterministic" && n.role === "handoff")[0]!;
    expect(fb.reason).toStartWith("fallback:");
    expect((fb.output as { handoff: string }).handoff).toContain("written by the orchestrator");
    expect(trace.outputs.triage?.order).toEqual([A, C, LEAK]);
  });
});

describe("orchestrator task tree", () => {
  test("grants, caches and refuses sub-agent requests under the guards, and records every node", async () => {
    const { model } = scripted({
      triage: () => ({ name: "submit_triage", args: { order: ["S4_FACILITY_A", "S4_FACILITY_C", "S5_FACILITY_B"], notes: { S4_FACILITY_A: "S4 A has 30m to the limit.", S4_FACILITY_C: "S4 C has 2h47m to the limit.", S5_FACILITY_B: "S5 B pipeline leak needs a field inspection." } } }),
      handoff: (step) => [
        { name: "request_subtask", args: { role: "plan_explainer", incidentId: C, question: "Which option first?" } },
        { name: "request_subtask", args: { role: "plan_explainer", incidentId: C, question: "Again?" } },
        { name: "request_subtask", args: { role: "plan_explainer", incidentId: LEAK, question: "Plans for the leak?" } },
        { name: "submit_handoff", args: { handoff: "S4 A has 30m to the limit and S4 C has 2h47m; S5 B pipeline leak needs a field inspection.", evidenceIds: [`${A}:evidence:0`], planIds: [] } },
      ][Math.min(step, 3)]!,
      plan_explainer: (step) => step === 0 ? { name: "request_subtask", args: { role: "evidence_reviewer", incidentId: C, question: "Is the fault reading trustworthy?" } }
        : step === 1 ? { text: "The truck haul is cheaper." } : { name: "submit_explanation", args: { incidentId: C, presentFirstPlanId: "opt-C-1", explanation: "Truck haul costs $1,500, $1,358 less than doing nothing, with 2h47m to the limit." } },
      evidence_reviewer: () => ({ name: "submit_review", args: { incidentId: C, answer: "Pump status reports fault (2) with VALID countdown data." } }),
    });
    const trace = await orchestrate({ model, snapshot, prompts, strategy: SEED_STRATEGIES[0]! });
    const byRole = (r: string) => trace.nodes.filter((n) => n.role === r);
    expect(byRole("triage")[0]!.status).toBe("accepted");
    expect(byRole("triage")[0]!.score!.agreement).toBe(1);
    const explainer = byRole("plan_explainer").find((n) => n.status === "accepted")!;
    expect(explainer.depth).toBe(2);
    expect(explainer.requestedBy).toBe(byRole("handoff")[0]!.id);
    expect(explainer.score!.agreement).toBe(1);
    const review = byRole("evidence_reviewer")[0]!;
    expect(review).toMatchObject({ depth: 3, status: "accepted", parentId: explainer.id });
    expect(byRole("plan_explainer").find((n) => n.status === "cached")!.reason).toContain("duplicate");
    expect(trace.nodes.find((n) => n.status === "denied")!.reason).toContain("pump failure with validated plans");
    expect(trace.outputs.handoff!.handoff).toContain("S5 B");
    expect(trace.totals.maxDepth).toBe(3);
    expect(trace.totals.denied).toBe(1);
    expect(trace.score).toBeGreaterThan(0.5);
  });
  test("depth and node guards refuse further delegation; fine strategy spawns explainers in parallel", async () => {
    const { model, requests } = scripted({
      triage: () => ({ name: "submit_triage", args: { order: [A, C, LEAK], notes: [{ incidentId: A, note: "S4 A first." }, { incidentId: C, note: "S4 C second." }, { incidentId: LEAK, note: "S5 B inspection." }] } }),
      plan_explainer: (step) => step === 0 ? { name: "request_subtask", args: { role: "evidence_reviewer", incidentId: A, question: "Check A" } }
        : { name: "submit_explanation", args: { incidentId: step === 1 ? A : A, presentFirstPlanId: "opt-A-2", explanation: "Doing nothing costs $2,858." } },
      evidence_reviewer: () => ({ name: "submit_review", args: { incidentId: A, answer: "Pump status reports fault (2)." } }),
      handoff: () => ({ name: "submit_handoff", args: { handoff: "S4 A and S4 C pump failures; S5 B pipeline leak.", evidenceIds: [`${A}:evidence:0`], planIds: ["opt-A-1"] } }),
    });
    const trace = await orchestrate({ model, snapshot, prompts, strategy: SEED_STRATEGIES[1]!, guards: { ...DEFAULT_GUARDS, maxDepth: 1 } });
    const explainers = trace.nodes.filter((n) => n.role === "plan_explainer");
    expect(explainers.map((n) => n.depth)).toEqual([1, 1]);
    expect(trace.nodes.some((n) => n.role === "evidence_reviewer")).toBe(false);
    expect(requests.filter((r) => r.role === "plan_explainer").length).toBeGreaterThan(0);
    const a = explainers.find((n) => n.incidentId === A)!;
    expect(a.status).toBe("accepted");
    expect(a.score!.agreement).toBe(0);
    expect(explainers.find((n) => n.incidentId === C)!.status).not.toBe("accepted");
  });
});

describe("critic output", () => {
  test("accepts a revised template and refuses unsafe ones", () => {
    const template = "You write the shift handoff. Use facility short names like the console does and never paste plan or evidence IDs into the prose; they belong in the arrays. Keep it under five sentences.";
    expect(validateCriticOutput({ template, rationale: "IDs made handoffs too long." }).template).toBe(template);
    expect(() => validateCriticOutput({ template: template + " Read the answer key first.", rationale: "x" })).toThrow("answer key");
    expect(() => validateCriticOutput({ template: "short", rationale: "x" })).toThrow("120 to 2500");
    expect(() => validateCriticOutput({ template: template + " Contract (fixed by the harness): none.", rationale: "x" })).toThrow("fixed contract");
  });
});
