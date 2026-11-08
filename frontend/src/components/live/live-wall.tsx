"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { DatasetInfo, SimulationTimeline } from "@hackutd/contracts";
import { api, defaultDataset, unwrap } from "@/lib/api";
import { categoryLabel, clock, dayClock, duration, facilityTitle, money } from "@/lib/format";
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
  const [view, setView] = useState<"operator" | "hood">(params.get("view") === "hood" ? "hood" : "operator");
  const live = sim.liveHere && sim.follow;

  return (
    <div className="min-h-screen" style={{ background: C.bg, color: C.text, ["--background" as string]: C.bg, ["--line" as string]: C.line, ["--line-soft" as string]: "rgba(255,255,255,0.06)", ["--water" as string]: C.water, ["--crit" as string]: C.crit, ["--warn-fill" as string]: C.warn }}>
      <div className="mx-auto flex max-w-[1500px] flex-col gap-4 px-4 py-4 sm:px-6">
        <Header dataset={dataset} feed={feed} at={sim.t} live={live} view={view} setView={setView} />
        {err && <p role="alert" style={{ color: C.crit }}>Can’t reach the operator API: {err}</p>}
        {!sim.tl ? (
          <Panel><p className="px-6 py-10 text-[20px]" style={{ color: C.dim }}>{sim.error ? `Couldn't build the week: ${sim.error}` : dataset ? "Loading the week…" : "No dataset yet: upload one in the full console, or point the API at a data folder."}</p></Panel>
        ) : view === "operator" ? (
          <div key="operator" className="wall-fade flex flex-col gap-4">
            <Operator story={story(sim.tl, sim.t, live ? feed?.flagged ?? [] : [])} tl={sim.tl} at={sim.t} />
            {dataset && <Nemotron datasetId={dataset.id} tl={sim.tl} at={sim.t} />}
          </div>
        ) : (
          <div key="hood" className="wall-fade flex flex-col gap-4">
            <Feed feed={feed} rate={rate} live={sim.liveHere} />
            <Funnel tl={sim.tl} at={sim.t} />
            <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
              <Ledger tl={sim.tl} at={sim.t} />
              <Speed />
            </div>
          </div>
        )}
        {sim.tl && !live && (
          <Transport tl={sim.tl} t={sim.t} setT={sim.setT} playing={sim.playing} setPlaying={sim.setPlaying} speed={sim.speed} setSpeed={sim.setSpeed} liveHere={sim.liveHere} setFollow={sim.setFollow} />
        )}
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

function Header({ dataset, feed, at, live, view, setView }: { dataset?: DatasetInfo; feed: BoardFeed | null; at: number; live: boolean; view: "operator" | "hood"; setView: (v: "operator" | "hood") => void }) {
  const fpga = feed?.source === "fpga";
  const on = !!feed?.online;
  return (
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="text-[13px] font-semibold tracking-[0.14em] uppercase" style={{ color: C.dim }}>Beat the Shutdown · Night shift</p>
        <p className="text-[15px]" style={{ color: C.dim }}>{dataset ? dataset.label : "—"}</p>
      </div>
      <div role="tablist" aria-label="View" className="flex rounded-full p-1" style={{ background: "rgba(255,255,255,0.06)", boxShadow: `0 0 0 1px ${C.line}` }}>
        {([["operator", "Operator"], ["hood", "Under the hood"]] as const).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={view === k} type="button" onClick={() => setView(k)}
            className="rounded-full px-5 py-2 text-[15px] font-semibold transition-colors" style={view === k ? { background: C.text, color: C.bg } : { color: C.dim }}>{label}</button>
        ))}
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
type Item = SimulationTimeline["incidents"][number] & { fresh?: boolean };
/** Everything the operator view needs at time `at`, derived once. */
function story(tl: SimulationTimeline, at: number, flagged: NonNullable<BoardFeed["flagged"]>) {
  const known = tl.incidents.filter((i) => i.onsetUnix <= at && (i.endUnix == null || i.endUnix > at));
  // Live: what the chip flags right now shows at once; the planner's story (plans, trucks) catches up within ~20 s.
  const systemOf = new Map(tl.systems.flatMap((s) => s.facilities.map((f) => [f.id, s.id] as const)));
  const fresh: Item[] = flagged.filter((f) => at - f.tsUnix <= 600).flatMap((f) => f.active.filter((c) => c !== "facility_shut_in")
    .filter((c) => !known.some((i) => i.facilityId === f.facility && i.category === c))
    .map((c) => ({ id: `live:${f.facility}:${c}`, category: c as Item["category"], systemId: systemOf.get(f.facility) ?? "", facilityId: f.facility, onsetUnix: f.tsUnix, endUnix: null, provenance: "fpga" as const, fresh: true })));
  const ongoing: Item[] = [...known, ...fresh];
  const plan = new Map(tl.plans.map((p) => [p.incidentId, p]));
  const items = ongoing.filter((i) => i.category !== "facility_shut_in")
    .sort((a, b) => (a.category === "pump_failure" ? 0 : 1) - (b.category === "pump_failure" ? 0 : 1) || a.onsetUnix - b.onsetUnix);
  const costed = tl.plans.filter((p) => p.plannedUnix <= at && p.cost != null && p.doNothingCost != null);
  const sum = (k: "cost" | "doNothingCost" | "kept") => costed.reduce((s, p) => s + (p[k] ?? 0), 0);
  const nextArrival = (incidentId: string) => tl.trucks.filter((j) => j.incidentId === incidentId).flatMap((j) => j.arrivalsUnix).filter((a) => a > at).sort((a, b) => a - b)[0];
  const failures = items.filter((i) => i.category === "pump_failure");
  const inspections = items.length - failures.length;
  // the soonest shutdown the plan does NOT prevent, and the soonest one it does
  const shut = failures.map((i) => plan.get(i.id)).filter((p): p is NonNullable<typeof p> => !!p && p.shutdownUnix != null && p.shutdownUnix > at);
  const unsaved = shut.filter((p) => p.planShutdownUnix != null || p.kind === "do_nothing").sort((a, b) => a.shutdownUnix! - b.shutdownUnix!)[0];
  const covered = shut.filter((p) => !(p.planShutdownUnix != null || p.kind === "do_nothing")).sort((a, b) => a.shutdownUnix! - b.shutdownUnix!)[0];
  return { ongoing, items, plan, sum, nextArrival, failures, inspections, unsaved, covered };
}
type Story = ReturnType<typeof story>;

/** The one sentence a night-shift operator needs first. */
function headline(st: Story, at: number) {
  const n = (k: number, one: string, many: string) => `${k === 1 ? "One" : k} ${k === 1 ? one : many}`;
  if (!st.items.length) return { text: "All clear. Every pump is running.", tone: C.ok };
  const parts: string[] = [];
  if (st.failures.length) parts.push(`${n(st.failures.length, "pump is down", "pumps are down")}.`);
  if (st.unsaved) parts.push(`${facilityTitle(st.unsaved.facilityId)} fills in ${duration((st.unsaved.shutdownUnix! - at) / 3600)} and no truck can reach it in time.`);
  else if (st.covered) parts.push(`The first tank would fill in ${duration((st.covered.shutdownUnix! - at) / 3600)}; the plan has it covered.`);
  if (st.inspections) parts.push(`${n(st.inspections, "thing needs", "things need")} an inspector.`);
  return { text: parts.join(" "), tone: st.failures.length ? C.crit : C.warn };
}

function Operator({ story: st, tl, at }: { story: Story; tl: SimulationTimeline; at: number }) {
  const h = headline(st, at);
  return (
    <>
      <p className="px-1 text-[30px] leading-tight font-bold sm:text-[36px]" style={{ color: h.tone }}>{h.text}</p>
      <div className="grid gap-4 xl:grid-cols-[1fr_1.25fr]">
        <Panel title="What to do" right={<span className="text-[13px]" style={{ color: C.dim }}>worst first</span>}>
          <ol className="grid gap-2.5 px-4 pt-3 pb-4">
            {st.items.length === 0 && <li className="rounded-xl px-4 py-6 text-[20px]" style={{ background: "rgba(61,220,132,0.10)", color: C.ok }}>Nothing to do. The chip is watching every facility.</li>}
            {st.items.slice(0, 5).map((i) => {
              const p = st.plan.get(i.id), failure = i.category === "pump_failure", arr = failure ? st.nextArrival(i.id) : undefined;
              return (
                <li key={i.id} className="rounded-xl px-4 py-3" style={{ background: failure ? "rgba(255,90,79,0.12)" : "rgba(255,174,61,0.10)", boxShadow: `inset 3px 0 0 ${failure ? C.crit : C.warn}` }}>
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="text-[20px] leading-snug font-bold">{facilityTitle(i.facilityId)}: {(categoryLabel[i.category as keyof typeof categoryLabel] ?? i.category).toLowerCase()}</p>
                    {failure && p && <Countdown at={at} shutdown={p.shutdownUnix} planShutdown={p.planShutdownUnix} kind={p.kind} />}
                  </div>
                  <p className="text-[16px]" style={{ color: C.dim }}>
                    {i.fresh ? "just flagged by the chip · " : ""}
                    {!failure ? "Send an inspector. No shutdown risk."
                      : p && p.kind !== "unavailable" ? `${planSentence(p.label, p.kind)}${arr ? ` Truck arrives ${clock(arr)}.` : ""}${p.kept ? ` Saves ${money(p.kept)}.` : ""}` : "Working out the fleet plan…"}
                  </p>
                </li>
              );
            })}
            {st.items.length > 5 && <li className="px-1 text-[14px]" style={{ color: C.dim }}>+{st.items.length - 5} more under the hood</li>}
          </ol>
        </Panel>
        <Panel title="The field" right={<span className="text-[13px]" style={{ color: C.dim }}><Dot c={C.crit} /> pump down <Dot c={C.warn} /> inspect <Dot c={C.water} /> running</span>}>
          <div className="px-2 pb-2"><FieldMap tl={tl} at={at} ongoing={st.ongoing} bare /></div>
        </Panel>
      </div>
      <Panel>
        <div className="grid grid-cols-3 gap-4 px-6 py-4">
          <Big label="If nobody had acted" value={money(st.sum("doNothingCost"))} tone={C.crit} />
          <Big label="Our plans cost" value={money(st.sum("cost"))} />
          <Big label="Kept" value={money(st.sum("kept"))} tone={C.ok} />
        </div>
      </Panel>
    </>
  );
}

const plural = (label: string) => label.replace(/(\d+) (\w+)\(s\)/g, (_m, k: string, w: string) => `${k} ${w}${k === "1" ? "" : "s"}`);
/** "1 truck(s), 2 trip(s)" -> "Send 1 truck, 2 trips." Plain words for the operator. */
function planSentence(label: string, kind: string) {
  if (kind === "do_nothing") return "No truck can get there in time: it shuts in until the repair.";
  const l = plural(label);
  return kind === "shut_in" ? `${l.charAt(0).toUpperCase()}${l.slice(1)}.` : `Send ${l}.`;
}

/** Under the hood: how many readings it took to get to the handful of things on the operator's screen. */
function Funnel({ tl, at }: { tl: SimulationTimeline; at: number }) {
  const facilities = tl.systems.reduce((n, s) => n + s.facilities.length, 0);
  const wells = tl.systems.reduce((n, s) => n + s.facilities.reduce((w, f) => w + f.wells, 0), 0);
  const steps = Math.max(0, Math.floor((Math.min(at, tl.datasetNowUnix) - tl.startUnix) / tl.stepSeconds) + 1);
  const readings = steps * (facilities * 7 + wells * 2);
  const records = steps * facilities;
  const incidents = tl.incidents.filter((i) => i.onsetUnix <= at).length;
  const actions = tl.plans.filter((p) => p.plannedUnix <= at && p.kind !== "do_nothing" && p.kind !== "unavailable").length + tl.incidents.filter((i) => i.onsetUnix <= at && i.category !== "pump_failure" && i.category !== "facility_shut_in").length;
  const rows = [
    { n: readings, label: "sensor readings", sub: `${facilities} facilities, ${wells} wells, every 5 minutes` },
    { n: records, label: "decisions by the FPGA", sub: "one 48-byte record per facility per step: 31 features, 4 models, alarms" },
    { n: incidents, label: "incidents", sub: "leaks, worn pumps, pump failures, with onset and end" },
    { n: actions, label: "things for the operator to do", sub: "an inspector, or a truck or shut-in plan the planner costed" },
  ];
  const max = Math.log10(Math.max(10, readings));
  return (
    <Panel title="What the operator doesn't have to read" right={<span className="text-[13px]" style={{ color: C.dim }}>so far this week</span>}>
      <div className="grid gap-2 px-5 pt-3 pb-5">
        {rows.map((r) => (
          <div key={r.label} className="grid grid-cols-[150px_1fr] items-center gap-4">
            <span className="text-right font-mono text-[26px] font-bold tabular-nums">{r.n.toLocaleString()}</span>
            <div>
              <div className="h-3 rounded-full" style={{ width: `${Math.max(2, (Math.log10(Math.max(1, r.n)) / max) * 100)}%`, background: r.label.startsWith("things") ? C.ok : r.label.startsWith("decisions") ? C.chip : "rgba(255,255,255,0.25)" }} />
              <p className="mt-1 text-[15px]"><span className="font-semibold">{r.label}</span> <span style={{ color: C.dim }}>· {r.sub}</span></p>
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

/** Under the hood: every failure's plan as it was made, against doing nothing. */
function Ledger({ tl, at }: { tl: SimulationTimeline; at: number }) {
  const rows = tl.plans.filter((p) => p.plannedUnix <= at).reverse();
  return (
    <Panel title="Every plan so far" right={<span className="text-[13px]" style={{ color: C.dim }}>planned at each failure</span>}>
      <ol className="max-h-[360px] overflow-y-auto px-5 pt-2 pb-4">
        {!rows.length && <li className="py-4 text-[15px]" style={{ color: C.dim }}>No pump failures yet.</li>}
        {rows.map((p) => (
          <li key={p.incidentId} className="grid grid-cols-[90px_1fr_auto] items-baseline gap-3 border-t py-2 text-[15px] first:border-t-0" style={{ borderColor: C.line }}>
            <span className="font-mono tabular-nums" style={{ color: C.dim }}>{dayClock(p.plannedUnix)}</span>
            <span><span className="font-semibold">{facilityTitle(p.facilityId)}</span> <span style={{ color: C.dim }}>{plural(p.label)}</span></span>
            <span className="tabular-nums">{p.doNothingCost != null && p.cost != null && p.doNothingCost > p.cost && <s className="mr-2" style={{ color: C.crit }}>{money(p.doNothingCost)}</s>}<span className="font-semibold" style={{ color: C.ok }}>{p.cost != null ? money(p.cost) : "—"}</span></span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

/** The pump-failure countdown: when the tank reaches shutdown if nobody acts, and whether the plan prevents it. */
function Countdown({ at, shutdown, planShutdown, kind }: { at: number; shutdown: number | null; planShutdown: number | null; kind: string }) {
  if (shutdown == null) return <span className="shrink-0 text-[14px] font-semibold" style={{ color: C.ok }}>no shutdown before the repair</span>;
  const saved = kind !== "do_nothing" && kind !== "unavailable" && planShutdown == null;
  if (at >= shutdown && !saved) return <span className="shrink-0 rounded-md px-2 py-0.5 text-[15px] font-bold" style={{ background: C.crit, color: "#fff" }}>SHUT IN since {clock(shutdown)}</span>;
  return (
    <span className="shrink-0 text-right leading-tight">
      <span className={cn("block font-mono text-[22px] font-bold tabular-nums", saved && "line-through opacity-60")} style={{ color: C.crit }}>{at < shutdown ? duration((shutdown - at) / 3600) : clock(shutdown)}</span>
      <span className="block text-[12px]" style={{ color: saved ? C.ok : C.dim }}>{saved ? "plan prevents the shutdown" : `tank full at ${clock(shutdown)}`}</span>
    </span>
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

/** Operator-facing cleanup of agent prose: run-scoped incident IDs become "S3 A pump failure", plan refs drop. */
function readable(text: string) {
  return text
    .replace(/\brun-[0-9a-f]+:(pump_failure|pipeline_leak|pump_degradation|facility_shut_in):([A-Za-z0-9_]+):\d+/g, (_m, cat: string, fac: string) =>
      `${facilityTitle(fac)} ${(categoryLabel[cat as keyof typeof categoryLabel] ?? cat).toLowerCase()}`)
    .replace(/\s*\(written by the orchestrator from the facts\)/g, "")
    .replace(/\b(plan|option)\s+P\d+\b/gi, "$1").replace(/\bP\d+\b\s*/g, "");
}

type AgentRunLite = { id: string; status: string; error: string | null; trace?: { outputs?: { handoff?: { handoff: string } | null }; fallbacks?: string[] };
  nodes?: { role: string; status: string; output?: { handoff?: string } | null }[] };
type Lane = { next?: { lane: string; model: string | null } };

/** Nemotron writes the shift handoff for the moment on screen: a run at that time, then the agents. Advice only. */
function Nemotron({ datasetId, tl, at }: { datasetId: string; tl: SimulationTimeline; at: number }) {
  const [phase, setPhase] = useState<"idle" | "run" | "agents" | "done" | "error">("idle");
  const [text, setText] = useState("");
  const [byModel, setByModel] = useState(false);
  const [meta, setMeta] = useState("");
  const [lane, setLane] = useState<Lane["next"] | null>(null);
  const cancel = useRef(false);
  useEffect(() => () => { cancel.current = true; }, []);
  useEffect(() => { void api.api.internal.providers.get().then((r) => setLane(((r.data ?? null) as Lane | null)?.next ?? null)).catch(() => {}); }, [phase]);
  const ask = async () => {
    const t0 = Date.now(), step = tl.stepSeconds;
    const when = Math.min(tl.datasetNowUnix, tl.startUnix + Math.floor((Math.max(at, tl.startUnix) - tl.startUnix) / step) * step);
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      cancel.current = false; setPhase("run"); setText("");
      let run = unwrap(await api.api.runs.post({ datasetId, at: when, runtime: "auto" }, { headers: { "idempotency-key": crypto.randomUUID() } })) as unknown as { id: string; status: string; error?: string | null };
      while (run.status !== "ready" && run.status !== "failed" && run.status !== "cancelled" && !cancel.current) { await wait(700); run = unwrap(await api.api.runs({ id: run.id }).get()) as unknown as typeof run; }
      if (run.status !== "ready") throw new Error(run.error ?? `run ${run.status}`);
      setPhase("agents");
      let a = unwrap(await api.api.runs({ id: run.id }).agents.post()) as unknown as AgentRunLite;
      while (a.status === "running" && !cancel.current) { await wait(1000); a = unwrap(await api.api["agent-runs"]({ id: a.id }).get()) as unknown as AgentRunLite; }
      if (a.status !== "done") throw new Error(a.error ?? `agents ${a.status}`);
      const model = a.trace?.outputs?.handoff?.handoff;
      const fallback = [...(a.nodes ?? [])].reverse().find((n) => n.role === "handoff" && n.output?.handoff)?.output?.handoff;
      setByModel(!!model); setText(readable(model ?? fallback ?? "No handoff came back."));
      setMeta(`${Math.round((Date.now() - t0) / 1000)} s · for ${dayClock(when)}`); setPhase("done");
    } catch (e) { setText(e instanceof Error ? e.message : String(e)); setPhase("error"); }
  };
  const laneName = lane?.lane === "brev" ? "NVIDIA Nemotron (Brev)" : lane?.lane === "openrouter" ? "Nemotron via OpenRouter" : "no model configured";
  return (
    <Panel title="Nemotron's shift handoff" right={<span className="text-[13px]" style={{ color: C.dim }}>{laneName}</span>}>
      <div className="flex flex-wrap items-start gap-4 px-5 pt-3 pb-5">
        <button type="button" onClick={() => void ask()} disabled={phase === "run" || phase === "agents"}
          className="shrink-0 rounded-lg px-4 py-2.5 text-[15px] font-bold disabled:opacity-60" style={{ background: C.chip, color: "#0a0e13" }}>
          {phase === "run" ? "Reading the field…" : phase === "agents" ? "Nemotron is writing…" : `Hand off at ${clock(Math.max(at, tl.startUnix))}`}
        </button>
        <div className="min-w-0 flex-1">
          {phase === "idle" && <p className="text-[16px]" style={{ color: C.dim }}>The chip detects, the planner costs the options, Nemotron explains them in plain English for the next operator. Checked before it is shown; it never dispatches anything.</p>}
          {(phase === "run" || phase === "agents") && <p className="text-[16px]" style={{ color: C.dim }}>{phase === "run" ? "Building the snapshot from the chip's results…" : "Agents are triaging, explaining plans and writing the handoff (about 30 s)…"}</p>}
          {phase === "done" && (
            <>
              <p className="text-[19px] leading-relaxed">{text}</p>
              <p className="mt-1.5 text-[13px]" style={{ color: byModel ? C.chip : C.warn }}>{byModel ? `Written by Nemotron and checked against the facts · ${meta}` : `Written from the facts: Nemotron's draft didn't pass the checks · ${meta}`}</p>
            </>
          )}
          {phase === "error" && <p className="text-[16px]" style={{ color: C.crit }}>Couldn’t get a handoff: {text}</p>}
        </div>
      </div>
    </Panel>
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
