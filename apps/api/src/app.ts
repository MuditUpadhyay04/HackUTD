import { Elysia, sse, t } from "elysia";
import { DomainError } from "@hackutd/contracts";
import type { Application } from "./application";
import { authorize } from "./infrastructure/auth";
import { exportEvents } from "./features/export/service";

const id = t.String({ minLength: 1, maxLength: 200 });
const mode = t.Union([t.Literal("auto"), t.Literal("software"), t.Literal("fpga")]);
const keyOf = (request: Request) => {
  const key = request.headers.get("idempotency-key");
  if (key && (key.length > 200 || !/^[\x21-\x7e]+$/.test(key))) throw new DomainError("INVALID_KEY", "Invalid idempotency key");
  return key ?? undefined;
};
const requiredKey = (request: Request) => { const k = keyOf(request); if (!k) throw new DomainError("KEY_REQUIRED", "Idempotency-Key is required"); return k; };

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    if (signal.aborted) return resolve();
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** Listener-free application factory. Browser imports ONLY its inferred type. */
export function createApp(service: Application) {
  // Room for the largest network the board takes (32 facilities x 8 wells, a week: ~1.5M rows, ~90 MB) plus multipart.
  return new Elysia({ serve: { maxRequestBodySize: 176 * 1024 * 1024 } })
    .onRequest(({ request, set }) => {
      const origin = request.headers.get("origin");
      if (request.method === "OPTIONS") {
        if (!origin || !service.config.allowedOrigins.includes(origin)) return new Response(null, { status: 403 });
        return new Response(null, { status: 204, headers: { "access-control-allow-origin": origin, "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "Authorization,Content-Type,Idempotency-Key,Last-Event-ID", "vary": "Origin" } });
      }
      authorize(request, service.config);
      set.headers["cache-control"] = "no-store";
      set.headers["x-content-type-options"] = "nosniff";
      if (origin) { set.headers["access-control-allow-origin"] = origin; set.headers.vary = "Origin"; }
    })
    .onError(({ error, code, set }) => {
      if (error instanceof DomainError) { set.status = error.status; return { error: error.message, code: error.code, issues: error.issues }; }
      if (code === "VALIDATION" || code === "PARSE") { set.status = 400; return { error: "Invalid request", code: "INVALID_REQUEST" }; }
      if (code === "NOT_FOUND") { set.status = 404; return { error: "Endpoint not found", code: "NOT_FOUND" }; }
      set.status = 500;
      return { error: "Service unavailable; request was not completed", code: "INTERNAL" };
    })
    .group("/api", api => api
      .get("/health", () => ({ status: "ok", storage: service.config.memory ? "memory-nonpersistent" : "postgresql", agents: service.config.provider ? "configured-unverified" : "draft-only", agentsAuto: service.autoAgents.enabled,
        ...(service.config.provider ? { agentModel: { thinking: service.config.provider.thinking?.mode ?? "off", contextWindow: service.config.provider.contextWindow ?? null, maxOutputTokens: service.config.provider.maxOutputTokens ?? null } } : {}), hardware: "not-verified", hardwareBatches: "unsupported-sink-documented" }))
      .get("/board", () => service.boardFeed.status())
      .get("/internal/providers", () => service.pool.status())
      .post("/internal/providers/probe", () => service.pool.probe())
      .get("/datasets", async () => { await service.syncFolders(); return service.store.listDatasets(); })
      .post("/datasets", async ({ body, set }) => {
        if (body.network.name !== "network.json" || body.ops.name !== "ops.json" || body.telemetry.name !== "telemetry.csv") throw new DomainError("INVALID_FILES", "Upload network.json, ops.json and telemetry.csv with their original filenames");
        const [network, ops, telemetry] = await Promise.all([body.network.text(), body.ops.text(), body.telemetry.text()]);
        const result = await service.upload({ network, ops, telemetry }, body.label);
        set.status = 201;
        return result;
      }, { body: t.Object({ network: t.File({ maxSize: "2m" }), ops: t.File({ maxSize: "2m" }), telemetry: t.File({ maxSize: "160m" }), label: t.Optional(t.String({ maxLength: 120 })) }, { additionalProperties: false }) })
      .get("/datasets/:id/timeline", ({ params }) => service.timeline(params.id))
      .get("/runs", () => service.store.listRuns())
      .post("/runs", async ({ body, request, set }) => { const r = await service.createRun({ ...body, idempotencyKey: keyOf(request) }); set.status = 202; return r; }, {
        body: t.Object({ datasetId: id, at: t.Optional(t.Integer({ minimum: 0 })), runtime: mode, parentRunId: t.Optional(id) }, { additionalProperties: false })
      })
      .get("/runs/:id", ({ params }) => service.requireRun(params.id))
      .get("/runs/:id/snapshot", ({ params }) => service.requireSnapshot(params.id))
      .post("/runs/:id/cancel", ({ params }) => service.cancelRun(params.id))
      .get("/runs/:id/export", async ({ params }) => new Response(JSON.stringify(exportEvents(await service.requireSnapshot(params.id)), null, 2), { headers: { "content-type": "application/json", "content-disposition": 'attachment; filename="events.json"' } }))
      .post("/runs/:id/analyses", async ({ params, request, set }) => { const a = await service.createAnalysis(params.id, keyOf(request)); set.status = 202; return a; })
      .get("/analyses/:id", ({ params }) => service.requireAnalysis(params.id))
      .post("/analyses/:id/cancel", ({ params }) => service.cancelAnalysis(params.id))
      .post("/runs/:id/agents", async ({ params, set }) => { const r = await service.startAgentRun(params.id); set.status = 202; return r; })
      .get("/runs/:id/agent-runs", async ({ params }) => { await service.requireRun(params.id); return service.listAgentRuns(params.id); })
      .get("/agent-runs/:id", ({ params }) => service.agentLoop.get(params.id))
      .get("/agents/learning", () => service.agentLoop.summary())
      .get("/runs/:id/actions", async ({ params }) => { await service.requireRun(params.id); return service.store.listActions(params.id); })
      .post("/runs/:id/actions", ({ params, body, request }) => service.operatorAction(params.id, body, requiredKey(request)), {
        body: t.Object({ incidentId: id, planId: t.Optional(id), revision: t.Integer({ minimum: 1 }), kind: t.Union([t.Literal("acknowledge_advice"), t.Literal("inspection_ticket")]) }, { additionalProperties: false })
      })
      .post("/runs/:id/scenarios", ({ params, body, request }) => service.createScenario(params.id, body.systemId, body.label, requiredKey(request), body.systemPlanId), {
        body: t.Object({ systemId: id, label: t.String({ minLength: 1, maxLength: 120 }), systemPlanId: t.Optional(id) }, { additionalProperties: false })
      })
      .get("/scenarios/:id", async ({ params }) => { const s = await service.store.getScenario(params.id); if (!s) throw new DomainError("NOT_FOUND", "Scenario not found", 404); return s; })
      .get("/runs/:id/events", async ({ params, query, request, set }) => {
        await service.requireRun(params.id);
        const header = request.headers.get("last-event-id");
        const after = Number(query.after ?? header ?? 0);
        if (!Number.isSafeInteger(after) || after < 0) throw new DomainError("INVALID_CURSOR", "Invalid stream cursor");
        const current = await service.store.snapshot(params.id);
        if (current && after > current.cursor) throw new DomainError("CURSOR_EXPIRED", "Reload the run snapshot", 409);
        set.headers["cache-control"] = "no-cache, no-transform";
        set.headers["x-accel-buffering"] = "no";
        return (async function* () {
          let cursor = after;
          while (!request.signal.aborted) {
            const events = await service.store.events(params.id, cursor, 100);
            for (const event of events) { cursor = event.cursor; yield sse({ id: String(event.cursor), event: event.type, data: event }); }
            if (!events.length) yield sse({ event: "heartbeat", data: { runId: params.id, cursor } });
            await delay(300, request.signal);
          }
        })();
      }, { query: t.Object({ after: t.Optional(t.Numeric({ minimum: 0 })) }) })
    );
}
export type App = ReturnType<typeof createApp>;
