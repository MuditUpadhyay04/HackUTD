"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { DatasetInfo, SimulationTimeline } from "@hackutd/contracts";
import { api, defaultDataset, unwrap } from "@/lib/api";
import { categoryLabel, clock, clockFrom, dayClock, facilityTitle, money } from "@/lib/format";
import { cn } from "@/lib/utils";
import { FieldMap, SPEEDS, useBoardFeed, useSimulation, type BoardFeed } from "@/components/console/simulation";

/**
 * The live wall: one calm screen for the night shift and for presenting. Three questions, top to bottom:
 *   1. Is the chip getting the data?  (the feed: records in, live rate, what it just decided)
 *   2. What needs attention now?      (at most a handful of plain sentences, worst first)
 *   3. What did acting save?          (if nobody acts / our plan / kept)
 * Everything comes from the operator API (GET /api/board, GET /api/datasets/:id/timeline). Read-only.
 */

// Design figure from the RTL, not a measurement: the engine accepts one record every 15 cycles at 50 MHz
// (FPGA/reports/RTL_DONE_HANDOFF.md, "Throughput").
const CHIP_US_PER_RECORD = 15 / 50;
// Measured on the board (Sun Nov 8, board suite T1): 29,941 records/s end to end, PC -> board -> PC over Ethernet.
const WIRE_US_PER_RECORD = 1e6 / 29_941;
// Measured: the Nemotron agents' run on the laptop demo (35.6 s).
const NEMOTRON_S = 35.6;

const C = { bg: "#0a0e13", panel: "#121821", line: "rgba(255,255,255,0.10)", dim: "rgba(235,240,247,0.55)", text: "#eef2f7",
  crit: "#ff5a4f", warn: "#ffae3d", ok: "#3ddc84", water: "#4aa3ff", chip: "#76b900" };

function useRate(feed: BoardFeed | null) {
  const samples = useRef<{ t: number; n: number }[]>([]);
  const [rate, setRate] = useState(0);
  useEffect(() => {
    if (!feed) return;
    const now = Date.now(), s = samples.current;
    s.push({ t: now, n: feed.results });
    while (s.length > 2 && now - s[0]!.t > 6000) s.shift();
    const a = s[0]!, b = s[s.length - 1]!;
    setRate(b.t > a.t && b.n >= a.n ? ((b.n - a.n) * 1000) / (b.t - a.t) : 0);
  }, [feed]);
  return feed?.online ? rate : 0;
}

