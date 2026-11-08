"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import type { DatasetInfo, SimulationTimeline } from "@hackutd/contracts";
import { api, defaultDataset, unwrap } from "@/lib/api";
import { categoryLabel, clock, dayClock, duration, facilityTitle, money } from "@/lib/format";
import { cn } from "@/lib/utils";
import { FieldMap, SPEEDS, useBoardFeed, useSimulation, type BoardFeed } from "@/components/console/simulation";
import { Rearrange } from "@/components/console/rearrange";

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

// Colours are the main console's theme tokens (globals.css), so the wall follows the same light and dark modes.
const C = { line: "var(--line)", dim: "var(--muted)", text: "var(--text)",
  crit: "var(--crit)", warn: "var(--warn)", ok: "var(--ok)", water: "var(--water)", chip: "var(--nv)",
  tint: "var(--raised)", tintSoft: "color-mix(in oklab, var(--text) 3%, transparent)", track: "var(--line)",
  bar: "color-mix(in oklab, var(--text) 22%, transparent)", clock: "rgba(0,0,0,0.8)", segment: "rgba(118,118,128,0.12)", faint: "var(--faint)" };

const THEME_KEY = "bts-theme"; // shared with the console's sun/moon button
const themeListeners = new Set<() => void>();
const readDark = () => document.documentElement.classList.contains("dark");
/** Like the console's toggle: follow the system setting until the operator picks one, and react to any change of the class. */
function subscribeTheme(cb: () => void) {
  themeListeners.add(cb);
  const mq = matchMedia("(prefers-color-scheme: dark)");
  const onSystem = () => {
    let saved: string | null = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch {}
    if (saved !== "light" && saved !== "dark") document.documentElement.classList.toggle("dark", mq.matches);
  };
  const obs = new MutationObserver(cb);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  mq.addEventListener("change", onSystem);
  return () => { themeListeners.delete(cb); obs.disconnect(); mq.removeEventListener("change", onSystem); };
}
/** Same switch as the console: a class on <html>, remembered in this browser. */
function useWallTheme() {
  const dark = useSyncExternalStore(
    subscribeTheme,
    readDark,
    () => false,
  );
  const flip = () => {
    const next = !readDark();
    document.documentElement.classList.toggle("dark", next);
    try { localStorage.setItem(THEME_KEY, next ? "dark" : "light"); } catch {}
    themeListeners.forEach((cb) => cb());
  };
  return { light: !dark, flip };
}

