import type { AnalysisRecord, Snapshot } from "@hackutd/contracts";
import type { Store } from "../../store";
import { createRuntime, type CoordinatorRuntime, type Provider, type RunTrace, type SessionLink } from "./runtime";
import { createAiSdkRuntime } from "./runtime-ai-sdk";
import { factsFor, validateFinalization, type Facts } from "./tools";

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

function errorText(error: unknown) { return (error instanceof Error ? error.message : String(error)).slice(0, 300); }

/** Non-secret run facts for the steps list: runtime path, calls, tokens and latency. */
function describeTrace(trace: RunTrace | undefined, source: "nemotron" | "ai-sdk", elapsedMs: number): string {
  const runtime = trace?.runtime ?? (source === "nemotron" ? "libfx" : "ai-sdk");
  const tokens = trace?.inputTokens !== undefined || trace?.outputTokens !== undefined ? `, ${trace?.inputTokens ?? "?"} input / ${trace?.outputTokens ?? "?"} output tokens` : "";
  const calls = trace ? `, ${trace.modelCalls} model calls, ${trace.toolCalls} tool calls, ${trace.rejectedFinalizations} rejected finalizations` : "";
  return `Written by the language model through ${runtime}${calls}${tokens}, ${(elapsedMs / 1000).toFixed(1)} s. Validated against snapshot facts and citations; advice only.`;
}

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
      if (closed) throw new Error("Analysis service is closed");
      if (analysis.runId !== snapshot.runId || analysis.inputRevision !== snapshot.revision) throw new Error("Analysis snapshot scope mismatch");
      if (running.has(analysis.id)) throw new Error("Analysis already running");
      const controller = new AbortController(); running.set(analysis.id, controller);
      const abort = () => controller.abort();
      if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
      let facts: Facts;
      try {
        facts = factsFor(structuredClone(snapshot));
      } catch (error) {
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

        const caveat = [facts.scoresAvailable ? "" : "Classifier capability is limited; health is unknown where evidence is unavailable.", facts.coverage.complete ? "" : "Coverage is incomplete.", facts.recommendation.state === "ready" && facts.recommendation.inputRevision === facts.revision ? "" : "Recommendations may be stale or unavailable."].filter(Boolean).map((s) => ` ${s}`).join("");
        const started = Date.now();
        // One attempt with one runtime. Citations and prose are always re-validated here, whatever the runtime did.
        const attempt = async (runtime: CoordinatorRuntime, source: "nemotron" | "ai-sdk"): Promise<LinkedAnalysis> => {
          const work = (async () => {
            if (controller.signal.aborted) throw new Error("aborted");
            return runtime.run(facts, controller.signal, { analysisId: analysis.id, fxSessionId: analysis.fxSessionId,
              onSession: context && (async (value) => {
                if (controller.signal.aborted) throw new Error("Cancelled");
                try { await context.onSession(value); } catch { throw new SessionPersistenceError("Failed to persist fenced session linkage"); }
                link = value;
              }) });
          })();
          const cancelled = new Promise<never>((_, reject) => {
            if (controller.signal.aborted) reject(new Error("aborted"));
            else controller.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
          const { trace, ...raw } = await Promise.race([work, cancelled]);
          const finalization = validateFinalization(facts, raw);
          if (controller.signal.aborted) throw new Error("aborted");
          const model = options.provider?.model ?? (source === "nemotron" ? "libfx" : "ai-sdk");
          const coordinator = { agent: "coordinator", model, text: describeTrace(trace, source, Date.now() - started) };
          return { ...fallback, ...link, ...finalization, handoff: finalization.handoff + caveat, source, model,
            steps: [coordinator, ...fallback.steps], error: null };
        };

        // Attempt 1: libfx (durable session). An injected runtime is the only runtime (test seam).
        let lastError: unknown;
        try {
          const runtime = await (libfxRuntimePromise ??= options.runtime
            ? Promise.resolve(options.runtime)
            : createRuntime(options.provider!, options.sessionDir));
          return await attempt(runtime, "nemotron");
        } catch (error) {
          // A fenced-session failure must surface, and an abort or timeout must not start a second model run.
          if (error instanceof SessionPersistenceError || controller.signal.aborted || options.runtime || !options.provider) throw error;
          lastError = error;
        }

        // Attempt 2: AI SDK fallback, only with a real provider and time left before the deadline.
        try {
          aiSdkRuntime ??= createAiSdkRuntime({ provider: options.provider });
          return await attempt(aiSdkRuntime, "ai-sdk");
        } catch (error) {
          if (error instanceof SessionPersistenceError || controller.signal.aborted) throw error;
          return { ...fallback, ...link, error: `Coordinator failed (${errorText(lastError)}; fallback: ${errorText(error)}); deterministic draft shown.` };
        }
      } catch (error) {
        if (error instanceof SessionPersistenceError) throw error;
        if (controller.signal.aborted && !timedOut) return { ...fallback, ...link, state: "cancelled" };
        return { ...fallback, ...link, error: timedOut ? "Coordinator timed out; deterministic draft shown." : `Coordinator failed or returned invalid handoff or citations (${errorText(error)}); deterministic draft shown.` };
      } finally {
        clearTimeout(timer); signal?.removeEventListener("abort", abort); running.delete(analysis.id);
      }
    },
    async cancel(id: string) { running.get(id)?.abort(); },
    async close() { closed = true; for (const controller of running.values()) controller.abort(); if (libfxRuntimePromise) { try { await (await libfxRuntimePromise).close(); } catch { /* Initialization failed. */ } } if (aiSdkRuntime) { try { await aiSdkRuntime.close(); } catch { /* noop */ } } },
  };
}
