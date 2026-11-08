// Pure ordering and domain helpers for plan takes, failure tracks and the time axis.
import type { FacilityState, Incident, PlanOption, Snapshot, SystemState } from "@/lib/engine/types";
import { incidentsAt, localWindow, projectionEnd as playheadProjectionEnd } from "./derive";
import type { Bounds } from "./arrangement-scale";

const finiteCost = (o: PlanOption) => Number.isFinite(o.cost);

/** Cheapest first; options with a missing cost go last (shown as Unknown); ties keep the input order. */
export function orderTakes(options: readonly PlanOption[]): PlanOption[] {
  return options
    .map((o, i) => ({ o, i }))
    .sort((a, b) => {
      const fa = finiteCost(a.o), fb = finiteCost(b.o);
      if (fa !== fb) return fa ? -1 : 1;
      if (fa && a.o.cost !== b.o.cost) return a.o.cost - b.o.cost;
      return a.i - b.i;
    })
    .map((x) => x.o);
}

/** Options of an incident, cheapest first (falls back to the recommended plan alone). */
export function takesOf(incident: Incident): PlanOption[] {
  if (incident.options && incident.options.length > 0) return orderTakes(incident.options);
  return incident.plan ? [incident.plan] : [];
}

/** Ongoing pump failures in hard rule 7 order (soonest shutdown first, ties to higher lost revenue per hour). */
export function ongoingFailures(snapshot: Snapshot): Incident[] {
  return incidentsAt(snapshot, snapshot.nowUnix).filter((i) => i.category === "pump_failure" && i.status === "ongoing");
}

export interface FacilityEntry { facility: FacilityState; /** index in network order within the system (line colour) */ index: number }

/** Facilities of a system: ongoing failures first in rule 7 order, then the rest in network order. */
export function orderedFacilities(system: SystemState, failures: readonly Incident[]): FacilityEntry[] {
  const entries = system.facilities.map((facility, index) => ({ facility, index }));
  const rank = new Map<string, number>();
  failures.forEach((f, i) => { if (!rank.has(f.facilityId)) rank.set(f.facilityId, i); });
  return entries.sort((a, b) => {
    const ra = rank.get(a.facility.id), rb = rank.get(b.facility.id);
    if (ra != null && rb != null) return ra - rb;
    if (ra != null) return -1;
    if (rb != null) return 1;
    return a.index - b.index;
  });
}

/** Furthest time any plan take projects to (plan start = snapshot.nowUnix), or snapshot.nowUnix when none. */
export function projectionEnd(snapshot: Snapshot, failures: readonly Incident[] = ongoingFailures(snapshot)): number {
  let end = snapshot.nowUnix;
  for (const inc of failures) for (const o of takesOf(inc)) {
    const mins = [...o.levelCurve.map((p) => p.min), ...o.truckArrivalsMin, o.tripAtMin ?? 0].filter(Number.isFinite);
    for (const m of mins) end = Math.max(end, snapshot.nowUnix + m * 60);
  }
  return end;
}

/** Whole axis: dataset start to the later of dataset end and the projected zone. */
export function timeDomain(snapshot: Snapshot): Bounds {
  const win = localWindow(snapshot);
  return {
    start: Math.min(snapshot.dataset.startUnix, win.start),
    // the playhead can run to derive.projectionEnd (repair end, truck return), which can outlast the plan curves
    end: Math.max(snapshot.dataset.nowUnix, snapshot.nowUnix, projectionEnd(snapshot), playheadProjectionEnd(snapshot) ?? 0),
  };
}

export interface Region { start: number; end: number; kind: "notloaded" | "projected" }

/** Parts of the domain with no loaded data: before the window, after it but inside the dataset, and projected. */
export function unloadedRegions(snapshot: Snapshot): Region[] {
  const win = localWindow(snapshot);
  const dom = timeDomain(snapshot);
  const out: Region[] = [];
  if (win.start > dom.start) out.push({ start: dom.start, end: win.start, kind: "notloaded" });
  const datasetEnd = Math.max(snapshot.dataset.nowUnix, win.end);
  if (datasetEnd > win.end) out.push({ start: win.end, end: datasetEnd, kind: "notloaded" });
  if (dom.end > datasetEnd) out.push({ start: datasetEnd, end: dom.end, kind: "projected" });
  return out;
}

/**
 * Takes shown by default under a failure: only the recommended one (cheapest first). `rest` (including "do nothing")
 * sits behind "Show options".
 */
export function splitTakes(takes: readonly PlanOption[]): { shown: { option: PlanOption; index: number }[]; rest: { option: PlanOption; index: number }[] } {
  const all = takes.map((option, index) => ({ option, index }));
  return { shown: all.slice(0, 1), rest: all.slice(1) };
}

/**
 * Facilities worth a row in the compact timeline: an incident (alert or history) overlapping the loaded window, or an
 * ongoing failure. Everything else goes under "N more facilities".
 */
export function incidentFacilityIds(snapshot: Snapshot, window: { start: number; end: number }, failures: readonly Incident[] = ongoingFailures(snapshot)): Set<string> {
  const ids = new Set<string>(failures.map((f) => f.facilityId));
  for (const inc of [...snapshot.alerts, ...snapshot.history]) {
    const end = inc.endUnix ?? snapshot.nowUnix;
    if (inc.onsetUnix <= window.end && end >= window.start) ids.add(inc.facilityId);
  }
  return ids;
}