function ThemeButton({ light, flip }: { light: boolean; flip: () => void }) {
  const label = light ? "Switch to dark mode" : "Switch to light mode";
  return (
    <button type="button" onClick={flip} aria-label={label} title={label}
      className="grid size-10 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-black/[0.04] hover:text-text">
      {light ? (
        <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden><path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden><circle cx="8" cy="8" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M3.2 12.8l1.1-1.1M11.7 4.3l1.1-1.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      )}
    </button>
  );
}

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
  const theme = useWallTheme();

  return (
    <div className="min-h-screen" style={{ color: C.text }}>
      <div className="mx-auto flex max-w-[1500px] flex-col gap-4 px-4 py-4 sm:px-6">
        <Header dataset={dataset} feed={feed} at={sim.t} live={live} view={view} setView={setView} theme={theme} />
        {err && <p role="alert" style={{ color: C.crit }}>Can’t reach the operator API: {err}</p>}
        {!sim.tl ? (
          <Panel><p className="px-6 py-10 text-[20px]" style={{ color: C.dim }}>{sim.error ? `Couldn't build the week: ${sim.error}` : dataset ? "Loading the week…" : "No dataset yet: upload one in the full console, or point the API at a data folder."}</p></Panel>
        ) : view === "operator" ? (
          <div key="operator" className="wall-fade flex flex-col gap-4">
            {!live && dataset && <Showcase datasetId={dataset.id} tl={sim.tl} setT={sim.setT} setPlaying={sim.setPlaying} />}
            <Operator story={story(sim.tl, sim.t, live ? feed?.flagged ?? [] : [])} tl={sim.tl} at={sim.t}
              nemotron={live && dataset ? <Nemotron datasetId={dataset.id} tl={sim.tl} at={sim.t} /> : null} />
          </div>
        ) : (
          <div key="hood" className="wall-fade flex flex-col gap-4">
            {/* drag the arc in a panel's corner to put the panels in your own order */}
            <Rearrange storageKey="bts-live-hood-order" className="grid grid-flow-row-dense gap-4 xl:grid-cols-[1fr_1fr]" widgets={[
              { id: "feed", label: "the chip, live", className: "xl:col-span-2", node: <Feed feed={feed} rate={rate} live={sim.liveHere} /> },
              { id: "funnel", label: "what the operator doesn't have to read", className: "xl:col-span-2", node: <Funnel tl={sim.tl} at={sim.t} /> },
              { id: "ledger", label: "every plan so far", node: <Ledger tl={sim.tl} at={sim.t} /> },
              { id: "speed", label: "how fast is the chip", node: <Speed /> },
            ]} />
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
    <section className={cn("glass rounded-2xl", className)}>
      {title && <div className="flex items-baseline justify-between gap-3 px-5 pt-4"><h2 className="text-[13px] font-semibold" style={{ color: C.text }}>{title}</h2>{right}</div>}
      {children}
    </section>
  );
}

function Header({ dataset, feed, at, live, view, setView, theme }: { dataset?: DatasetInfo; feed: BoardFeed | null; at: number; live: boolean; view: "operator" | "hood"; setView: (v: "operator" | "hood") => void; theme: { light: boolean; flip: () => void } }) {
  const fpga = feed?.source === "fpga";
  const on = !!feed?.online;
  return (
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="text-[13px] font-semibold" style={{ color: C.faint }}>Backpressure · Night shift</p>
        <p className="text-[15px]" style={{ color: C.dim }}>{dataset ? dataset.label : "—"}</p>
      </div>
      <div role="tablist" aria-label="View" className="flex rounded-[9px] p-1" style={{ background: C.segment }}>
        {([["operator", "Operator"], ["hood", "Under the hood"]] as const).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={view === k} type="button" onClick={() => setView(k)}
            className="rounded-[7px] px-5 py-2 text-[15px] font-semibold transition-colors" style={view === k ? { background: "var(--panel)", color: C.text, boxShadow: "0 1px 2px rgba(0,0,0,0.12), 0 0 0 0.5px rgba(0,0,0,0.04)" } : { color: C.text }}>{label}</button>
        ))}
      </div>
      <div className="flex items-center gap-4">
        <span className="flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-[14px] font-semibold" style={{ background: "var(--panel)", color: C.text, boxShadow: "0 0 0 0.5px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.06)" }}>
          <span className={cn("size-2.5 rounded-full", on && "animate-pulse")} style={{ background: on ? C.ok : C.faint }} />
          {on ? `${fpga ? "Eclypse Z7 FPGA" : "Software board"} live${feed?.weightsVersion != null ? ` · model v${feed.weightsVersion}` : ""}` : feed?.results ? "Board idle" : "Board not connected"}
        </span>
        {at > 0 && <span className="rounded-md px-4 py-2 font-mono text-[28px] font-normal tabular-nums" style={{ background: C.clock, color: "#fff" }}>{dayClock(at)}{live && <span className="ml-2 align-middle text-[12px] font-sans font-medium" style={{ color: "#34c759" }}>Live</span>}</span>}
        <Link href={dataset ? `/?dataset=${encodeURIComponent(dataset.id)}` : "/"} className="text-[14px] font-medium underline-offset-4 hover:underline" style={{ color: C.water }}>Full console →</Link>
        <ThemeButton light={theme.light} flip={theme.flip} />
      </div>
    </header>
  );
}

