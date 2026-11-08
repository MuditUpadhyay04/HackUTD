import type { AnalysisRecord, Snapshot } from "@hackutd/contracts";
import type { Store } from "../../store";
import { createRuntime, type CoordinatorRuntime, type Provider, type SessionLink } from "./runtime";
import { createAiSdkRuntime } from "./runtime-ai-sdk";
import { factsFor, validateFinalization, type Facts, type Finalization } from "./tools";

export interface AnalysisServiceOptions {
  store: Store;
  provider?: Provider;
  sessionDir: string;
  /** Test seam; no network calls are made unless a provider or runtime is explicitly supplied. */
  runtime?: CoordinatorRuntime;
  deadlineMs?: number;
}
export interface GenerateContext { onSession: (link: SessionLink) => Promise<void> }
type LinkedAnalysis = AnalysisRecord & Partial<SessionLink>;
class SessionPersistenceError extends Error {}

function draft(facts: Facts): string {
  const ongoing = facts.incidents.filter((i) => i.status === "ongoing");
  const lines = ongoing.map((i) => {
    const action = i.category === "pump_failure" ? (i.plans.length ? "Review the validated solver plan and shared fleet." : "No current validated plan is available.") : "Recommend field inspection; no shutdown countdown applies.";
    return `${i.facilityId}: ${i.category.replaceAll("_", " ")}. ${action}`;
  });
  return [ongoing.length ? "Shift handoff: " + lines.join(" ") : "Shift handoff: no ongoing incidents are recorded in this snapshot.",
    facts.coverage.complete ? "" : "Coverage is incomplete; missing data is not evidence of health.",
    facts.scoresAvailable ? "" : "Classifier capability is limited; health is unknown where evidence is unavailable.",
    facts.recommendation.state === "ready" && facts.recommendation.inputRevision === facts.revision ? "" : "Recommendations may be stale or unavailable.",
    "Plans are advice, not dispatch; solver results are best feasible found, not a guarantee of global optimality."].filter(Boolean).join(" ");
}

