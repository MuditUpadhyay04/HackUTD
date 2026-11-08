import { describe, expect, test } from "bun:test";
import type { AnalysisRecord, Snapshot } from "@hackutd/contracts";
import type { Store } from "../../store";
import { createAnalysisService } from "./service";
import { createTools, factsFor, validateFinalization } from "./tools";

const snapshot = { runId: "run", revision: 4, nowUnix: 100, runtime: { scoresAvailable: false }, coverage: { complete: false }, recommendation: { state: "ready", inputRevision: 4 }, history: [], alerts: [{ id: "incident", status: "ongoing", category: "pipeline_leak", facilityId: "facility", systemId: "system", assetId: "pipe", evidence: ["pressure drop"] }] } as unknown as Snapshot;
const analysis = { id: "analysis", runId: "run", inputRevision: 4, state: "pending", source: "draft", steps: [], handoff: "", evidenceIds: [], planIds: [], error: null, createdAt: "" } as AnalysisRecord;
const options = { store: {} as Store, sessionDir: "/unused" };

describe("analysis coordinator", () => {
  test("draft is deterministic, cited, and honest about coverage", async () => {
    const service = createAnalysisService(options);
    const result = await service.generate(analysis, snapshot);
    expect(result).toEqual(await service.generate(analysis, snapshot));
    expect(result.source).toBe("draft");
    expect(result.evidenceIds).toEqual(["incident:evidence:0"]);
    expect(result.handoff).toContain("field inspection");
    expect(result.handoff).toContain("incomplete");
    await service.close();
  });
  test("rejects invalid scopes and citations", async () => {
    const facts = factsFor(snapshot);
    const tool = createTools().find((t) => t.name === "read_incident")!;
    expect(() => tool.execute({ id: "other" }, { context: facts })).toThrow();
    expect(() => tool.execute({ id: "incident", runId: "other" }, { context: facts })).toThrow();
    const service = createAnalysisService({ ...options, runtime: { run: async () => ({ handoff: "Review the evidence.", evidenceIds: ["wrong"], planIds: [] }), close: async () => {} } });
    expect((await service.generate(analysis, snapshot)).source).toBe("draft");
    expect(service.generate({ ...analysis, inputRevision: 3 }, snapshot)).rejects.toThrow();
    await service.close();
  });
  test("timeout returns an honest draft even if runtime does not cooperate", async () => {
    const service = createAnalysisService({ ...options, deadlineMs: 5, runtime: { run: () => new Promise(() => {}), close: async () => {} } });
    const result = await service.generate(analysis, snapshot);
    expect(result.source).toBe("draft");
    expect(result.error).toContain("timed out");
    await service.close();
  });
  test("accepts only validated citations from runtime", async () => {
    const service = createAnalysisService({ ...options, runtime: { run: async () => ({ handoff: "Review the evidence and recommend field inspection.", evidenceIds: ["incident:evidence:0"], planIds: [] }), close: async () => {} } });
    const result = await service.generate(analysis, snapshot);
    expect(result.source).toBe("nemotron");
    expect(result.handoff).toContain("Review the evidence and recommend field inspection.");
    expect(result.handoff).toContain("Classifier capability is limited");
    await service.close();
  });
  test("rejects invented numbers, entities, and completed actions", () => {
    const facts = factsFor(snapshot);
    for (const handoff of ["Review 99 trucks.", "Review Atlantis.", "The truck was dispatched."]) {
      expect(() => validateFinalization(facts, { handoff, evidenceIds: ["incident:evidence:0"], planIds: [] })).toThrow();
    }
  });
  test("unknown classifier is disclosed even without incidents", async () => {
    const service = createAnalysisService(options);
    const result = await service.generate(analysis, { ...snapshot, alerts: [] });
    expect(result.handoff).toContain("health is unknown");
    await service.close();
  });
  test("passes fenced session callback and returns its persisted linkage", async () => {
    let persisted = false;
    const service = createAnalysisService({ ...options, runtime: { run: async (_facts, _signal, ctx) => {
      expect(ctx?.analysisId).toBe("analysis");
      expect(ctx?.fxSessionId).toBe("wrun_existing");
      await ctx!.onSession!({ fxSessionId: "wrun_existing", messageId: "analysis" });
      expect(persisted).toBe(true);
      return { handoff: "Review the evidence.", evidenceIds: ["incident:evidence:0"], planIds: [] };
    }, close: async () => {} } });
    const result = await service.generate({ ...analysis, fxSessionId: "wrun_existing" }, snapshot, undefined, { onSession: async () => { persisted = true; } });
    expect(result.messageId).toBe("analysis");
    await service.close();
  });
  test("fails instead of hiding a fenced session persistence failure", async () => {
    const service = createAnalysisService({ ...options, runtime: { run: async (_facts, _signal, ctx) => {
      await ctx!.onSession!({ fxSessionId: "wrun_existing", messageId: "analysis" });
      return { handoff: "Review the evidence.", evidenceIds: ["incident:evidence:0"], planIds: [] };
    }, close: async () => {} } });
    await expect(service.generate(analysis, snapshot, undefined, { onSession: async () => { throw new Error("fenced"); } })).rejects.toThrow("persist fenced");
    await service.close();
  });
  test("reports the runtime trace as a step and never passes it to the validator", async () => {
    const service = createAnalysisService({ ...options, runtime: { run: async () => ({ handoff: "Review the evidence at facility.", evidenceIds: ["incident:evidence:0"], planIds: [],
      trace: { runtime: "libfx", modelCalls: 3, toolCalls: 2, rejectedFinalizations: 1, inputTokens: 900, outputTokens: 80 } }), close: async () => {} } });
    const result = await service.generate(analysis, snapshot);
    expect(result.source).toBe("nemotron");
    expect(result.steps[0]!.agent).toBe("coordinator");
    expect(result.steps[0]!.text).toContain("libfx, 3 model calls, 2 tool calls, 1 rejected finalizations, 900 input / 80 output tokens");
    await service.close();
  });
  test("a failing injected runtime yields a draft with the reason, without a fallback run", async () => {
    const service = createAnalysisService({ ...options, runtime: { run: async () => { throw new Error("model unavailable"); }, close: async () => {} } });
    const result = await service.generate(analysis, snapshot);
    expect(result.source).toBe("draft");
    expect(result.error).toContain("model unavailable");
    await service.close();
  });
  test("explicit cancellation ends an in-flight analysis", async () => {
    const service = createAnalysisService({ ...options, runtime: { run: () => new Promise(() => {}), close: async () => {} } });
    const pending = service.generate(analysis, snapshot);
    await service.cancel(analysis.id);
    expect((await pending).state).toBe("cancelled");
    await service.close();
  });
});
