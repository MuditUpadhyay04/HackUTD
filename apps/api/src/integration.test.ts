import { afterAll, describe, expect, test } from "bun:test";
import { Application } from "./application";
import { createApp } from "./app";
import { MemoryStore } from "./infrastructure/database";
import { workOne } from "./infrastructure/jobs/worker";
import type { AppConfig } from "./infrastructure/config";

export function fixtureFiles() {
  const network = { defaults: { tank_limits_pct: { warning: 80, shutdown: 92 } }, systems: [{ id: "north-field", center: [32, -96], truck_yard: [32, -96], disposal_site: { id: "disposal-x", lat: 32, lon: -96, pressure_psi: 900 }, facilities: [{ id: "pad-x", lat: 32, lon: -96,
    wells: [{ id: "well-x", baseline_water_bpd: 1440, oil_bpd: 240, gas_mcfd: 0 }], tank: { id: "tank-x", capacity_bbl: 1000 }, pump: { id: "pump-x", max_flow_bpd: 2000, start_level_pct: 70, stop_level_pct: 30 }, pipeline: { id: "pipe-x", max_bpd: 2500, max_pressure_psi: 1500 } }] }] };
  const ops = { prices: { oil_per_bbl: 60, gas_per_mcf: 3 }, expected_repair_hours: { pump_failure: 6 }, emergency_trucking: { truck_capacity_bbl: 100, cost_per_trip: 50 }, systems: { "north-field": { emergency_fleet_size: 1, facilities: { "pad-x": { response_min: 10, cycle_min: 60 } } } } };
  const rows = ["timestamp,ts_unix,asset_id,metric,value"];
  for (let step = 0; step < 4; step++) {
    const ts = 1791000000 + 300 * step;
    for (const [asset, metric, value] of [["pad-x", "inflow_bpd", 1440], ["tank-x", "level_pct", 70 + step / 2], ["pump-x", "status", step ? 2 : 1], ["pump-x", "flow_bpd", step ? 0 : 2000], ["pump-x", "discharge_psi", step ? 900 : 1050], ["pipe-x", "receive_flow_bpd", step ? 0 : 2000], ["pipe-x", "pressure_psi", step ? 900 : 950], ["well-x", "status", 1], ["well-x", "water_bpd", 1440]]) rows.push(`${new Date(ts * 1000).toISOString()},${ts},${asset},${metric},${value}`);
  }
  return { network: JSON.stringify(network), ops: JSON.stringify(ops), telemetry: rows.join("\n") };
}

export const testConfig: AppConfig = { host: "127.0.0.1", port: 3001, memory: true, apiToken: "test-token", insecureLocal: false, allowedOrigins: ["http://localhost:3000"], sessionDir: ".data/test-sessions" };