export function createAnalysisService(options: AnalysisServiceOptions) {
  const running = new Map<string, AbortController>();
  let libfxRuntimePromise: Promise<CoordinatorRuntime> | undefined;
  let aiSdkRuntime: CoordinatorRuntime | undefined;
  let closed = false;
  return {
    async generate(analysis: LinkedAnalysis, snapshot: Snapshot, signal?: AbortSignal, context?: GenerateContext): Promise<LinkedAnalysis> {
      console.error("[nemotron] generate() ENTRY");
      if (closed) throw new Error("Analysis service is closed");
      if (analysis.runId !== snapshot.runId || analysis.inputRevision !== snapshot.revision) throw new Error("Analysis snapshot scope mismatch");
      if (running.has(analysis.id)) throw new Error("Analysis already running");
      const controller = new AbortController(); running.set(analysis.id, controller);
      const abort = () => controller.abort();
      if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
      console.error("[nemotron] About to call factsFor...");
      let facts: Facts;
      try {
        facts = factsFor(structuredClone(snapshot));
        console.error("[nemotron] factsFor completed, incidents:", facts.incidents.length);
      } catch (error) {
        console.error("[nemotron] factsFor threw:", error instanceof Error ? error.message : String(error));
        console.error("[nemotron] snapshot keys:", Object.keys(snapshot));
        console.error("[nemotron] snapshot.alerts:", JSON.stringify(snapshot.alerts?.map((a: any) => ({ id: a.id, category: a.category, facilityId: a.facilityId }))).slice(0, 500));
        throw error;
      }
      const handoff = draft(facts);
      const fallback = { ...analysis, state: "completed" as const, source: "draft" as const, model: undefined, handoff,
        evidenceIds: facts.incidents.flatMap((i) => i.evidence.map((e) => e.id)),
        planIds: [...new Set(facts.incidents.flatMap((i) => i.plans.map((p) => p.id)))],
        steps: [{ agent: "solver", model: "deterministic", text: "Recommendations and feasibility come from the recorded solver results, not the language model." }], error: null };
      let timedOut = false;
      let link: SessionLink | undefined;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.deadlineMs ?? 30_000);
      try {
        if (controller.signal.aborted) return { ...fallback, state: "cancelled" };
        if (!options.provider && !options.runtime) return fallback;
        console.error("[nemotron] generate() called, provider:", !!options.provider, "runtime:", !!options.runtime);

        // Helper: run a single analysis attempt with a given runtime.
        const runWithTimeout = async (runtime: CoordinatorRuntime): Promise<Finalization> => {
          console.error("[nemotron] runWithTimeout called, calling runtime.run()...");
          const work = (async () => {
            if (controller.signal.aborted) throw new Error("aborted");
            console.error("[nemotron] runtime.run() starting...");
            const result = await runtime.run(facts, controller.signal, { analysisId: analysis.id, fxSessionId: analysis.fxSessionId,
              onSession: context && (async (value) => {
                if (controller.signal.aborted) throw new Error("Cancelled");
                try { await context.onSession(value); } catch { throw new SessionPersistenceError("Failed to persist fenced session linkage"); }
                link = value;
              }) });
            console.error("[nemotron] runtime.run() completed:", JSON.stringify(result).slice(0, 200));
            return result;
          })();
          const cancelled = new Promise<never>((_, reject) => {
            if (controller.signal.aborted) reject(new Error("aborted"));
            else controller.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
          return validateFinalization(facts, await Promise.race([work, cancelled]));
        };

        // Attempt 1: libfx runtime.
        let lastError: unknown;
        console.error("[nemotron] Attempting libfx runtime...");
        try {
          const runtime = await (libfxRuntimePromise ??= options.runtime
            ? Promise.resolve(options.runtime)
            : createRuntime(options.provider!, options.sessionDir));
          console.error("[nemotron] libfx runtime created, running...");
          const finalization = await runWithTimeout(runtime);
          console.error("[nemotron] libfx runtime succeeded:", JSON.stringify(finalization).slice(0, 200));
          if (controller.signal.aborted) throw new Error("aborted");
          const caveat = [facts.scoresAvailable ? "" : "Classifier capability is limited; health is unknown where evidence is unavailable.", facts.coverage.complete ? "" : "Coverage is incomplete.", facts.recommendation.state === "ready" && facts.recommendation.inputRevision === facts.revision ? "" : "Recommendations may be stale or unavailable."].filter(Boolean).map((s) => ` ${s}`).join("");
          return { ...fallback, ...link, ...finalization, handoff: finalization.handoff + caveat, source: "nemotron", model: options.provider?.model ?? "libfx", error: null };
        } catch (error) {
          lastError = error;
          console.error("[nemotron] libfx runtime error:", error instanceof Error ? error.message : String(error));
        }

        // Attempt 2: AI SDK fallback.
        console.error("[nemotron] Attempting AI SDK runtime...");
        try {
          aiSdkRuntime = createAiSdkRuntime({ provider: options.provider! });
          const finalization = await runWithTimeout(aiSdkRuntime);
          console.error("[nemotron] AI SDK runtime succeeded:", JSON.stringify(finalization).slice(0, 200));
          if (controller.signal.aborted) throw new Error("aborted");
          const caveat = [facts.scoresAvailable ? "" : "Classifier capability is limited; health is unknown where evidence is unavailable.", facts.coverage.complete ? "" : "Coverage is incomplete.", facts.recommendation.state === "ready" && facts.recommendation.inputRevision === facts.revision ? "" : "Recommendations may be stale or unavailable."].filter(Boolean).map((s) => ` ${s}`).join("");
          return { ...fallback, ...link, ...finalization, handoff: finalization.handoff + caveat, source: "ai-sdk", model: options.provider?.model ?? "ai-sdk", error: null };
        } catch (error2) {
          lastError = error2;
          console.error("[nemotron] AI SDK runtime error:", error2 instanceof Error ? error2.message : String(error2));
        }

        // Both runtimes failed - return deterministic draft.
        if (controller.signal.aborted) return { ...fallback, ...link, state: "cancelled" };
        return { ...fallback, ...link, error: timedOut ? "Coordinator timed out; deterministic draft shown." : `Coordinator failed (${lastError instanceof Error ? lastError.message : String(lastError)}); deterministic draft shown.` };
      } catch (error) {
        if (error instanceof SessionPersistenceError) throw error;
        if (controller.signal.aborted && !timedOut) return { ...fallback, ...link, state: "cancelled" };
        return { ...fallback, ...link, error: timedOut ? "Coordinator timed out; deterministic draft shown." : "Coordinator failed or returned invalid handoff or citations; deterministic draft shown." };
      } finally {
        clearTimeout(timer); signal?.removeEventListener("abort", abort); running.delete(analysis.id);
      }
    },
    async cancel(id: string) { running.get(id)?.abort(); },
    async close() { closed = true; for (const controller of running.values()) controller.abort(); if (libfxRuntimePromise) { try { await (await libfxRuntimePromise).close(); } catch { /* Initialization failed. */ } } if (aiSdkRuntime) { try { await aiSdkRuntime.close(); } catch { /* noop */ } } },
  };
}