export function LiveWall() {
  const params = useSearchParams();
  const [datasets, setDatasets] = useState<DatasetInfo[]>([]);
  const [err, setErr] = useState("");
  const feed = useBoardFeed(1000);
  useEffect(() => {
    let live = true;
    const load = async () => { try { const d = unwrap(await api.api.datasets.get()) as DatasetInfo[]; if (live) setDatasets(d); } catch (e) { if (live) setErr(e instanceof Error ? e.message : String(e)); } };
    void load();
    const id = setInterval(load, 15_000);
    return () => { live = false; clearInterval(id); };
  }, []);
  // Which dataset: ?dataset=, else the one the board is streaming (its time inside the range; the longest wins), else
  // the judges' test folder, then the mock test.
  const dataset = useMemo(() => {
    const asked = params.get("dataset");
    if (asked) return datasets.find((d) => d.id === asked || d.label === asked);
    const ts = feed?.online ? feed.lastTsUnix : null;
    const streaming = ts == null ? [] : datasets.filter((d) => ts >= d.startUnix && ts <= d.nowUnix).sort((a, b) => (b.nowUnix - b.startUnix) - (a.nowUnix - a.startUnix));
    return streaming[0] ?? defaultDataset(datasets);
  }, [datasets, feed?.online, feed?.lastTsUnix, params]);
  const sim = useSimulation(dataset?.id, feed);
  const rate = useRate(feed);

  return (
    <div className="min-h-screen" style={{ background: C.bg, color: C.text, ["--background" as string]: C.bg, ["--line" as string]: C.line, ["--line-soft" as string]: "rgba(255,255,255,0.06)", ["--water" as string]: C.water, ["--crit" as string]: C.crit, ["--warn-fill" as string]: C.warn }}>
      <div className="mx-auto flex max-w-[1500px] flex-col gap-4 px-4 py-4 sm:px-6">
        <Header dataset={dataset} feed={feed} at={sim.t} live={sim.liveHere && sim.follow} />
        {err && <p role="alert" style={{ color: C.crit }}>Can't reach the operator API: {err}</p>}
        <Feed feed={feed} rate={rate} live={sim.liveHere} />
        {!sim.tl ? (
          <Panel><p className="px-6 py-10 text-[20px]" style={{ color: C.dim }}>{sim.error ? `Couldn't build the week: ${sim.error}` : dataset ? "Loading the week…" : "No dataset yet: upload one in the full console, or point the API at a data folder."}</p></Panel>
        ) : (
          <Story tl={sim.tl} at={sim.t} flagged={sim.liveHere && sim.follow ? feed?.flagged ?? [] : []} />
        )}
        {sim.tl && !(sim.liveHere && sim.follow) && (
          <Transport tl={sim.tl} t={sim.t} setT={sim.setT} playing={sim.playing} setPlaying={sim.setPlaying} speed={sim.speed} setSpeed={sim.setSpeed} liveHere={sim.liveHere} setFollow={sim.setFollow} />
        )}
        <Speed />
      </div>
    </div>
  );
}

function Panel({ children, className, title, right }: { children: React.ReactNode; className?: string; title?: string; right?: React.ReactNode }) {
  return (
    <section className={cn("rounded-2xl", className)} style={{ background: C.panel, boxShadow: `0 0 0 1px ${C.line}` }}>
      {title && <div className="flex items-baseline justify-between gap-3 px-5 pt-4"><h2 className="text-[13px] font-semibold tracking-[0.12em] uppercase" style={{ color: C.dim }}>{title}</h2>{right}</div>}
      {children}
    </section>
  );
}

function Header({ dataset, feed, at, live }: { dataset?: DatasetInfo; feed: BoardFeed | null; at: number; live: boolean }) {
  const fpga = feed?.source === "fpga";
  const on = !!feed?.online;
  return (
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="text-[13px] font-semibold tracking-[0.14em] uppercase" style={{ color: C.dim }}>Beat the Shutdown · Night shift</p>
        <p className="text-[15px]" style={{ color: C.dim }}>{dataset ? dataset.label : "—"}</p>
      </div>
      <div className="flex items-center gap-4">
        <span className="flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[14px] font-semibold" style={{ background: on ? "rgba(61,220,132,0.12)" : "rgba(255,255,255,0.06)", color: on ? C.ok : C.dim }}>
          <span className={cn("size-2.5 rounded-full", on && "animate-pulse")} style={{ background: on ? C.ok : C.dim }} />
          {on ? `${fpga ? "Eclypse Z7 FPGA" : "Software board"} live${feed?.weightsVersion != null ? ` · model v${feed.weightsVersion}` : ""}` : feed?.results ? "Board idle" : "Board not connected"}
        </span>
        {at > 0 && <span className="rounded-xl px-4 py-2 font-mono text-[28px] font-semibold tabular-nums" style={{ background: "#000", boxShadow: `0 0 0 1px ${C.line}` }}>{dayClock(at)}{live && <span className="ml-2 align-middle text-[12px] font-sans" style={{ color: C.ok }}>LIVE</span>}</span>}
        <Link href={dataset ? `/?dataset=${encodeURIComponent(dataset.id)}` : "/"} className="text-[14px] underline-offset-4 hover:underline" style={{ color: C.water }}>Full console →</Link>
      </div>
    </header>
  );
}

function Big({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[13px]" style={{ color: C.dim }}>{label}</p>
      <p className="truncate text-[34px] leading-tight font-bold tabular-nums" style={{ color: tone ?? C.text }}>{value}</p>
      {sub && <p className="text-[12px]" style={{ color: C.dim }}>{sub}</p>}
    </div>
  );
}

/** 1. Is the chip getting the data? */
function Feed({ feed, rate, live }: { feed: BoardFeed | null; rate: number; live: boolean }) {
  const on = !!feed?.online;
  const hops = ["Sensors", "PC", feed?.source === "fpga" ? "FPGA" : "Board", "Console"];
  // dots move faster the more records per second actually arrive
  const dur = on ? Math.max(0.25, Math.min(2.5, 60 / Math.max(rate, 1))) : 0;
  return (
    <Panel title="The chip, live" right={<span className="text-[13px]" style={{ color: C.dim }}>{on ? (live ? "streaming this dataset now" : "streaming") : "waiting for replay.py"}</span>}>
      <div className="grid gap-4 px-5 pt-3 pb-5 lg:grid-cols-[1.1fr_1fr]">
        <div>
          <div className="flex items-center gap-2" aria-label="Data path">
            {hops.map((h, i) => (
              <div key={h} className="flex flex-1 items-center gap-2 last:flex-none">
                <span className="rounded-lg px-3 py-2 text-[15px] font-semibold" style={{ background: i === 2 ? "rgba(118,185,0,0.16)" : "rgba(255,255,255,0.06)", color: i === 2 ? C.chip : C.text }}>{h}</span>
                {i < hops.length - 1 && (
                  <span className="relative h-[3px] flex-1 overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.08)" }}>
                    {on && [0, 1, 2].map((k) => <span key={k} className="live-dot absolute top-0 h-[3px] w-3 rounded-full" style={{ background: C.water, animationDuration: `${dur}s`, animationDelay: `${(k * dur) / 3}s` }} />)}
                  </span>
                )}
              </div>
            ))}
          </div>
          <div className="mt-4 grid grid-cols-3 gap-4">
            <Big label="Decisions from the chip" value={(feed?.results ?? 0).toLocaleString()} sub={feed?.stats ? `board counters: ${feed.stats.recordsIn.toLocaleString()} in · ${feed.stats.resultsOut.toLocaleString()} out` : "results read by listen.py"} />
            <Big label="Live rate" value={on ? `${Math.round(rate).toLocaleString()}/s` : "—"} sub="measured, records per second" />
            <Big label="Lost or bad packets" value={feed?.stats ? String(feed.stats.seqGaps + feed.stats.badPackets) : "—"} tone={feed?.stats && feed.stats.seqGaps + feed.stats.badPackets > 0 ? C.warn : C.ok} sub="from the board's own counters" />
          </div>
        </div>
        <div className="min-w-0">
          <p className="mb-1.5 text-[13px]" style={{ color: C.dim }}>What it just decided</p>
          <ol className="grid gap-1 font-mono text-[14px]">
            {(feed?.recent ?? []).slice(0, 6).map((r, i) => {
              const bad = r.active.length > 0;
              return (
                <li key={`${r.facility}${r.tsUnix}${i}`} className="flex items-center justify-between gap-3 rounded-md px-2.5 py-1" style={{ background: bad ? "rgba(255,90,79,0.12)" : "rgba(255,255,255,0.03)" }}>
                  <span className="truncate">{clock(r.tsUnix)} · {facilityTitle(r.facility)}</span>
                  <span style={{ color: bad ? C.crit : r.status === "VALID" ? C.ok : C.warn }}>
                    {bad ? r.active.map((a) => (categoryLabel[a as keyof typeof categoryLabel] ?? a).toUpperCase()).join(", ") : r.status === "VALID" ? "OK" : r.status}
                  </span>
                </li>
              );
            })}
            {!feed?.recent?.length && <li style={{ color: C.dim }}>Nothing yet. Start replay.py to push a dataset through the chip.</li>}
          </ol>
        </div>
      </div>
    </Panel>
  );
}

