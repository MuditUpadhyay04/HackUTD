import type { Snapshot } from "@hackutd/contracts";
import { RUN_ROLES, SEED_TEMPLATES } from "./roles";
import { createModel } from "./subagent";

/** Test fixtures and a scripted OpenAI-compatible endpoint (no network). Not used at runtime. */
export const plan = (id: string, kind: string, cost: number, rev = 1) => ({ id, systemPlanId: `sys-${id}`, inputRevision: rev, kind, label: kind === "trucks" ? "Truck haul" : "Do nothing", cost, trucks: kind === "trucks" ? 2 : 0, tripsPerTruck: 1, truckArrivalsMin: [], shutIns: [], tankTrips: kind !== "trucks", tripAtMin: null, levelCurve: [], feasibility: "validated", searchStatus: "best_feasible_found" });
export const pump = (letter: string, hours: number, revenue: number) => ({ id: `run:pump_failure:S4_FACILITY_${letter}:100`, category: "pump_failure", status: "ongoing", systemId: "S4", facilityId: `S4_FACILITY_${letter}`, assetId: `S4_PUMP_${letter}`,
  onsetUnix: 1791450000, endUnix: null, confidence: null, evidence: ["Pump status reports fault (2)."], provenance: "software", modelVersion: null, levelPct: 92, lostRevenuePerHour: revenue,
  countdown: { status: "available", hours: { p10: hours, p50: hours, p90: hours }, source: "host", method: "m", quality: "VALID" }, planningStatus: "ready",
  plan: plan(`opt-${letter}-1`, "trucks", 1500.4), options: [plan(`opt-${letter}-1`, "trucks", 1500.4), plan(`opt-${letter}-2`, "do_nothing", 2858.33)] });
export const snapshot = { runId: "run", revision: 1, nowUnix: 1791460000, runtime: { scoresAvailable: false }, coverage: { complete: true }, recommendation: { state: "ready", inputRevision: 1, currentRevision: 1 },
  alerts: [pump("C", 2.78, 2450), pump("A", 0.5, 3931.25), { ...pump("B", 0, 0), id: "run:pipeline_leak:S5_FACILITY_B:100", category: "pipeline_leak", systemId: "S5", facilityId: "S5_FACILITY_B", assetId: "S5_PIPE_B", countdown: undefined, plan: undefined, options: [] }],
  history: [] } as unknown as Snapshot;
export const A = "run:pump_failure:S4_FACILITY_A:100", C = "run:pump_failure:S4_FACILITY_C:100", LEAK = "run:pipeline_leak:S5_FACILITY_B:100";

/** A scripted OpenAI-compatible endpoint: each role follows a fixed script keyed by how many assistant turns it has taken. */
const SUBMIT: Record<string, string> = { triage: "submit_triage", plan_explainer: "submit_explanation", evidence_reviewer: "submit_review", handoff: "submit_handoff", critic: "submit_prompt" };
export function scripted(scripts: Record<string, (step: number, prompt: string) => { name: string; args: unknown } | { text: string }>) {
  const requests: { role: string; step: number }[] = [];
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] };
    const names = (body.tools ?? []).map((t) => t.function.name);
    const role = Object.keys(scripts).find((r) => names.includes(SUBMIT[r]!))!;
    const step = body.messages.filter((m) => m.role === "assistant").length;
    requests.push({ role, step });
    const first = body.messages.find((m) => m.role === "user");
    const action = scripts[role]!(step, typeof first?.content === "string" ? first.content : JSON.stringify(first?.content ?? ""));
    const message = "text" in action ? { role: "assistant", content: action.text } : { role: "assistant", content: null, tool_calls: [{ id: `c${requests.length}`, type: "function", function: { name: action.name, arguments: JSON.stringify(action.args) } }] };
    return new Response(JSON.stringify({ id: "x", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, message, finish_reason: "text" in action ? "stop" : "tool_calls" }], usage: { prompt_tokens: 1000, completion_tokens: 50 } }), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { requests, model: createModel({ baseUrl: "https://llm.example/v1", model: "m", apiKey: "k" }, { fetch: fakeFetch, concurrency: 2 }) };
}
export const prompts = Object.fromEntries(RUN_ROLES.map((r) => [r, { version: 1, template: SEED_TEMPLATES[r] }]));

