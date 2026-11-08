"use client";
// Requests and polls the run's Nemotron analysis (same calls as the v3 console's nemotron.tsx; copied, not imported).
import { useEffect, useState } from "react";
import type { AnalysisRecord } from "@hackutd/contracts";
import { api, commandKey, unwrap } from "@/lib/api";

export interface AnalysisState {
  status: "loading" | "ready" | "error";
  record: AnalysisRecord | null;
  error: string | null;
}

export function useAnalysis(runId: string): AnalysisState {
  const [result, setResult] = useState<{ key: string; record?: AnalysisRecord; error?: string } | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    async function run() {
      const keyName = `operator-analysis:${runId}`;
      let key: string | null = null;
      try { key = sessionStorage.getItem(keyName); } catch { /* storage blocked */ }
      if (!key) {
        key = commandKey();
        try { sessionStorage.setItem(keyName, key); } catch { /* storage blocked */ }
      }
      let analysis = unwrap(await api.api.runs({ id: runId }).analyses.post(undefined, { headers: { "idempotency-key": key }, fetch: { signal: abort.signal } }));
      while (!abort.signal.aborted && (analysis.state === "pending" || analysis.state === "running")) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1000));
        if (abort.signal.aborted) return;
        analysis = unwrap(await api.api.analyses({ id: analysis.id }).get({ fetch: { signal: abort.signal } }));
      }
      if (!abort.signal.aborted) setResult(analysis.state === "completed" ? { key: runId, record: analysis } : { key: runId, error: analysis.error || `Analysis ${analysis.state}` });
    }
    run().catch((e: Error) => { if (!abort.signal.aborted) setResult({ key: runId, error: e.message }); });
    return () => abort.abort();
  }, [runId]);

  const mine = result?.key === runId ? result : null;
  if (mine?.record) return { status: "ready", record: mine.record, error: null };
  if (mine?.error) return { status: "error", record: null, error: mine.error };
  return { status: "loading", record: null, error: null };
}