/** 2 + 3. What needs attention now, on the map, and what acting saved. */
function Story({ tl, at, flagged }: { tl: SimulationTimeline; at: number; flagged: NonNullable<BoardFeed["flagged"]> }) {
  const known = tl.incidents.filter((i) => i.onsetUnix <= at && (i.endUnix == null || i.endUnix > at));
  // Live: what the chip flags right now shows at once; the planner's story (plans, trucks) catches up within ~20 s.
  const systemOf = new Map(tl.systems.flatMap((s) => s.facilities.map((f) => [f.id, s.id] as const)));
  const fresh = flagged.filter((f) => at - f.tsUnix <= 600).flatMap((f) => f.active.filter((c) => c !== "facility_shut_in")
    .filter((c) => !known.some((i) => i.facilityId === f.facility && i.category === c))
    .map((c) => ({ id: `live:${f.facility}:${c}`, category: c as SimulationTimeline["incidents"][number]["category"], systemId: systemOf.get(f.facility) ?? "", facilityId: f.facility, onsetUnix: f.tsUnix, endUnix: null, provenance: "fpga" as const, fresh: true })));
  const ongoing: (SimulationTimeline["incidents"][number] & { fresh?: boolean })[] = [...known, ...fresh];
  const plan = new Map(tl.plans.map((p) => [p.incidentId, p]));
  const items = [...ongoing].filter((i) => i.category !== "facility_shut_in")
    .sort((a, b) => (a.category === "pump_failure" ? 0 : 1) - (b.category === "pump_failure" ? 0 : 1) || a.onsetUnix - b.onsetUnix);
  const costed = tl.plans.filter((p) => p.plannedUnix <= at && p.cost != null && p.doNothingCost != null);
  const sum = (k: "cost" | "doNothingCost" | "kept") => costed.reduce((s, p) => s + (p[k] ?? 0), 0);
  const nextArrival = (incidentId: string) => tl.trucks.filter((j) => j.incidentId === incidentId).flatMap((j) => j.arrivalsUnix).filter((a) => a > at).sort((a, b) => a - b)[0];
  return (
    <>
      <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
        <Panel title="The field" right={<span className="text-[13px]" style={{ color: C.dim }}><Dot c={C.crit} /> pump down <Dot c={C.warn} /> leak or worn pump <Dot c={C.water} /> running</span>}>
          <div className="px-2 pb-2"><FieldMap tl={tl} at={at} ongoing={ongoing} bare /></div>
        </Panel>
        <Panel title="Needs attention" right={<span className="text-[13px]" style={{ color: C.dim }}>worst first</span>}>
          <ol className="grid gap-2.5 px-4 pt-3 pb-4">
            {items.length === 0 && <li className="rounded-xl px-4 py-6 text-[24px] font-semibold" style={{ background: "rgba(61,220,132,0.10)", color: C.ok }}>All clear. Every pump is running.</li>}
            {items.slice(0, 5).map((i) => {
              const p = plan.get(i.id), failure = i.category === "pump_failure", arr = failure ? nextArrival(i.id) : undefined;
              return (
                <li key={i.id} className="rounded-xl px-4 py-3" style={{ background: failure ? "rgba(255,90,79,0.12)" : "rgba(255,174,61,0.10)", boxShadow: `inset 3px 0 0 ${failure ? C.crit : C.warn}` }}>
                  <p className="text-[20px] leading-snug font-bold">{facilityTitle(i.facilityId)}: {(categoryLabel[i.category as keyof typeof categoryLabel] ?? i.category).toLowerCase()}</p>
                  <p className="text-[15px]" style={{ color: C.dim }}>
                    {"fresh" in i && i.fresh ? "just flagged by the chip · " : `since ${clockFrom(i.onsetUnix, at)} · `}
                    {!failure ? "send an inspector (no shutdown risk)"
                      : p && p.kind !== "unavailable" ? `${p.label}${arr ? `, truck arrives ${clock(arr)}` : ""}${p.kept ? ` · saves ${money(p.kept)}` : ""}` : "fleet plan coming"}
                  </p>
                </li>
              );
            })}
            {items.length > 5 && <li className="px-1 text-[14px]" style={{ color: C.dim }}>+{items.length - 5} more in the full console</li>}
          </ol>
        </Panel>
      </div>
      <Panel>
        <div className="grid grid-cols-3 gap-4 px-6 py-4">
          <Big label="If nobody acts" value={money(sum("doNothingCost"))} tone={C.crit} sub="lost production and trips, every failure so far" />
          <Big label="Our plan" value={money(sum("cost"))} sub="the planner's cheapest validated plans" />
          <Big label="Kept" value={money(sum("kept"))} tone={C.ok} sub="planned at each failure, shared trucks per system" />
        </div>
      </Panel>
    </>
  );
}
const Dot = ({ c }: { c: string }) => <span className="mx-1 inline-block size-2.5 translate-y-[-1px] rounded-full" style={{ background: c }} />;

