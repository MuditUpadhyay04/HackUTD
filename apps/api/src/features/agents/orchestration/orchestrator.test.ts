import { describe, expect, test } from "bun:test";
import type { Snapshot } from "@hackutd/contracts";
import { boardFacts, priorityOrder, runFacts } from "./facts";
import { DEFAULT_GUARDS, orchestrate, SEED_STRATEGIES } from "./orchestrator";
import { RUN_ROLES, SEED_TEMPLATES, validateCriticOutput } from "./roles";
import { createModel } from "./subagent";

const plan = (id: string, kind: string, cost: number, rev = 1) => ({ id, systemPlanId: `sys-${id}`, inputRevision: rev, kind, label: kind === "trucks" ? "Truck haul" : "Do nothing", cost, trucks: kind === "trucks" ? 2 : 0, tripsPerTruck: 1, truckArrivalsMin: [], shutIns: [], tankTrips: kind !== "trucks", tripAtMin: null, levelCurve: [], feasibility: "validated", searchStatus: "best_feasible_found" });
const pump = (letter: string, hours: number, revenue: number) => ({ id: `run:pump_failure:S4_FACILITY_${letter}:100`, category: "pump_failure", status: "ongoing", systemId: "S4", facilityId: `S4_FACILITY_${letter}`, assetId: `S4_PUMP_${letter}`,
  onsetUnix: 1791450000, endUnix: null, confidence: null, evidence: ["Pump status reports fault (2)."], provenance: "software", modelVersion: null, levelPct: 92, lostRevenuePerHour: revenue,
  countdown: { status: "available", hours: { p10: hours, p50: hours, p90: hours }, source: "host", method: "m", quality: "VALID" }, planningStatus: "ready",
  plan: plan(`opt-${letter}-1`, "trucks", 1500.4), options: [plan(`opt-${letter}-1`, "trucks", 1500.4), plan(`opt-${letter}-2`, "do_nothing", 2858.33)] });
const snapshot = { runId: "run", revision: 1, nowUnix: 1791460000, runtime: { scoresAvailable: false }, coverage: { complete: true }, recommendation: { state: "ready", inputRevision: 1, currentRevision: 1 },
  alerts: [pump("C", 2.78, 2450), pump("A", 0.5, 3931.25), { ...pump("B", 0, 0), id: "run:pipeline_leak:S5_FACILITY_B:100", category: "pipeline_leak", systemId: "S5", facilityId: "S5_FACILITY_B", assetId: "S5_PIPE_B", countdown: undefined, plan: undefined, options: [] }],
  history: [] } as unknown as Snapshot;
const A = "run:pump_failure:S4_FACILITY_A:100", C = "run:pump_failure:S4_FACILITY_C:100", LEAK = "run:pipeline_leak:S5_FACILITY_B:100";

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
      { type: "result", facility: "S4_FACILITY_C", ts_unix: 1791460300, status: "VALID", active: ["pump_failure"] }, { type: "alert", facility: "S4_FACILITY_A" }], "fakeboard");
    expect(board[0]).toMatchObject({ facilityId: "S4_FACILITY_A", heads: ["pump_failure"], countdown: "2h47m", source: "fakeboard" });
    expect(runFacts(snapshot, board).board.map((b) => b.facilityId)).toEqual(["S4_FACILITY_A"]);
  });
});

/** A scripted OpenAI-compatible endpoint: each role follows a fixed script keyed by how many assistant turns it has taken. */
function scripted(scripts: Record<string, (step: number) => { name: string; args: unknown } | { text: string }>) {
  const requests: { role: string; step: number }[] = [];
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { messages: { role: string; content: unknown }[] };
    const system = String(body.messages.find((m) => m.role === "system")?.content ?? "");
    const role = Object.keys(scripts).find((r) => system.startsWith(SEED_TEMPLATES[r as keyof typeof SEED_TEMPLATES]))!;
    const step = body.messages.filter((m) => m.role === "assistant").length;
    requests.push({ role, step });
    const action = scripts[role]!(step);
    const message = "text" in action ? { role: "assistant", content: action.text } : { role: "assistant", content: null, tool_calls: [{ id: `c${requests.length}`, type: "function", function: { name: action.name, arguments: JSON.stringify(action.args) } }] };
    return new Response(JSON.stringify({ id: "x", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, message, finish_reason: "text" in action ? "stop" : "tool_calls" }], usage: { prompt_tokens: 1000, completion_tokens: 50 } }), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { requests, model: createModel({ baseUrl: "https://llm.example/v1", model: "m", apiKey: "k" }, { fetch: fakeFetch, concurrency: 2 }) };
}
const prompts = Object.fromEntries(RUN_ROLES.map((r) => [r, { version: 1, template: SEED_TEMPLATES[r] }]));

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
