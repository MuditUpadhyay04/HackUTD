"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import type { Incident } from "@/lib/engine/types";
import { categoryLabel, clock, day, facilityName } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Tile } from "./section";

/** Replay the dataset: drag back to any moment and the whole console shows that time. */
export function Timeline({
  dataset,
  startUnix,
  endUnix,
  atUnix,
  events,
}: {
  dataset: string;
  startUnix: number;
  endUnix: number;
  atUnix: number;
  events: Incident[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, start] = useTransition();
  const [drag, setDrag] = useState<number | null>(null);
  // Hold the released time until the new snapshot arrives, so the thumb doesn't jump back.
  const [committed, setCommitted] = useState<number | null>(null);
  const [prevAt, setPrevAt] = useState(atUnix);
  if (atUnix !== prevAt) {
    setPrevAt(atUnix);
    setCommitted(null);
  }
  const shown = drag ?? committed ?? atUnix;
  const span = Math.max(1, endUnix - startUnix);
  const pct = (t: number) => ((t - startUnix) / span) * 100;
  const step = 300;

  const commit = (t: number) => {
    const snapped = Math.round(t / step) * step;
    const q = new URLSearchParams(params.toString());
    q.set("dataset", dataset);
    q.delete("at");
    if (snapped < endUnix) q.set("at", String(snapped));
    const target = Math.min(snapped, endUnix);
    setCommitted(target === atUnix ? null : target);
    start(() => router.push(`${pathname}?${q}`, { scroll: false }));
  };

  const days: number[] = [];
  for (let t = Math.ceil(startUnix / 86400) * 86400; t < endUnix; t += 86400) days.push(t);

  return (
    <Tile className="px-5 pt-4 pb-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[13px] text-muted-foreground">
          {shown >= endUnix ? "Showing the latest reading" : "Replaying"}{" "}
          <span className="num font-medium text-text">
            {day(shown)}, {clock(shown)}
          </span>
          {pending && <span className="ml-2">Loading…</span>}
        </p>
        {atUnix < endUnix && (
          <button type="button" className="text-[13px] font-medium text-water hover:underline" onClick={() => commit(endUnix)}>
            Back to latest
          </button>
        )}
      </div>
      <div className="relative mt-3 h-11">
        <div className="absolute inset-x-0 top-[13px] h-[5px] rounded-full bg-[rgba(118,118,128,0.16)]" />
        <div className="absolute top-[13px] left-0 h-[5px] rounded-full bg-water" style={{ width: `${pct(shown)}%` }} />
        {events.map((e) => (
          <span
            key={e.id}
            title={`${categoryLabel[e.category]}, ${facilityName(e.facilityId)}, ${day(e.onsetUnix)} ${clock(e.onsetUnix)}`}
            aria-hidden
            className={cn(
              "absolute top-[9px] h-[13px] w-[3px] -translate-x-1/2 rounded-full",
              e.category === "pump_failure" ? "bg-crit" : "bg-warn-fill",
            )}
            style={{ left: `${pct(e.onsetUnix)}%` }}
          />
        ))}
        {days.map((d) => (
          <span key={d} className="absolute top-[26px] -translate-x-1/2 text-[12px] text-faint" style={{ left: `${pct(d)}%` }}>
            {day(d).split(",")[0]}
          </span>
        ))}
        <input
          type="range"
          min={startUnix}
          max={endUnix}
          step={step}
          value={shown}
          aria-label="Replay time"
          aria-valuetext={`${day(shown)}, ${clock(shown)}`}
          onChange={(e) => setDrag(Number(e.target.value))}
          onPointerUp={() => {
            if (drag != null) {
              commit(drag);
              setDrag(null);
            }
          }}
          onKeyUp={() => {
            if (drag != null) {
              commit(drag);
              setDrag(null);
            }
          }}
          className="absolute inset-x-0 top-0 h-8 w-full cursor-pointer appearance-none bg-transparent [&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white [&::-webkit-slider-thumb]:size-5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-0 [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-[0_0_0_0.5px_rgba(0,0,0,0.12),0_2px_6px_rgba(0,0,0,0.2)]"
        />
      </div>
      <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="h-[11px] w-[3px] rounded-full bg-crit" aria-hidden /> Pump down
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-[11px] w-[3px] rounded-full bg-warn-fill" aria-hidden /> Leak or worn pump
        </span>
        <span>{events.length} problems so far. Drag to replay any moment.</span>
      </p>
    </Tile>
  );
}