function Transport({ tl, t, setT, playing, setPlaying, speed, setSpeed, liveHere, setFollow }: {
  tl: SimulationTimeline; t: number; setT: (t: number) => void; playing: boolean; setPlaying: (p: boolean) => void; speed: number; setSpeed: (s: number) => void; liveHere: boolean; setFollow: (f: boolean) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl px-4 py-3" style={{ background: C.panel, boxShadow: `0 0 0 1px ${C.line}` }}>
      <button type="button" aria-label={playing ? "Pause the week" : "Play the week"} onClick={() => { if (t >= tl.nowUnix) setT(tl.startUnix); setPlaying(!playing); }}
        className="rounded-lg px-5 py-2 text-[16px] font-bold" style={{ background: C.water, color: "#fff" }}>{playing ? "Pause" : t >= tl.nowUnix ? "Replay the week" : "Play the week"}</button>
      <div className="flex overflow-hidden rounded-lg" style={{ boxShadow: `0 0 0 1px ${C.line}` }}>
        {SPEEDS.map((s, i) => <button key={s.label} type="button" onClick={() => setSpeed(i)} className="px-3 py-2 text-[14px] tabular-nums" style={{ background: i === speed ? "rgba(74,163,255,0.25)" : "transparent" }}>{s.label}</button>)}
      </div>
      <input type="range" aria-label="Time" className="min-w-[160px] flex-1" style={{ accentColor: C.water }} min={tl.startUnix} max={tl.nowUnix} step={tl.stepSeconds} value={Math.min(Math.max(t, tl.startUnix), tl.nowUnix)} onChange={(e) => setT(Number(e.target.value))} />
      {liveHere && <button type="button" onClick={() => setFollow(true)} className="rounded-lg px-3 py-2 text-[14px] font-semibold" style={{ color: C.ok, boxShadow: `0 0 0 1px ${C.ok}` }}>Back to live</button>}
    </div>
  );
}

