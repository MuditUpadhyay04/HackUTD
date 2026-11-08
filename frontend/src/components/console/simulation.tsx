"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SimulationTimeline } from "@hackutd/contracts";
import { api, unwrap } from "@/lib/api";
import { categoryLabel, dayClock, facilityTitle, money } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Simulation: play the dataset back and watch it happen. Pumps fail, the planner's plan goes out at each onset,
 * trucks drive their trips, the money kept versus doing nothing adds up, and the pipeline strip shows the records
 * that went board-ward and the results that came back. Everything comes from GET /api/datasets/:id/timeline (the
 * same snapshots a run uses) and GET /api/board (listen.py's live file). It is a replay of the recording with the
 * plans applied on screen only; nothing is written back (hard rule 6), and nothing here sends anything to the board.
 */

type Timeline = SimulationTimeline;
export interface BoardFeed {
  configured: boolean; online: boolean; source: string | null; weightsVersion: number | null; lastTsUnix: number | null; firstTsUnix: number | null; results: number; facilities: number;
  recent?: { facility: string; tsUnix: number; status: string; active: string[]; top: { head: string; p: number } | null }[];
  flagged?: { facility: string; tsUnix: number; active: string[] }[];
  stats?: { recordsIn: number; resultsOut: number; seqGaps: number; badPackets: number; mode: string; uptimeS: number } | null;
}
type Pt = { x: number; y: number };

export const SPEEDS = [
  { label: "1 h/s", secPerSec: 3600 },
  { label: "4 h/s", secPerSec: 4 * 3600 },
  { label: "12 h/s", secPerSec: 12 * 3600 },
];
const RECORD_BYTES = 48;
const shortName = (id: string) => facilityTitle(id);

/** The board feed (GET /api/board), polled every `ms`. */
export function useBoardFeed(ms = 2000) {
  const [feed, setFeed] = useState<BoardFeed | null>(null);
  useEffect(() => {
    let live = true;
    const poll = async () => {
      try { const r = await api.api.board.get(); if (live && !r.error && r.data) setFeed(r.data as unknown as BoardFeed); } catch { /* shown as offline */ }
    };
    void poll();
    const id = setInterval(poll, ms);
    return () => { live = false; clearInterval(id); };
  }, [ms]);
  return feed;
}

/** Timeline + playhead shared by the Simulation view and the live wall: follows the board while it streams this
 * dataset, else plays at the chosen speed. */
export function useSimulation(datasetId: string | undefined, feed: BoardFeed | null) {
  const [tl, setTl] = useState<Timeline | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [follow, setFollow] = useState(true);

  // ---- data: the timeline (built once per dataset on the server, ~5 s) and the board feed (every 2 s)
  const load = useCallback(async (signal?: AbortSignal) => {
    if (!datasetId) return;
    setError("");
    try {
      const data = unwrap(await api.api.datasets({ id: datasetId }).timeline.get({ fetch: { signal } })) as unknown as Timeline;
      if (signal?.aborted) return;
      setTl(data);
      setT((cur) => (cur >= data.startUnix && cur <= data.nowUnix ? cur : data.startUnix));
    } catch (e) {
      if (!signal?.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [datasetId]);
  useEffect(() => {
    const c = new AbortController();
    setLoading(true); setTl(null);
    void load(c.signal);
    return () => c.abort();
  }, [load]);
  // While the board streams into this dataset, refresh the story now and then (the server reuses it for 20 s).
  const lastRefresh = useRef(0);
  // Compare with the dataset's end, not the timeline's: while the board is part-way through, the timeline ends where
  // the board was when it was built, and the board moves on from there.
  const liveHere = !!(tl && feed?.online && feed.lastTsUnix != null && feed.lastTsUnix >= tl.startUnix && feed.lastTsUnix <= tl.datasetNowUnix);
  useEffect(() => {
    if (!liveHere || Date.now() - lastRefresh.current < 20_000) return;
    lastRefresh.current = Date.now();
    void load();
  }, [liveHere, feed?.results, load]);

  // ---- playhead: follows the board when it is live here, else plays at the chosen speed
  useEffect(() => {
    if (liveHere && follow && feed?.lastTsUnix != null) setT(feed.lastTsUnix);
  }, [liveHere, follow, feed?.lastTsUnix]);
  useEffect(() => {
    if (!playing || !tl || (liveHere && follow)) return;
    let raf = 0, prev = performance.now();
    const tick = (now: number) => {
      const dt = (now - prev) / 1000; prev = now;
      setT((cur) => {
        const next = cur + dt * SPEEDS[speed]!.secPerSec;
        if (next >= tl.nowUnix) { setPlaying(false); return tl.nowUnix; }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, tl, liveHere, follow]);
  const scrub = useCallback((v: number) => { setFollow(false); setT(v); }, []);
  return { tl, error, loading, setLoading, load, t, setT: scrub, playing, setPlaying, speed, setSpeed, liveHere, follow, setFollow };
}

export function SimulationPanel({ datasetId }: { datasetId: string }) {
  const feed = useBoardFeed();
  const { tl, error, loading, setLoading, load, t, setT, playing, setPlaying, speed, setSpeed, liveHere, follow, setFollow } = useSimulation(datasetId, feed);
  if (loading && !tl) return <p className="glass mt-6 px-5 py-4 text-[14px] text-muted-foreground">Building the week: incidents, a plan at each pump failure, trucks… (a few seconds the first time)</p>;
  if (error && !tl) return (
    <div role="alert" className="glass mt-6 flex items-center justify-between gap-3 px-5 py-4 text-[14px] text-crit">
      <span>Couldn't build the simulation: {error}</span>
      <button type="button" className="font-medium text-water hover:underline" onClick={() => { setLoading(true); void load(); }}>Retry</button>
    </div>
  );
  if (!tl) return null;
  return <SimulationBody tl={tl} t={t} setT={setT} playing={playing} setPlaying={setPlaying} speed={speed} setSpeed={setSpeed}
    feed={feed} liveHere={liveHere} follow={follow} setFollow={setFollow} />;
}

function SimulationBody({ tl, t, setT, playing, setPlaying, speed, setSpeed, feed, liveHere, follow, setFollow }: {
  tl: Timeline; t: number; setT: (t: number) => void; playing: boolean; setPlaying: (p: boolean) => void; speed: number; setSpeed: (s: number) => void;
  feed: BoardFeed | null; liveHere: boolean; follow: boolean; setFollow: (f: boolean) => void;
}) {
  const at = Math.floor(t);
  const ongoing = tl.incidents.filter((i) => i.onsetUnix <= at && (i.endUnix == null || i.endUnix > at));
  const started = tl.incidents.filter((i) => i.onsetUnix <= at);
  const plansSoFar = tl.plans.filter((p) => p.plannedUnix <= at);
  const costed = plansSoFar.filter((p) => p.cost != null && p.doNothingCost != null);
  const sum = (k: "cost" | "doNothingCost" | "kept") => costed.reduce((s, p) => s + (p[k] ?? 0), 0);
  const unknownCost = plansSoFar.length > costed.length;
  const down = ongoing.filter((i) => i.category === "pump_failure");
  const inspect = ongoing.filter((i) => i.category !== "pump_failure" && i.category !== "facility_shut_in");
  const steps = Math.max(0, Math.floor((Math.min(at, tl.nowUnix) - tl.startUnix) / tl.stepSeconds) + 1);
  const facilities = tl.systems.reduce((n, s) => n + s.facilities.length, 0);

  return (
    <div className="mt-5 grid gap-4">
      {/* transport */}
      <div className="glass flex flex-wrap items-center gap-3 px-4 py-3">
        <button type="button" aria-label={playing ? "Pause simulation" : "Play simulation"} onClick={() => { if (t >= tl.nowUnix) setT(tl.startUnix); setPlaying(!playing); }} disabled={liveHere && follow}
          className="rounded-md bg-water px-3 py-1.5 text-[13px] font-semibold text-white disabled:opacity-50">
          {playing ? "Pause" : t >= tl.nowUnix ? "Replay" : "Play"}
        </button>
        <div className="flex overflow-hidden rounded-md shadow-[0_0_0_0.5px_var(--line)]" role="group" aria-label="Speed">
          {SPEEDS.map((s, i) => (
            <button key={s.label} type="button" onClick={() => setSpeed(i)} className={cn("px-2.5 py-1 text-[12.5px] tabular-nums", i === speed ? "bg-water text-white" : "hover:bg-black/5")}>{s.label}</button>
          ))}
        </div>
        <input type="range" aria-label="Time" className="min-w-[160px] flex-1 accent-[var(--water)]" min={tl.startUnix} max={tl.nowUnix} step={tl.stepSeconds}
          value={Math.min(Math.max(t, tl.startUnix), tl.nowUnix)} onChange={(e) => setT(Number(e.target.value))} />
        <span className="rounded-md bg-black/80 px-2.5 py-1 font-mono text-[13px] text-white tabular-nums">{dayClock(at)}</span>
        {liveHere && (
          <button type="button" onClick={() => setFollow(!follow)} className={cn("rounded-full px-3 py-1 text-[12.5px] font-medium", follow ? "bg-ok/15 text-ok" : "bg-black/5")}>
            {follow ? "● Following the board" : "Follow the board"}
          </button>
        )}
      </div>

      {/* money and state at t */}
      <div className="glass grid grid-cols-2 divide-line sm:grid-cols-5 sm:divide-x">
        <Kpi label="Pumps down" value={String(down.length)} tone={down.length ? "crit" : undefined} />
        <Kpi label="To inspect" value={String(inspect.length)} tone={inspect.length ? "warn" : undefined} />
        <Kpi label="If nobody acts" value={money(sum("doNothingCost"))} tone="crit" strike={sum("doNothingCost") > sum("cost")} />
        <Kpi label="Plan cost" value={money(sum("cost"))} />
        <Kpi label={unknownCost ? "Kept (some plans unknown)" : "Kept"} value={money(sum("kept"))} tone="ok" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.45fr_1fr]">
        <FieldMap tl={tl} at={at} ongoing={ongoing} />
        <Ledger tl={tl} at={at} started={started} />
      </div>

      <Pipeline tl={tl} steps={steps} facilities={facilities} feed={feed} liveHere={liveHere} playing={playing || (liveHere && follow)} at={at} />
    </div>
  );
}

function Kpi({ label, value, tone, strike }: { label: string; value: string; tone?: "crit" | "warn" | "ok"; strike?: boolean }) {
  return (
    <div className="px-4 py-2.5">
      <p className="text-[12px] text-faint">{label}</p>
      <p className={cn("text-[20px] font-semibold tabular-nums", tone === "crit" && "text-crit", tone === "warn" && "text-warn", tone === "ok" && "text-ok", strike && "line-through decoration-2 opacity-80")}>{value}</p>
    </div>
  );
}

// ---- map --------------------------------------------------------------------------------------------------------

/** Where truck job `j` is at time `at`: yard -> facility (first arrival) -> disposal -> facility ... -> yard. */
function truckPos(j: Timeline["trucks"][number], at: number, yard: Pt, fac: Pt, disp: Pt): Pt | null {
  if (at < j.fromUnix || at > j.toUnix) return null;
  const stops: { t: number; p: Pt }[] = [{ t: j.fromUnix, p: yard }];
  j.arrivalsUnix.forEach((a, k) => {
    if (k > 0) stops.push({ t: (j.arrivalsUnix[k - 1]! + a) / 2, p: disp });
    stops.push({ t: a, p: fac });
  });
  stops.push({ t: j.toUnix, p: yard });
  for (let k = 1; k < stops.length; k++) {
    const a = stops[k - 1]!, b = stops[k]!;
    if (at <= b.t) { const f = b.t > a.t ? (at - a.t) / (b.t - a.t) : 1; return { x: a.p.x + (b.p.x - a.p.x) * f, y: a.p.y + (b.p.y - a.p.y) * f }; }
  }
  return yard;
}

export function FieldMap({ tl, at, ongoing, bare }: { tl: Timeline; at: number; ongoing: Timeline["incidents"]; bare?: boolean }) {
  // Schematic, one tile per system (any number of systems): the disposal site in the middle, each facility around it
  // in its real compass direction from the site, the truck yard in the tile's corner. Trucks drive yard -> facility.
  const n = tl.systems.length, cols = n <= 2 ? n : n <= 4 ? 2 : 3, rows = Math.ceil(n / cols);
  const CW = 250, CH = 200, W = cols * CW, H = rows * CH;
  const layout = useMemo(() => tl.systems.map((s, k) => {
    const ox = (k % cols) * CW, oy = Math.floor(k / cols) * CH;
    const disp = { x: ox + CW * 0.56, y: oy + CH * 0.54 };
    const yard = { x: ox + 30, y: oy + CH - 34 };
    const k0 = Math.cos((s.disposal.lat * Math.PI) / 180);
    const fac = new Map(s.facilities.map((f, i) => {
      let a = Math.atan2(-(f.lat - s.disposal.lat), (f.lon - s.disposal.lon) * k0);
      if (!Number.isFinite(a) || (f.lat === s.disposal.lat && f.lon === s.disposal.lon)) a = (i / s.facilities.length) * 2 * Math.PI;
      return [f.id, { x: disp.x + Math.cos(a) * 62, y: disp.y + Math.sin(a) * 52 } as Pt];
    }));
    // spread facilities that land on top of each other
    const pts = [...fac.values()];
    for (let i = 0; i < pts.length; i++) for (let j = 0; j < i; j++) {
      const a = pts[i]!, b = pts[j]!;
      if (Math.hypot(a.x - b.x, a.y - b.y) < 26) { a.x += 18; a.y += 14; }
    }
    return { s, ox, oy, disp, yard, fac };
  }), [tl, cols]);
  const stateOf = (fid: string) => {
    const here = ongoing.filter((i) => i.facilityId === fid);
    return here.some((i) => i.category === "pump_failure") ? "crit" : here.length ? "warn" : "ok";
  };
  const levelAt = (fid: string) => {
    const arr = tl.levels[fid]; if (!arr) return null;
    return arr[Math.min(arr.length - 1, Math.max(0, Math.floor((at - tl.startUnix) / tl.seriesStepSeconds)))] ?? null;
  };
  const color = { crit: "var(--crit)", warn: "var(--warn-fill)", ok: "var(--water)" } as const;
  return (
    <section className={cn("overflow-hidden", !bare && "glass")} aria-label="Field map">
      <div className={cn("flex flex-wrap items-center justify-between gap-2 px-4 pt-3 text-[13px]", bare && "hidden")}>
        <span className="font-semibold">The field</span>
        <span className="flex flex-wrap gap-3 text-faint"><span><Dot c="var(--crit)" /> pump down</span><span><Dot c="var(--warn-fill)" /> leak or worn</span><span><Dot c="var(--water)" /> running</span><span><Truck small /> truck</span><span>◆ disposal</span></span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label="Systems, facilities, yards and trucks">
        {layout.map(({ s, ox, oy, disp, yard, fac }) => {
          const busy = tl.trucks.filter((j) => j.systemId === s.id && at >= j.fromUnix && at <= j.toUnix).length;
          const down = s.facilities.some((f) => stateOf(f.id) === "crit");
          return (
            <g key={s.id}>
              <rect x={ox + 6} y={oy + 6} width={CW - 12} height={CH - 12} rx={12} fill={down ? "color-mix(in oklab, var(--crit) 5%, transparent)" : "transparent"} stroke="var(--line-soft)" />
              <text x={ox + 18} y={oy + 26} fontSize={12.5} fontWeight={700} fill="currentColor">{`${s.id}`}<tspan fontWeight={500} opacity={0.6}>{` · ${s.fleetSize - Math.min(busy, s.fleetSize)}/${s.fleetSize} trucks free`}</tspan></text>
              {tl.trucks.filter((j) => j.systemId === s.id && at >= j.fromUnix && at <= j.toUnix).map((j) => {
                const f = fac.get(j.facilityId); return f ? <line key={`r${j.incidentId}#${j.truck}`} x1={yard.x} y1={yard.y} x2={f.x} y2={f.y} stroke="var(--crit)" strokeWidth={1.5} strokeDasharray="4 4" opacity={0.6} /> : null;
              })}
              {s.facilities.map((f) => { const p = fac.get(f.id)!; return <line key={f.id} x1={p.x} y1={p.y} x2={disp.x} y2={disp.y} stroke={color[stateOf(f.id)]} strokeWidth={2} opacity={0.55} />; })}
              <rect x={disp.x - 5} y={disp.y - 5} width={10} height={10} transform={`rotate(45 ${disp.x} ${disp.y})`} fill="currentColor" opacity={0.8} />
              <g transform={`translate(${yard.x - 10} ${yard.y - 10})`}>
                <rect width={20} height={20} rx={5} fill="none" stroke="currentColor" strokeWidth={1.4} opacity={0.6} />
                <text x={10} y={33} textAnchor="middle" fontSize={10} fill="currentColor" opacity={0.55}>yard</text>
              </g>
              {s.facilities.map((f) => {
                const p = fac.get(f.id)!, st = stateOf(f.id), lvl = levelAt(f.id);
                const out = { x: p.x + (p.x - disp.x) * 0.35, y: p.y + (p.y - disp.y) * 0.35 };
                return (
                  <g key={f.id}>
                    {st === "crit" && <circle cx={p.x} cy={p.y} r={15} fill="none" stroke={color.crit} strokeWidth={2} opacity={0.45}><animate attributeName="r" values="11;18;11" dur="1.6s" repeatCount="indefinite" /></circle>}
                    <circle cx={p.x} cy={p.y} r={11} fill="var(--background, white)" stroke={color[st]} strokeWidth={2.5} />
                    <text x={p.x} y={p.y + 3.5} textAnchor="middle" fontSize={9.5} fontWeight={700} fill="currentColor">{(/_FACILITY_(.+)$/.exec(f.id)?.[1] ?? f.id).slice(0, 2)}</text>
                    {lvl != null && <text x={out.x} y={out.y + 3} textAnchor="middle" fontSize={9.5} fontWeight={st === "crit" ? 700 : 500} fill={st === "crit" ? color.crit : "currentColor"} opacity={st === "crit" ? 1 : 0.6}>{`${Math.round(lvl)}%`}</text>}
                  </g>
                );
              })}
              {tl.trucks.filter((j) => j.systemId === s.id).map((j) => {
                const f = fac.get(j.facilityId); if (!f) return null;
                const pos = truckPos(j, at, yard, f, disp); if (!pos) return null;
                return <g key={`${j.incidentId}#${j.truck}`} transform={`translate(${pos.x - 11} ${pos.y - 7})`}><Truck /></g>;
              })}
            </g>
          );
        })}
      </svg>
    </section>
  );
}

export function Truck({ small }: { small?: boolean }) {
  return small
    ? <svg width="16" height="10" viewBox="0 0 22 14" aria-hidden className="inline align-[-1px]"><rect x="0" y="2" width="14" height="9" rx="2" fill="var(--crit)" /><rect x="14" y="5" width="7" height="6" rx="1.5" fill="var(--crit)" /></svg>
    : <g><rect x="0" y="2" width="14" height="9" rx="2" fill="var(--crit)" /><rect x="14" y="5" width="7" height="6" rx="1.5" fill="var(--crit)" /><circle cx="4" cy="12" r="2" fill="currentColor" /><circle cx="17" cy="12" r="2" fill="currentColor" /></g>;
}
const Dot = ({ c }: { c: string }) => <span className="inline-block size-2 translate-y-[-1px] rounded-full" style={{ background: c }} />;

// ---- ledger -----------------------------------------------------------------------------------------------------

function Ledger({ tl, at, started }: { tl: Timeline; at: number; started: Timeline["incidents"] }) {
  const plan = new Map(tl.plans.map((p) => [p.incidentId, p]));
  const rows = [...started].reverse().slice(0, 40);
  return (
    <section className="glass flex min-h-0 flex-col" aria-label="Plan ledger">
      <div className="flex items-center justify-between px-4 pt-3 text-[13px]"><span className="font-semibold">Plan ledger</span><span className="text-faint">newest first · planned at each onset</span></div>
      {rows.length === 0 ? <p className="px-4 py-6 text-[13.5px] text-muted-foreground">Nothing has happened yet. Press Play.</p> : (
        <ol className="mt-1 max-h-[420px] overflow-y-auto">
          {rows.map((i) => {
            const p = plan.get(i.id), open = i.endUnix == null || i.endUnix > at;
            const tone = i.category === "pump_failure" ? "var(--crit)" : "var(--warn-fill)";
            return (
              <li key={i.id} className="grid grid-cols-[74px_1fr_auto] gap-x-3 border-t-[0.5px] border-line px-4 py-2 text-[13px]">
                <span className="font-mono text-faint tabular-nums">{dayClock(i.onsetUnix)}</span>
                <span className="min-w-0">
                  <span className="font-semibold"><Dot c={tone} /> {shortName(i.facilityId)} {(categoryLabel[i.category as keyof typeof categoryLabel] ?? i.category).toLowerCase()}</span>
                  <span className="block truncate text-faint">
                    {i.category === "pump_failure"
                      ? (p ? `${p.label}${p.shutIns.length ? ` · shut in ${p.shutIns.map((w) => w.wellId.replace(/^.*_WELL_/, "")).join(", ")}` : ""}` : "no plan")
                      : "send an inspector · no countdown"}
                    {open ? "" : " · over"}
                  </span>
                </span>
                <span className="text-right tabular-nums">
                  {i.category !== "pump_failure" ? <span className="text-faint">inspect</span>
                    : p?.cost != null && p.doNothingCost != null
                      ? <>{p.doNothingCost > p.cost && <s className="mr-1.5 text-crit/80">{money(p.doNothingCost)}</s>}<span className="font-semibold text-ok">{money(p.cost)}</span></>
                      : <span className="text-faint">unknown</span>}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

// ---- pipeline ---------------------------------------------------------------------------------------------------

function Pipeline({ tl, steps, facilities, feed, liveHere, playing, at }: { tl: Timeline; steps: number; facilities: number; feed: BoardFeed | null; liveHere: boolean; playing: boolean; at: number }) {
  const records = steps * facilities;
  const kb = (records * RECORD_BYTES) / 1024;
  const onBoard = tl.detections.from === "board";
  const boardLast = liveHere && feed?.lastTsUnix != null ? feed.lastTsUnix : tl.detections.boardLastUnix;
  const resultSteps = boardLast == null ? 0 : Math.max(0, Math.floor((Math.min(at, boardLast) - tl.startUnix) / tl.stepSeconds) + 1);
  const results = onBoard || liveHere ? resultSteps * facilities : 0;
  const chip = tl.detections.provenance === "fpga" || feed?.source === "fpga" ? "Eclypse Z7 (FPGA)" : onBoard ? "Software board" : "Software runtime";
  const nodes = [
    { name: "Dataset", sub: "network · ops · telemetry", stat: `${steps.toLocaleString()} of ${Math.round((tl.datasetNowUnix - tl.startUnix) / tl.stepSeconds + 1).toLocaleString()} steps` },
    { name: "replay.py", sub: "CSV → 48 B records", stat: `${records.toLocaleString()} records · ${kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`}` },
    { name: chip, sub: "features · 4 heads · alarms", stat: onBoard || liveHere ? `${results.toLocaleString()} results` : "no board results", tone: onBoard || liveHere ? "nv" : undefined },
    { name: "listen.py", sub: "results → JSON", stat: feed?.configured ? (feed.online ? `live · ${feed.results.toLocaleString()} read` : `idle · ${feed.results.toLocaleString()} read`) : "not configured" },
    { name: "Operator API", sub: "incidents · planner · fleet", stat: `${tl.incidents.filter((i) => i.onsetUnix <= at).length} incidents · ${tl.plans.filter((p) => p.plannedUnix <= at).length} plans` },
    { name: "Console", sub: "you are here", stat: dayClock(at) },
  ];
  return (
    <section className="glass px-4 py-3" aria-label="Data path">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
        <span className="font-semibold">Data path</span>
        <span className="text-faint">
          {liveHere ? <span className="font-medium text-ok">● Live: the board is sending this dataset now</span>
            : tl.nowUnix < tl.datasetNowUnix ? `The board's results stop at ${dayClock(tl.nowUnix)} of ${dayClock(tl.datasetNowUnix)}: the story ends there (${tl.detections.label})`
            : onBoard ? `Replaying the board's recorded results (${tl.detections.label})` : "No board results for this dataset: detections from the console's software runtime"}
        </span>
      </div>
      <ol className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {nodes.map((n, k) => (
          <li key={n.name} className="relative rounded-lg px-3 py-2 shadow-[0_0_0_0.5px_var(--line)]">
            <p className={cn("text-[13px] font-semibold", n.tone === "nv" && "text-[var(--nv)]")}>{n.name}</p>
            <p className="text-[11.5px] text-faint">{n.sub}</p>
            <p className="mt-1 text-[12px] tabular-nums">{n.stat}</p>
            {k < nodes.length - 1 && (
              <span aria-hidden className="absolute top-1/2 -right-2 hidden h-[2px] w-2 overflow-hidden bg-line lg:block">
                {playing && <span className="sim-packet absolute inset-y-0 w-1 bg-water" />}
              </span>
            )}
          </li>
        ))}
      </ol>
      <p className="mt-2 text-[11.5px] text-faint">
        Plans are the operator API's own (planner + validator, shared fleet per system), made at each failure's onset; the money is each plan versus doing
        nothing. A simulation of the recording: nothing here is sent to the board or written back to the data.
      </p>
    </section>
  );
}
