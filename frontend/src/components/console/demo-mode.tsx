"use client";

import { useEffect, useState } from "react";
import { categoryLabel, clock, facilityTitle } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useBoardFeed, type BoardFeed } from "./simulation";

export type DemoMode = "stream" | "batch";

type DemoState = {
  available: boolean;
  mode?: DemoMode;
  dataset?: string;
  source?: "fpga" | "fakeboard";
  pace?: string;
  replay?: { running: boolean; startedAt: string | null; endedAt: string | null; exitCode: number | null };
};

const modes: { id: DemoMode; label: string; title: string }[] = [
  { id: "stream", label: "Stream", title: "One sensor reading a second, so the console looks like a live shift." },
  { id: "batch", label: "Batch", title: "Send the whole dataset through the board as fast as it will go, and watch the log." },
];

let demoState: DemoState | null = null;
let demoError = "";
let demoBusy = false;
let demoPoll: ReturnType<typeof setInterval> | null = null;
const demoListeners = new Set<() => void>();

function publish() {
  for (const listener of demoListeners) listener();
}

function ensureDemoPoll() {
  if (demoPoll) return;
  const poll = async () => {
    try {
      const res = await fetch("/api/demo", { cache: "no-store" });
      const body = (await res.json()) as DemoState;
      demoState = body.available === false ? { available: false } : body;
    } catch {
      demoState = { available: false };
    }
    publish();
  };
  void poll();
  demoPoll = setInterval(poll, 1000);
}

function useDemo() {
  const [, redraw] = useState(0);
  useEffect(() => {
    const listener = () => redraw((n) => n + 1);
    demoListeners.add(listener);
    ensureDemoPoll();
    return () => { demoListeners.delete(listener); };
  }, []);

  const choose = async (mode: DemoMode) => {
    demoBusy = true;
    demoError = "";
    publish();
    try {
      const res = await fetch("/api/demo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const body = (await res.json()) as DemoState & { error?: string };
      if (!res.ok || body.available === false) {
        demoError = body.error || "Start the demo with bun run demo.";
        demoState = { available: false };
        return;
      }
      demoState = body;
    } catch {
      demoError = "Start the demo with bun run demo.";
      demoState = { available: false };
    } finally {
      demoBusy = false;
      publish();
    }
  };

  return { state: demoState, busy: demoBusy, error: demoError, choose };
}

/** Stream or batch. One control, in the toolbar. */
export function DemoModeSwitch() {
  const { state, busy, error, choose } = useDemo();
  const mode = state?.mode;
  return (
    <div className="flex items-center gap-2">
      <div role="radiogroup" aria-label="How the board is fed" className="inline-flex rounded-[9px] bg-[rgba(118,118,128,0.12)] p-0.5">
        {modes.map((item) => {
          const on = mode === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={on}
              title={item.title}
              disabled={busy}
              onClick={() => void choose(item.id)}
              className={cn(
                "rounded-[7px] px-3 py-1 text-[13px] text-text transition-[background-color,box-shadow] duration-150 disabled:opacity-60",
                on && "bg-white font-semibold shadow-[0_1px_2px_rgba(0,0,0,0.12),0_0_0_0.5px_rgba(0,0,0,0.04)]",
              )}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      {error && <span className="text-[12.5px] text-crit">{error}</span>}
    </div>
  );
}

function seconds(replay: NonNullable<DemoState["replay"]>, now: number) {
  if (!replay.startedAt) return 0;
  const end = replay.endedAt ? Date.parse(replay.endedAt) : now;
  return Math.max(0, (end - Date.parse(replay.startedAt)) / 1000);
}

function decision(row: NonNullable<BoardFeed["recent"]>[number]) {
  if (row.active.length) {
    return row.active.map((head) => categoryLabel[head as keyof typeof categoryLabel] ?? head).join(", ");
  }
  if (row.status === "VALID") return "OK";
  return row.status || "—";
}

/** The live board log. Only while a batch run is the selected mode. */
export function DemoBatchLog() {
  const { state, choose, busy } = useDemo();
  const feed = useBoardFeed(400);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 400);
    return () => clearInterval(id);
  }, []);
  if (state?.mode !== "batch") return null;

  const replay = state.replay;
  const elapsed = replay ? seconds(replay, now) : 0;
  const results = feed?.results ?? 0;
  const rate = elapsed > 0.2 ? results / elapsed : 0;
  const lost = (feed?.stats?.seqGaps ?? 0) + (feed?.stats?.badPackets ?? 0);
  const flagged = feed?.flagged?.length ?? 0;
  const boardName = state.source === "fpga" ? "FPGA" : "Software board";
  const running = replay?.running !== false && replay?.exitCode == null;
  const headline = !replay?.startedAt
    ? "Starting the run…"
    : running
      ? "Processing the dataset"
      : replay?.exitCode === 0
        ? "Finished"
        : `Stopped (${replay?.exitCode ?? "?"})`;

  return (
    <section className="glass mt-5 overflow-hidden" aria-label="Board processing log">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <span className="text-[13px] font-semibold">{boardName} log</span>
        <span className="text-[12.5px] text-muted-foreground">
          {headline}
          {state.dataset ? ` · ${state.dataset}` : ""}
          {state.pace ? ` · ${state.pace}` : ""}
        </span>
      </div>
      <div className="grid grid-cols-2 divide-line sm:grid-cols-4 sm:divide-x">
        <Stat label="Results" value={results.toLocaleString()} />
        <Stat label="Rate" value={rate ? `${Math.round(rate).toLocaleString()}/s` : "—"} />
        <Stat label="Elapsed" value={elapsed ? `${elapsed.toFixed(1)}s` : "—"} />
        <Stat label="Flagged" value={String(flagged)} detail={lost ? `${lost} bad or lost packets` : "No bad packets"} tone={lost ? "warn" : undefined} />
      </div>
      <ol className="max-h-72 overflow-y-auto border-t border-line font-mono text-[12.5px]">
        {(feed?.recent ?? []).map((row, i) => {
          const bad = row.active.length > 0;
          return (
            <li key={`${row.facility}-${row.tsUnix}-${i}`} className="flex items-baseline justify-between gap-3 border-b border-line-soft px-4 py-1.5 last:border-0">
              <span className="min-w-0 truncate">
                <span className="text-muted-foreground">{clock(row.tsUnix)}</span>
                {"  "}
                {facilityTitle(row.facility)}
              </span>
              <span className={cn("shrink-0 tabular-nums", bad ? "font-semibold text-crit" : "text-[#248a3d]")}>
                {decision(row)}
                {bad && row.top ? `  ${Math.round(row.top.p * 100)}%` : ""}
              </span>
            </li>
          );
        })}
        {!feed?.recent?.length && <li className="px-4 py-4 text-[13px] text-muted-foreground">Waiting for the first result.</li>}
      </ol>
      {!running && replay?.exitCode === 0 && (
        <div className="border-t border-line px-4 py-2.5">
          <button type="button" disabled={busy} onClick={() => void choose("batch")} className="rounded-md bg-water px-2.5 py-1 text-[12.5px] font-medium text-white disabled:opacity-60">
            Run again
          </button>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: "warn" }) {
  return (
    <div className="px-4 py-2.5">
      <p className="text-[12px] text-faint">{label}</p>
      <p className={cn("text-[18px] font-semibold tabular-nums", tone === "warn" && "text-warn")}>{value}</p>
      {detail && <p className="text-[12px] text-muted-foreground">{detail}</p>}
    </div>
  );
}