/** How fast is the chip? Log scale, so a microsecond and five minutes fit on one screen. */
function Speed() {
  const rows = [
    { label: "The FPGA decides one reading", s: CHIP_US_PER_RECORD / 1e6, note: "0.3 µs · RTL design: 15 cycles at 50 MHz", c: C.chip },
    { label: "That reading's trip over Ethernet and back", s: WIRE_US_PER_RECORD / 1e6, note: "33 µs · measured on the board", c: C.water },
    { label: "Nemotron writes the shift handoff", s: NEMOTRON_S, note: `${NEMOTRON_S} s · measured`, c: C.warn },
    { label: "The sensors report again", s: 300, note: "every 5 min", c: C.dim },
  ];
  const lo = Math.log10(1e-7), hi = Math.log10(600);
  return (
    <Panel title="How fast is the chip?" right={<span className="text-[13px]" style={{ color: C.dim }}>log scale</span>}>
      <div className="grid gap-2.5 px-5 pt-3 pb-4">
        {rows.map((r) => (
          <div key={r.label} className="grid grid-cols-[minmax(0,260px)_1fr] items-center gap-3 sm:grid-cols-[300px_1fr]">
            <span className="text-[15px]">{r.label}</span>
            <div className="flex items-center gap-3">
              <span className="h-3.5 rounded-full" style={{ width: `${Math.max(1.5, ((Math.log10(r.s) - lo) / (hi - lo)) * 100)}%`, background: r.c }} />
              <span className="shrink-0 text-[13px] tabular-nums" style={{ color: C.dim }}>{r.note}</span>
            </div>
          </div>
        ))}
        <p className="pt-1 text-[16px] font-semibold">
          The chip answers about <span style={{ color: C.chip }}>{Math.round(WIRE_US_PER_RECORD / CHIP_US_PER_RECORD)}×</span> faster than the network can carry the question, and about{" "}
          <span style={{ color: C.chip }}>a billion times</span> faster than the sensors report.
        </p>
      </div>
    </Panel>
  );
}