function Big({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[13px]" style={{ color: C.dim }}>{label}</p>
      <p className="truncate text-[34px] leading-tight font-bold tabular-nums" style={{ color: tone ?? C.text }}>{value}</p>
      {sub && <p className="text-[12px]" style={{ color: C.faint }}>{sub}</p>}
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
    <Panel title="The chip, live" right={<span className="text-[13px]" style={{ color: C.faint }}>{on ? (live ? "streaming this dataset now" : "streaming") : "waiting for replay.py"}</span>}>
      <div className="grid gap-4 px-5 pt-3 pb-5 lg:grid-cols-[1.1fr_1fr]">
        <div>
          <div className="flex items-center gap-2" aria-label="Data path">
            {hops.map((h, i) => (
              <div key={h} className="flex flex-1 items-center gap-2 last:flex-none">
                <span className="rounded-lg px-3 py-2 text-[15px] font-semibold" style={i === 2 ? { background: "color-mix(in oklab, var(--nv) 16%, transparent)", color: C.text } : { background: "transparent", boxShadow: "0 0 0 0.5px var(--line)", color: C.text }}>{h}</span>
                {i < hops.length - 1 && (
                  <span className="relative h-[3px] flex-1 overflow-hidden rounded-full" style={{ background: C.track }}>
                    {on && [0, 1, 2].map((k) => <span key={k} className="live-dot absolute top-0 h-[3px] w-3 rounded-full" style={{ background: C.water, animationDuration: `${dur}s`, animationDelay: `${(k * dur) / 3}s` }} />)}
                  </span>
                )}
              </div>
            ))}
          </div>
          <div className="mt-4 grid grid-cols-3 gap-4">
            <Big label="Decisions from the chip" value={(feed?.results ?? 0).toLocaleString()} sub={feed?.stats ? `board counters: ${feed.stats.recordsIn.toLocaleString()} in · ${feed.stats.resultsOut.toLocaleString()} out` : "results read by listen.py"} />
            <Big label="Live rate" value={on ? `${Math.round(rate).toLocaleString()}/s` : "—"} sub="measured, records per second" />
            <Big label="Lost or bad packets" value={feed?.stats ? String(feed.stats.seqGaps + feed.stats.badPackets) : "—"} tone={!feed?.stats ? undefined : feed.stats.seqGaps + feed.stats.badPackets > 0 ? C.warn : C.ok} sub="from the board's own counters" />
          </div>
        </div>
        <div className="min-w-0">
          <p className="mb-1.5 text-[13px]" style={{ color: C.dim }}>What it just decided</p>
          <ol className="grid gap-1 text-[14px] tabular-nums">
            {(feed?.recent ?? []).slice(0, 6).map((r, i) => {
              const bad = r.active.length > 0;
              return (
                <li key={`${r.facility}${r.tsUnix}${i}`} className="flex items-center justify-between gap-3 rounded-md px-2.5 py-1" style={{ background: bad ? "color-mix(in oklab, var(--crit) 12%, transparent)" : C.tintSoft }}>
                  <span className="truncate"><span className="font-mono tabular-nums" style={{ color: C.faint }}>{clock(r.tsUnix)}</span> · {facilityTitle(r.facility)}</span>
                  <span style={{ color: bad ? C.crit : r.status === "VALID" ? C.ok : C.warn }}>
                    {bad ? r.active.map((a) => (categoryLabel[a as keyof typeof categoryLabel] ?? a)).join(", ") : r.status === "VALID" ? "OK" : r.status}
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

function Operator({ story: st, tl, at, nemotron }: { story: Story; tl: SimulationTimeline; at: number; nemotron: React.ReactNode }) {
  const h = headline(st, at);
  return (
    <>
      <p className="px-1 font-display text-[30px] leading-tight font-bold tracking-display sm:text-[36px]" style={{ color: h.tone }}>{h.text}</p>
      {/* drag the arc in a panel's corner to put the panels in your own order */}
      <Rearrange storageKey="bts-live-operator-order" className="grid grid-flow-row-dense gap-4 xl:grid-cols-[1fr_1.25fr]" widgets={[
        { id: "todo", label: "what to do", node: (
        <Panel title="What to do" right={<span className="text-[13px]" style={{ color: C.faint }}>worst first</span>}>
          <ol className="grid gap-2.5 px-4 pt-3 pb-4">
            {st.items.length === 0 && <li className="rounded-[10px] px-4 py-6 text-[20px]" style={{ background: "color-mix(in oklab, var(--ok) 11%, transparent)", color: C.ok }}>Nothing to do. The chip is watching every facility.</li>}
            {st.items.slice(0, 5).map((i) => {
              const p = st.plan.get(i.id), failure = i.category === "pump_failure", arr = failure ? st.nextArrival(i.id) : undefined;
              return (
                <li key={i.id} className="rounded-[10px] px-4 py-3" style={{ background: failure ? "color-mix(in oklab, var(--crit) 12%, transparent)" : "color-mix(in oklab, var(--warn-fill) 15%, transparent)" }}>
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
        ) },
        { id: "field", label: "the field", node: (
        <Panel title="The field" right={<span className="text-[13px]" style={{ color: C.faint }}><Dot c={C.crit} /> pump down <Dot c="var(--warn-fill)" /> inspect <Dot c={C.water} /> running</span>}>
          <div className="px-2 pb-2"><FieldMap tl={tl} at={at} ongoing={st.ongoing} bare /></div>
        </Panel>
        ) },
        { id: "money", label: "the money", className: "xl:col-span-2", node: (
      <Panel>
        <div className="grid grid-cols-3 gap-4 px-6 py-4">
          <Big label="If nobody had acted" value={money(st.sum("doNothingCost"))} tone={C.crit} />
          <Big label="Our plans cost" value={money(st.sum("cost"))} />
          <Big label="Kept" value={money(st.sum("kept"))} tone={C.ok} />
        </div>
      </Panel>
        ) },
        ...(nemotron ? [{ id: "nemotron", label: "Nemotron's shift handoff", className: "xl:col-span-2", node: nemotron }] : []),
      ]} />
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
    <Panel title="What the operator doesn't have to read" right={<span className="text-[13px]" style={{ color: C.faint }}>so far this week</span>}>
      <div className="grid gap-2 px-5 pt-3 pb-5">
        {rows.map((r) => (
          <div key={r.label} className="grid grid-cols-[150px_1fr] items-center gap-4">
            <span className="text-right font-display text-[26px] font-semibold tracking-display tabular-nums">{r.n.toLocaleString()}</span>
            <div>
              <div className="h-3 rounded-full" style={{ width: `${Math.max(2, (Math.log10(Math.max(1, r.n)) / max) * 100)}%`, background: r.label.startsWith("things") ? C.ok : r.label.startsWith("decisions") ? C.chip : C.bar }} />
              <p className="mt-1 text-[15px]"><span className="font-semibold">{r.label}</span> <span style={{ color: C.faint }}>· {r.sub}</span></p>
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
    <Panel title="Every plan so far" right={<span className="text-[13px]" style={{ color: C.faint }}>planned at each failure</span>}>
      <ol className="max-h-[360px] overflow-y-auto px-5 pt-2 pb-4">
        {!rows.length && <li className="py-4 text-[15px]" style={{ color: C.dim }}>No pump failures yet.</li>}
        {rows.map((p) => (
          <li key={p.incidentId} className="grid grid-cols-[90px_1fr_auto] items-baseline gap-3 border-t py-2 text-[15px] first:border-t-0" style={{ borderColor: "var(--line-soft)" }}>
            <span className="font-mono tabular-nums" style={{ color: C.dim }}>{dayClock(p.plannedUnix)}</span>
            <span><span className="font-semibold">{facilityTitle(p.facilityId)}</span> <span style={{ color: C.dim }}>{plural(p.label)}</span></span>
            <span className="tabular-nums">{p.doNothingCost != null && p.cost != null && p.doNothingCost > p.cost && <s className="mr-2" style={{ color: "color-mix(in oklab, var(--crit) 80%, transparent)" }}>{money(p.doNothingCost)}</s>}<span className="font-semibold" style={{ color: C.ok }}>{p.cost != null ? money(p.cost) : "—"}</span></span>
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
  if (at >= shutdown && !saved) return <span className="shrink-0 rounded-md px-2 py-0.5 text-[15px] font-bold" style={{ background: C.crit, color: "#fff" }}>Shut in since {clock(shutdown)}</span>;
  return (
    <span className="shrink-0 text-right leading-tight">
      <span className={cn("block font-display text-[22px] font-semibold tracking-display tabular-nums", saved && "line-through opacity-60")} style={{ color: C.crit }}>{at < shutdown ? duration((shutdown - at) / 3600) : clock(shutdown)}</span>
      <span className="block text-[12px]" style={{ color: saved ? C.ok : C.dim }}>{saved ? "plan prevents the shutdown" : `tank full at ${clock(shutdown)}`}</span>
    </span>
  );
}

const Dot = ({ c }: { c: string }) => <span className="mx-1 inline-block size-2.5 translate-y-[-1px] rounded-full" style={{ background: c }} />;

function Transport({ tl, t, setT, playing, setPlaying, speed, setSpeed, liveHere, setFollow }: {
  tl: SimulationTimeline; t: number; setT: (t: number) => void; playing: boolean; setPlaying: (p: boolean) => void; speed: number; setSpeed: (s: number) => void; liveHere: boolean; setFollow: (f: boolean) => void;
}) {
  return (
    <div className="glass flex flex-wrap items-center gap-3 rounded-2xl px-4 py-3">
      <button type="button" aria-label={playing ? "Pause the week" : "Play the week"} onClick={() => { if (t >= tl.nowUnix) setT(tl.startUnix); setPlaying(!playing); }}
        className="rounded-md px-5 py-2 text-[16px] font-semibold" style={{ background: C.water, color: "#fff" }}>{playing ? "Pause" : t >= tl.nowUnix ? "Replay the week" : "Play the week"}</button>
      <div className="flex overflow-hidden rounded-md" style={{ boxShadow: "0 0 0 0.5px var(--line)" }}>
        {SPEEDS.map((s, i) => <button key={s.label} type="button" onClick={() => setSpeed(i)} className={cn("px-3 py-2 text-[14px] tabular-nums", i !== speed && "hover:bg-black/5")} style={{ background: i === speed ? "var(--water)" : "transparent", color: i === speed ? "#fff" : undefined }}>{s.label}</button>)}
      </div>
      <input type="range" aria-label="Time" className="min-w-[160px] flex-1" style={{ accentColor: C.water }} min={tl.startUnix} max={tl.nowUnix} step={tl.stepSeconds} value={Math.min(Math.max(t, tl.startUnix), tl.nowUnix)} onChange={(e) => setT(Number(e.target.value))} />
      {liveHere && <button type="button" onClick={() => setFollow(true)} className="rounded-full px-3 py-2 text-[14px] font-medium" style={{ color: C.ok, background: "color-mix(in oklab, var(--ok) 15%, transparent)" }}>Back to live</button>}
    </div>
  );
}

/** A number that counts up to `target` over `ms` once `run` is true. */
function useCountUp(target: number, ms: number, run: boolean) {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (!run) return;
    let raf = 0; const t0 = performance.now();
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      setV(Math.round(target * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms, run]);
  return run ? v : 0;
}

/** The moment with the most pump failures at once (the hard case), 30 minutes in. */
function worstMoment(tl: SimulationTimeline) {
  const f = tl.incidents.filter((i) => i.category === "pump_failure");
  let best = tl.nowUnix, most = 0;
  for (const a of f) {
    const n = f.filter((b) => b.onsetUnix <= a.onsetUnix && (b.endUnix == null || b.endUnix > a.onsetUnix)).length;
    if (n > most) { most = n; best = a.onsetUnix; }
  }
  const at = Math.min(tl.nowUnix, best + 1800);
  return tl.startUnix + Math.floor((at - tl.startUnix) / tl.stepSeconds) * tl.stepSeconds;
}

type ShowNode = { role: string; status: string; incidentId?: string | null };
const ROLE_LINE: Record<string, (inc: string) => string> = {
  orchestrator: () => "Orchestrator: splitting the shift into tasks",
  triage: () => "Triage: ranking every open incident",
  plan_explainer: (inc) => `Weighing the options for ${inc}`,
  evidence_reviewer: (inc) => `Checking the evidence for ${inc}`,
  handoff: () => "Writing the shift handoff",
};

/**
 * The presentation flow, when the board is idle: 1. read the week (the chip's decisions, the incidents), 2. Nemotron
 * plans the hardest moment of the week (each agent step appears as it finishes), 3. the money kept, counted up.
 */
function Showcase({ datasetId, tl, setT, setPlaying }: { datasetId: string; tl: SimulationTimeline; setT: (t: number) => void; setPlaying: (p: boolean) => void }) {
  const [stage, setStage] = useState<"ready" | "reading" | "planning" | "saved" | "error">("ready");
  const [nodes, setNodes] = useState<ShowNode[]>([]);
  const [handoff, setHandoff] = useState<{ text: string; byModel: boolean } | null>(null);
  const [err, setErr] = useState("");
  const facilities = tl.systems.reduce((n, s) => n + s.facilities.length, 0);
  const steps = Math.round((tl.nowUnix - tl.startUnix) / tl.stepSeconds) + 1;
  const failures = tl.incidents.filter((i) => i.category === "pump_failure").length;
  const inspections = tl.incidents.filter((i) => i.category === "pipeline_leak" || i.category === "pump_degradation").length;
  const reading = stage !== "ready";
  const recs = useCountUp(steps * facilities, 1600, reading);
  const incs = useCountUp(tl.incidents.length, 1600, reading);
  const kept = useCountUp(tl.totals.kept, 1800, stage === "saved");
  const when = worstMoment(tl);
  const cancel = useRef(false);
  useEffect(() => () => { cancel.current = true; }, []);
  // While the agents work: the tasks they have at that moment (from the facts), and how long they've been at it.
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (stage !== "planning") return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [stage]);
  const openAt = tl.incidents.filter((i) => i.onsetUnix <= when && (i.endUnix == null || i.endUnix > when));
  const expected: ShowNode[] = [{ role: "triage", status: "running" },
    ...openAt.filter((i) => i.category === "pump_failure").map((i) => ({ role: "plan_explainer", status: "running", incidentId: `run-0:${i.category}:${i.facilityId}:0` })),
    { role: "handoff", status: "running" }];

  const run = async () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    cancel.current = false; setErr(""); setNodes([]); setHandoff(null);
    setPlaying(false); setStage("reading");
    await wait(1900);
    setT(when); setStartedAt(Date.now()); setNow(Date.now()); setStage("planning");
    try {
      let r = unwrap(await api.api.runs.post({ datasetId, at: when, runtime: "auto" }, { headers: { "idempotency-key": crypto.randomUUID() } })) as unknown as { id: string; status: string; error?: string | null };
      while (!["ready", "failed", "cancelled"].includes(r.status) && !cancel.current) { await wait(600); r = unwrap(await api.api.runs({ id: r.id }).get()) as unknown as typeof r; }
      if (r.status !== "ready") throw new Error(r.error ?? `run ${r.status}`);
      let a = unwrap(await api.api.runs({ id: r.id }).agents.post()) as unknown as AgentRunLite;
      while (a.status === "running" && !cancel.current) {
        setNodes((a.nodes ?? []) as ShowNode[]);
        await wait(900);
        a = unwrap(await api.api["agent-runs"]({ id: a.id }).get()) as unknown as AgentRunLite;
      }
      setNodes((a.nodes ?? []) as ShowNode[]);
      if (a.status !== "done") throw new Error(a.error ?? `agents ${a.status}`);
      const model = a.trace?.outputs?.handoff?.handoff;
      const fallback = [...(a.nodes ?? [])].reverse().find((n) => n.role === "handoff" && n.output?.handoff)?.output?.handoff;
      setHandoff({ text: readable(model ?? fallback ?? ""), byModel: !!model });
      await wait(600);
      setStage("saved");
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setStage("error"); }
  };

  const icon = (st: string) => st === "accepted" || st === "done" ? { t: "✓", c: C.ok } : st === "deterministic" ? { t: "✓", c: C.warn } : st === "rejected" || st === "failed" ? { t: "↺", c: C.warn } : { t: "…", c: C.dim };
  const real = nodes.filter((n) => ROLE_LINE[n.role]);
  const shown = (real.length ? real : expected).slice(-7);
  return (
    <Panel className="overflow-hidden">
      <div className="grid gap-6 px-6 py-6 lg:grid-cols-[1fr_1.2fr]">
        <div className="flex flex-col justify-center gap-4">
          {stage === "ready" && (
            <>
              <p className="text-[28px] leading-tight font-bold">One week of the field, in under a minute.</p>
              <p className="text-[17px]" style={{ color: C.dim }}>The chip reads every sensor, Nemotron plans the hardest moment, and we count what acting saved.</p>
              <button type="button" onClick={() => void run()} className="self-start rounded-xl px-7 py-3.5 text-[19px] font-bold" style={{ background: C.chip, color: "#0a0e13" }}>Run the week</button>
            </>
          )}
          {stage !== "ready" && (
            <ol className="grid gap-3 text-[18px]">
              <li className="flex items-baseline gap-3"><Step on={reading} done={stage !== "reading"} n={1} /><span><b className="tabular-nums">{recs.toLocaleString()}</b> decisions from the chip · <b className="tabular-nums">{incs}</b> incidents found</span></li>
              <li className="flex items-baseline gap-3"><Step on={stage !== "reading"} done={stage === "saved"} n={2} /><span>Nemotron plans {dayClock(when)}, the hardest moment of the week</span></li>
              <li className="flex items-baseline gap-3"><Step on={stage === "saved"} done={stage === "saved"} n={3} /><span>What acting saved</span></li>
            </ol>
          )}
          {(stage === "saved" || stage === "error") && <button type="button" onClick={() => void run()} className="self-start rounded-lg px-4 py-2 text-[15px] font-semibold" style={{ boxShadow: `0 0 0 1px ${C.line}` }}>Run it again</button>}
        </div>
        <div className="min-h-[220px] rounded-xl px-5 py-4" style={{ background: "var(--raised)" }}>
          {stage === "ready" && <p className="text-[16px]" style={{ color: C.dim }}>{tl.totals.failures} pump failures and {tl.totals.inspections} inspections this week, on {facilities} facilities.</p>}
          {stage === "reading" && <p className="animate-pulse text-[18px]" style={{ color: C.dim }}>Reading the week…</p>}
          {stage === "planning" && (
            <>
              <p className="mb-2 flex items-center gap-2 text-[14px] font-semibold tracking-[0.1em] uppercase" style={{ color: C.chip }}>
                <span className="size-2 animate-pulse rounded-full" style={{ background: C.chip }} />Nemotron agents at work
                <span className="ml-auto font-mono tabular-nums normal-case" style={{ color: C.dim }}>{Math.max(0, Math.round((now - startedAt) / 1000))} s</span>
              </p>
              <p className="mb-2 text-[14px]" style={{ color: C.dim }}>{openAt.length} open incidents at {dayClock(when)}. Every answer is checked against the facts before it is shown.</p>
              <ol className="grid gap-1.5 text-[16px]">
                {shown.map((n, k) => { const ic = icon(n.status); return (
                  <li key={k} className="wall-fade flex items-baseline gap-2.5"><span className={cn("w-4 font-bold", ic.t === "…" && "animate-pulse")} style={{ color: ic.c }}>{ic.t}</span><span>{ROLE_LINE[n.role]!(readable(n.incidentId ?? ""))}</span></li>
                ); })}
              </ol>
            </>
          )}
          {stage === "saved" && (
            <div className="wall-fade">
              <p className="text-[14px] font-semibold tracking-[0.1em] uppercase" style={{ color: C.dim }}>Kept this week</p>
              <p className="text-[64px] leading-none font-bold tabular-nums" style={{ color: C.ok }}>{money(kept)}</p>
              <p className="mt-2 text-[16px]" style={{ color: C.dim }}>If nobody acted: <b style={{ color: C.crit }}>{money(tl.totals.doNothing)}</b> · our plans: <b style={{ color: C.text }}>{money(tl.totals.plan)}</b> · {failures} pump failures, {inspections} inspections</p>
              {handoff?.text && (
                <div className="mt-4 rounded-lg px-4 py-3" style={{ background: "rgba(118,185,0,0.08)", boxShadow: `inset 3px 0 0 ${C.chip}` }}>
                  <p className="text-[16px] leading-relaxed">{handoff.text}</p>
                  <p className="mt-1 text-[12.5px]" style={{ color: handoff.byModel ? C.chip : C.warn }}>{handoff.byModel ? "Nemotron’s handoff, checked against the facts" : "Written from the facts: Nemotron’s draft didn’t pass the checks"}</p>
                </div>
              )}
            </div>
          )}
          {stage === "error" && <p className="text-[16px]" style={{ color: C.crit }}>Couldn’t finish: {err}</p>}
        </div>
      </div>
    </Panel>
  );
}

function Step({ on, done, n }: { on: boolean; done: boolean; n: number }) {
  return <span className="grid size-7 shrink-0 place-items-center rounded-full text-[14px] font-bold" style={{ background: done ? C.ok : on ? C.chip : "var(--raised)", color: done ? "#fff" : on ? "#0a0e13" : C.dim }}>{done ? "✓" : n}</span>;
}

/** Operator-facing cleanup of agent prose: run-scoped incident IDs become "S3 A pump failure", plan refs drop. */
function readable(text: string) {
  const id = /\brun-[0-9a-f]+:(pump_failure|pipeline_leak|pump_degradation|facility_shut_in):([A-Za-z0-9_]+):\d+(?::evidence:\d+)?/g;
  return text
    // "Evidence ID: run-...:evidence:0." citations belong in the ID fields: drop them from the prose
    .replace(/\s*\(?Evidence(?: IDs?)?:\s*(?:run-[0-9a-f]+:[A-Za-z_]+:[A-Za-z0-9_]+:\d+(?::evidence:\d+)?[\s,;]*)+\)?\.?/gi, " ")
    .replace(id, (_m, cat: string, fac: string) => `${facilityTitle(fac)} ${(categoryLabel[cat as keyof typeof categoryLabel] ?? cat).toLowerCase()}`)
    .replace(/\s*\(written by the orchestrator from the facts\)/g, "")
    // plan refs: "P2 (do nothing)" -> "doing nothing", "Plan P1 (1 truck, 1 trip)" -> "1 truck, 1 trip"
    .replace(/\b(?:plan|option)?\s*P\d+\s*\((?:do nothing)\)/gi, " doing nothing").replace(/\b(?:plan|option)\s+P\d+\s*\(([^)]*)\)/gi, "$1")
    .replace(/\bP\d+\s*\(([^)]*)\)/g, "$1").replace(/\b(plan|option)\s+P\d+\b/gi, "$1").replace(/\bP\d+\b\s*/g, "")
    .replace(/\(\s*1 truck\(s\), 1 trip\(s\)\s*\)/g, "1 truck, 1 trip").replace(/(\d+) (\w+)\(s\)/g, (_m, k: string, w: string) => `${k} ${w}${k === "1" ? "" : "s"}`)
    .replace(/doing nothing recommended over doing nothing/gi, "No truck can help in time; it waits for the repair")
    .replace(/\s+([.,;])/g, "$1").replace(/([.;])(?=[A-Z])/g, "$1 ").replace(/\s{2,}/g, " ").trim();
}

type AgentRunLite = { id: string; status: string; error: string | null; trace?: { outputs?: { handoff?: { handoff: string } | null }; fallbacks?: string[] };
  nodes?: { role: string; status: string; incidentId?: string | null; output?: { handoff?: string } | null }[] };
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
    <Panel title="Nemotron's shift handoff" right={<span className="text-[13px]" style={{ color: C.faint }}>{laneName}</span>}>
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
              <p className="mt-1.5 text-[13px]" style={{ color: byModel ? C.dim : C.warn }}>{byModel ? `Written by Nemotron and checked against the facts · ${meta}` : `Written from the facts: Nemotron's draft didn't pass the checks · ${meta}`}</p>
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
    { label: "Nemotron writes the shift handoff", s: NEMOTRON_S, note: `${NEMOTRON_S} s · measured`, c: "var(--warn-fill)" },
    { label: "The sensors report again", s: 300, note: "every 5 min", c: C.dim },
  ];
  const lo = Math.log10(1e-7), hi = Math.log10(600);
  return (
    <Panel title="How fast is the chip?" right={<span className="text-[13px]" style={{ color: C.faint }}>log scale</span>}>
      <div className="grid gap-2.5 px-5 pt-3 pb-4">
        {rows.map((r) => (
          <div key={r.label} className="grid grid-cols-[minmax(0,260px)_1fr] items-center gap-3 sm:grid-cols-[300px_1fr]">
            <span className="text-[15px]">{r.label}</span>
            <div className="flex items-center gap-3">
              <span className="h-3.5 rounded-full" style={{ width: `${Math.max(1.5, ((Math.log10(r.s) - lo) / (hi - lo)) * 100)}%`, background: r.c }} />
              <span className="shrink-0 text-[13px] tabular-nums" style={{ color: C.faint }}>{r.note}</span>
            </div>
          </div>
        ))}
        <p className="pt-1 text-[16px] font-semibold">
          The chip answers about <span>{Math.round(WIRE_US_PER_RECORD / CHIP_US_PER_RECORD)}×</span> faster than the network can carry the question, and about{" "}
          <span>a billion times</span> faster than the sensors report.
        </p>
      </div>
    </Panel>
  );
}
