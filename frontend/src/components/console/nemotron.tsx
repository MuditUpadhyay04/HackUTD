"use client";

import { useEffect, useState } from "react";
import { Tile } from "./section";
import type { AnalysisRecord } from "@hackutd/contracts";
import { api, commandKey, unwrap } from "@/lib/api";

/** A neutral eye glyph in NVIDIA green: marks where Nemotron is speaking. Not the NVIDIA logo. */
export function NemotronMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden>
      <rect width="20" height="20" rx="5" fill="var(--nv)" />
      <path d="M4 10c1.8-3 4-4.4 6-4.4S14.2 7 16 10c-1.8 3-4 4.4-6 4.4S5.8 13 4 10z" fill="none" stroke="#fff" strokeWidth="1.6" />
      <circle cx="10" cy="10" r="1.9" fill="#fff" />
    </svg>
  );
}

export function NemotronBrief({ runId, expanded }: { runId: string; expanded?: boolean }) {
  const [result, setResult] = useState<{ key: string; brief?: AnalysisRecord; error?: string } | null>(null);
  const brief = result?.key === runId && result.brief?.state === "completed" ? result.brief : undefined;
  const error = result?.key === runId ? result.error : undefined;

  useEffect(() => {
    const abort = new AbortController();
    async function run() {
      const keyName = `operator-analysis:${runId}`;
      let key = sessionStorage.getItem(keyName);
      if (!key) { key = commandKey(); sessionStorage.setItem(keyName, key); }
      let analysis = unwrap(await api.api.runs({ id: runId }).analyses.post(undefined, { headers: { "idempotency-key": key }, fetch: { signal: abort.signal } }));
      while (!abort.signal.aborted && (analysis.state === "pending" || analysis.state === "running")) {
        setResult({ key: runId, brief: analysis });
        await new Promise<void>((resolve) => setTimeout(resolve, 1000));
        if (abort.signal.aborted) return;
        analysis = unwrap(await api.api.analyses({ id: analysis.id }).get({ fetch: { signal: abort.signal } }));
      }
      if (!abort.signal.aborted) setResult(analysis.state === "completed" ? { key: runId, brief: analysis } : { key: runId, error: analysis.error || `Analysis ${analysis.state}` });
    }
    run().catch((e: Error) => { if (!abort.signal.aborted) setResult({ key: runId, error: e.message }); });
    return () => abort.abort();
  }, [runId]);

  return (
    <Tile className="flex flex-col px-6 py-5">
      <div className="flex items-center gap-2.5">
        <NemotronMark className="size-5" />
        <h3 className="text-[15px] font-semibold text-text">Note for the next operator</h3>
      </div>
      <p className="mt-1 text-[13px] text-muted-foreground">
        {brief?.source === "nemotron"
          ? `Written by ${brief.model ?? "Nemotron"}`
          : brief
              ? "Draft from the plan solver."
              : "Reading the network…"}
      </p>

      <div className="mt-3">
        {error && <p className="text-[14px] text-crit">{error}. Everything else still works.</p>}
        {!brief && !error && (
          <div className="flex flex-col gap-2" aria-hidden>
            {[96, 100, 78].map((w, i) => (
              <div key={i} className="h-3 rounded bg-line-soft" style={{ width: `${w}%` }} />
            ))}
          </div>
        )}
        {brief && (
          <>
            <p className="text-[16px] leading-relaxed text-text">{brief.handoff}</p>
            <details className="group mt-4 border-t border-line pt-3" open={expanded}>
              <summary className="cursor-pointer list-none text-[13px] text-muted-foreground hover:text-text">
                <span className="group-open:hidden">Show how the agents got here</span>
                <span className="hidden group-open:inline">Hide agent steps</span>
              </summary>
              <ol className="mt-3 flex flex-col gap-2.5">
                {brief.steps.map((s, i) => (
                  <li key={i} className="text-[13px] leading-snug">
                    <span className="font-medium text-text">{s.agent}</span>
                    {s.model.toLowerCase() !== s.agent.toLowerCase() && <span className="text-faint"> ({s.model})</span>}
                    <p className="text-muted-foreground">{s.text}</p>
                  </li>
                ))}
              </ol>
            </details>
          </>
        )}
      </div>
    </Tile>
  );
}
