import { expect, test } from "bun:test";
import type { Snapshot } from "@hackutd/contracts";
import { createRuntime } from "./runtime";
import { factsFor } from "./tools";

// Explicit opt-in only: FX_COMPAT_TEST=1, FX_TEST_BASE_URL, FX_TEST_MODEL,
// FX_TEST_API_KEY and FX_TEST_SESSION_DIR must all be supplied by the operator.
test.skipIf(process.env.FX_COMPAT_TEST !== "1")("real FX provider can finalize a scoped handoff", async () => {
  const { FX_TEST_BASE_URL, FX_TEST_MODEL, FX_TEST_API_KEY, FX_TEST_SESSION_DIR, FX_TEST_CONTEXT_WINDOW } = process.env;
  if (!FX_TEST_BASE_URL || !FX_TEST_MODEL || !FX_TEST_API_KEY || !FX_TEST_SESSION_DIR) throw new Error("Missing FX test provider configuration");
  const runtime = await createRuntime({ baseUrl: FX_TEST_BASE_URL, model: FX_TEST_MODEL, apiKey: FX_TEST_API_KEY, ...(FX_TEST_CONTEXT_WINDOW ? { contextWindow: Number(FX_TEST_CONTEXT_WINDOW) } : {}) }, FX_TEST_SESSION_DIR);
  try {
    const facts = factsFor({ runId: "compat-run", revision: 1, nowUnix: 0, runtime: { scoresAvailable: false }, coverage: { complete: false }, recommendation: { state: "unavailable", inputRevision: 1 }, alerts: [], history: [] } as unknown as Snapshot);
    let sessionId = "";
    const result = await runtime.run(facts, AbortSignal.timeout(45_000), { analysisId: `compat-${crypto.randomUUID()}`, onSession: async (link) => { sessionId = link.fxSessionId; } });
    expect(sessionId).toBeTruthy();
    expect(result.handoff.length).toBeGreaterThan(0);
  } finally { await runtime.close(); }
}, 60_000);
