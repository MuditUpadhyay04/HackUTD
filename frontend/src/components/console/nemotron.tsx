"use client";

import { useEffect, useState } from "react";
import { Tile } from "./section";

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

export type AgentStep = { agent: string; model: string; text: string };
export type Brief = {
  source: "nemotron" | "draft";
  model?: string;
  /** True when Nemotron is configured but its call failed, so this is the solver's draft. */
  fallback?: boolean;
  steps: AgentStep[];
  handoff: string;
};

/**
 * The shift brief. /api/brief uses NVIDIA Nemotron when NVIDIA_API_KEY is set.
 * Without a key, or when the call fails, it shows the solver's draft and says which.
 * Only the handoff paragraph can come from Nemotron; the steps are always the plan solver's.
 */
export function NemotronBrief({ dataset, at, expanded }: { dataset: string; at?: number; expanded?: boolean }) {
  const key = `${dataset}@${at ?? "now"}`;
  const [result, setResult] = useState<{ key: string; brief?: Brief; error?: string } | null>(null);
  // A result for an older dataset or time counts as still loading.
  const brief = result?.key === key ? result.brief : undefined;
  const error = result?.key === key ? result.error : undefined;

  useEffect(() => {
    let alive = true;
    const q = new URLSearchParams({ dataset, ...(at ? { at: String(at) } : {}) });
    fetch(`/api/brief?${q}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`The brief didn't load (${r.status})`))))
      .then((b: Brief) => alive && setResult({ key, brief: b }))
      .catch((e: Error) => alive && setResult({ key, error: e.message }));
    return () => {
      alive = false;
    };
  }, [dataset, at, key]);

  return (
    <Tile className="flex flex-col px-6 py-5">
      <div className="flex items-center gap-2.5">
        <NemotronMark className="size-5" />
        <h3 className="text-[15px] font-semibold text-text">Note for the next operator</h3>
      </div>
      <p className="mt-1 text-[13px] text-muted-foreground">
        {brief?.source === "nemotron"
          ? `Written by ${brief.model ?? "Nemotron"}`
          : brief?.fallback
            ? "Nemotron didn't answer, so this is the plan solver's draft."
            : brief
              ? "Draft from the plan solver until Nemotron is connected."
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