describe("operator API vertical slice", () => {
  const store = new MemoryStore();
  const service = new Application(store, testConfig);
  const api = createApp(service);
  afterAll(() => service.close());
  const call = (path: string, init: RequestInit = {}) => api.handle(new Request(`http://localhost/api${path}`, { ...init, headers: { authorization: "Bearer test-token", ...init.headers } }));
  const post = (path: string, body: unknown, key?: string) => call(path, { method: "POST", headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify(body) });

  test("denies missing credentials and hostile origins", async () => {
    expect((await api.handle(new Request("http://localhost/api/datasets"))).status).toBe(401);
    expect((await call("/datasets", { headers: { origin: "https://attacker.invalid" } })).status).toBe(403);
  });
  test("uploads, reconstructs, exports and persists advice without dispatch", async () => {
    const files = fixtureFiles();
    const form = new FormData();
    form.set("network", new File([files.network], "network.json", { type: "application/json" }));
    form.set("ops", new File([files.ops], "ops.json", { type: "application/json" }));
    form.set("telemetry", new File([files.telemetry], "telemetry.csv", { type: "text/csv" }));
    const uploaded = await call("/datasets", { method: "POST", body: form });
    expect(uploaded.status).toBe(201);
    const d = await uploaded.json();
    const created = await post("/runs", { datasetId: d.id, runtime: "auto" }, "run-first");
    expect(created.status).toBe(202);
    const r = await created.json();
    expect((await call(`/runs/${r.id}/snapshot`)).status).toBe(409);
    expect(await workOne(service)).toBe(true);
    const ready = await (await call(`/runs/${r.id}/snapshot`)).json();
    expect(ready.runId).toBe(r.id);
    expect(ready.runtime.effective).toBe("software");
    expect(ready.runtime.scoresAvailable).toBe(false);
    expect(ready.coverage.complete).toBe(true);
    expect(ready.alerts).toHaveLength(1);
    const incident = ready.alerts[0];
    expect(incident.confidence).toBeNull();
    expect(incident.plan.feasibility).toBe("validated");
    const action = { incidentId: incident.id, planId: incident.plan.systemPlanId, revision: ready.revision, kind: "acknowledge_advice" };
    const a = await (await post(`/runs/${r.id}/actions`, action, "ack-1")).json();
    const again = await (await post(`/runs/${r.id}/actions`, action, "ack-1")).json();
    expect(a.id).toBe(again.id);
    expect((await service.store.listActions(r.id)).length).toBe(1);
    expect((await post(`/runs/${r.id}/actions`, { ...action, revision: 2 }, "ack-2")).status).toBe(409);
    const scenario = await post(`/runs/${r.id}/scenarios`, { systemId: "north-field", label: "What if we follow this advice" }, "scenario-1");
    expect(scenario.status).toBe(200);
    expect((await scenario.json()).result.totalCost).toBeGreaterThanOrEqual(0);
    expect((await store.getDataset(d.id))?.sourceFiles).toEqual(files);
    const exported = await call(`/runs/${r.id}/export`);
    expect(exported.headers.get("content-disposition")).toContain("events.json");
    const events = await exported.json();
    expect(events[0].category).toBe("pump_failure");
    expect(events[0]).not.toHaveProperty("confidence");
    const agents = await post(`/runs/${r.id}/agents`, {});
    expect(agents.status).toBe(409); // no provider: the orchestrator never fabricates agent output
    const learning = await (await call("/agents/learning")).json();
    expect(learning.champions).toEqual({ prompts: { triage: 1, plan_explainer: 1, evidence_reviewer: 1, handoff: 1, critic: 1 }, strategy: 1 });
    expect(await (await call(`/runs/${r.id}/agent-runs`)).json()).toEqual([]);
    expect((await call("/agent-runs/agents-missing")).status).toBe(404);
    const analysis = await (await post(`/runs/${r.id}/analyses`, {}, "brief-1")).json();
    await workOne(service);
    const brief = await (await call(`/analyses/${analysis.id}`)).json();
    expect(brief.state).toBe("completed"); expect(brief.source).toBe("draft");
    expect(brief.handoff.toLowerCase()).toContain("classifier");
    expect((await store.snapshot(r.id))?.cursor).toBeGreaterThan(ready.cursor);
    expect((await api.handle(new Request("http://localhost/api/internal/providers"))).status).toBe(401);
    const providers = await (await call("/internal/providers")).json();
    expect(providers.next.lane).toBe("none");
    expect(providers.brev.configured).toBe(false);
    expect(providers.openrouter.keys).toEqual([]);
    expect(JSON.stringify(providers)).not.toContain("test-token");
    expect((await call("/internal/providers/probe", { method: "POST" })).status).toBe(200);
  });
  test("idempotency conflict, rewind isolation, unavailable FPGA and malformed files", async () => {
    const d = await service.upload(fixtureFiles());
    const a = await service.createRun({ datasetId: d.id, runtime: "software", at: d.startUnix, idempotencyKey: "causal" });
    const b = await service.createRun({ datasetId: d.id, runtime: "software", at: d.nowUnix, idempotencyKey: "later" });
    await workOne(service); await workOne(service);
    expect((await service.requireSnapshot(a.id)).alerts.length).toBe(0);
    expect((await service.requireSnapshot(b.id)).alerts.length).toBe(1);
    await expect(service.createRun({ datasetId: d.id, runtime: "auto", idempotencyKey: "causal" })).rejects.toThrow("Idempotency");
    const fpga = await service.createRun({ datasetId: d.id, runtime: "fpga" });
    await workOne(service);
    expect((await service.requireRun(fpga.id)).status).toBe("failed");
    expect((await service.requireRun(fpga.id)).error).toContain("FPGA");
    await expect(service.createRun({ datasetId: d.id, runtime: "software", at: d.startUnix + 1 })).rejects.toThrow("five-minute");
  });
  test("SSE resumes committed updates and aborts without retaining listeners", async () => {
    const r = (await store.listRuns()).find(r => r.status === "ready")!;
    const snap = await service.requireSnapshot(r.id);
    const event = await store.publish(r.id, "run", { state: "test" }, snap.revision);
    const controller = new AbortController();
    const response = await call(`/runs/${r.id}/events?after=${event.cursor - 1}`, { signal: controller.signal });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const value = (await reader.read()).value;
    const chunk = typeof value === "string" ? value : new TextDecoder().decode(value);
    expect(chunk).toContain(`id: ${event.cursor}`);
    controller.abort(); await reader.cancel();
  });
});
