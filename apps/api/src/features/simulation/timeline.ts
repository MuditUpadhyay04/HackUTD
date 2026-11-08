import { statSync } from "node:fs";
import type { ImportedDataset, Incident, SimulationTimeline, Snapshot } from "@hackutd/contracts";
import { buildRunSnapshot, type BoardIndex } from "../runtimes/service";
import type { RegisteredModel } from "../runtimes/model";

/** The series the view draws is capped at this many points (a week of 5-minute steps is 2,016). */
const MAX_POINTS = 2016;

/**
 * One pass over a dataset for the Simulation view. Uses buildRunSnapshot exactly as a run does, so incidents, plans
 * and detections are the ones the console shows elsewhere: one snapshot at "now" for every incident, and one at each
 * pump failure's onset for the plan made then. Nothing here talks to the board or writes anything.
 */
export async function buildTimeline(dataset: ImportedDataset, options: { board?: BoardIndex; model?: RegisteredModel; signal?: AbortSignal } = {}): Promise<SimulationTimeline> {
  const t0 = performance.now();
  // While the board is part-way through this dataset, its flags past the last result are frozen (a missing board
  // record freezes every streak), so the story ends where the board's results end: "so far", never a guess.
  const facilityIds = dataset.network.systems.flatMap((s) => s.facilities.map((f) => f.id));
  const ours = new Set(facilityIds);
  const boardKeys = options.board ? [...options.board.values()].filter((r) => ours.has(r.facilityId) && r.tsUnix >= dataset.info.startUnix && r.tsUnix <= dataset.info.nowUnix) : [];
  const boardLastUnix = boardKeys.length ? boardKeys.reduce((m, r) => Math.max(m, r.tsUnix), 0) : null;
  const until = boardLastUnix != null ? Math.min(dataset.info.nowUnix, boardLastUnix) : dataset.info.nowUnix;
  const snap = (at: number) => buildRunSnapshot(dataset, { runId: "simulation", at, runtime: "software" }, { board: options.board, model: options.model, signal: options.signal });
  const end = await snap(until);
  const incidents = [...end.history, ...end.alerts].sort((a, b) => a.onsetUnix - b.onsetUnix || a.facilityId.localeCompare(b.facilityId));

  // A plan per pump failure, made at its onset. Failures that start together share one snapshot (and one fleet plan).
  const failures = incidents.filter((i) => i.category === "pump_failure");
  const atOnset = new Map<number, Snapshot>();
  for (const at of [...new Set(failures.map((i) => i.onsetUnix))]) atOnset.set(at, await snap(at));
  const plans: SimulationTimeline["plans"] = [];
  const trucks = new Map<string, SimulationTimeline["trucks"][number]>();
  for (const f of failures) {
    const s = atOnset.get(f.onsetUnix)!;
    const live = s.alerts.find((a) => a.category === "pump_failure" && a.facilityId === f.facilityId);
    const p = live?.plan, dn = live?.options?.find((o) => o.kind === "do_nothing");
    const cost = p ? Math.round(p.cost) : null, doNothingCost = dn ? Math.round(dn.cost) : null;
    plans.push({ incidentId: f.id, facilityId: f.facilityId, systemId: f.systemId, plannedUnix: f.onsetUnix, kind: p?.kind ?? "unavailable",
      label: p?.label ?? (live?.planningStatus === "insufficient_data" ? "Not enough data to plan" : "No plan"),
      cost, doNothingCost, kept: cost != null && doNothingCost != null ? Math.max(0, doNothingCost - cost) : null, trucks: p?.trucks ?? 0,
      shutIns: (p?.shutIns ?? []).map((w) => ({ wellId: w.wellId, atUnix: f.onsetUnix + w.startAfterMin * 60 })) });
    // The operator follows each plan when it is made: a failure keeps the trucks the plan at its own onset gave it.
    // (Later re-plans propose departures from their own "now"; they decide only the failures that start then.)
    // The planner at each onset assumes every truck is in the yard (nothing records earlier dispatches), so book in
    // onset order and move a job to a truck of the same system that is free then; a truck is never in two places.
    const fleetSize = dataset.ops.systems[f.systemId]?.emergency_fleet_size ?? 0;
    for (const a of s.fleets.find((x) => x.systemId === f.systemId)?.assignments ?? []) {
      if (a.incidentId !== f.id) continue;
      const busy = (n: number) => [...trucks.values()].some((t) => t.systemId === f.systemId && t.truck === n && t.fromUnix < a.toUnix && a.fromUnix < t.toUnix);
      const truck = !busy(a.truck) ? a.truck : Array.from({ length: fleetSize }, (_, k) => k + 1).find((n) => !busy(n)) ?? a.truck;
      trucks.set(`${f.id}#${truck}`, { systemId: f.systemId, truck, incidentId: f.id, facilityId: a.facilityId, fromUnix: a.fromUnix, toUnix: a.toUnix, arrivalsUnix: [...a.tripsArrivalUnix] });
    }
  }
  const truckList = [...trucks.values()].sort((a, b) => a.fromUnix - b.fromUnix || a.systemId.localeCompare(b.systemId) || a.truck - b.truck);

  // Tank levels, decimated to MAX_POINTS.
  const steps = Math.round((dataset.info.nowUnix - dataset.info.startUnix) / 300) + 1;
  const stride = Math.max(1, Math.ceil(steps / MAX_POINTS));
  const levels: Record<string, (number | null)[]> = {};
  for (const id of facilityIds) levels[id] = new Array(Math.ceil(steps / stride)).fill(null);
  for (const fr of dataset.frames) {
    const k = (fr.tsUnix - dataset.info.startUnix) / 300;
    if (k % stride === 0 && fr.levelPct != null && Number.isFinite(fr.levelPct)) levels[fr.facilityId]![k / stride] = Math.round(fr.levelPct * 10) / 10;
  }

  const reason = end.runtime.reasons.find((r) => r.startsWith("Detections from "));
  const fromBoard = !!reason;
  const plannedCosts = plans.filter((p) => p.cost != null && p.doNothingCost != null);
  return {
    datasetId: dataset.info.id, startUnix: dataset.info.startUnix, nowUnix: until, datasetNowUnix: dataset.info.nowUnix, stepSeconds: 300,
    detections: { from: fromBoard ? "board" : "software", provenance: boardKeys.some((r) => r.source === "fpga") || incidents.some((i) => i.provenance === "fpga") ? "fpga" : "software",
      label: fromBoard ? reason!.slice("Detections from ".length).replace(/;.*$/, "") : "the console's software runtime (pump failures only without board results)",
      boardResults: boardKeys.length, boardLastUnix },
    systems: dataset.network.systems.map((s) => ({ id: s.id, center: s.center, truckYard: s.truck_yard, disposal: { lat: s.disposal_site.lat, lon: s.disposal_site.lon },
      fleetSize: dataset.ops.systems[s.id]?.emergency_fleet_size ?? 0,
      facilities: s.facilities.map((f) => ({ id: f.id, lat: f.lat, lon: f.lon, capacityBbl: f.tank.capacity_bbl, wells: f.wells.length })) })),
    seriesStepSeconds: 300 * stride, levels,
    incidents: incidents.map((i: Incident) => ({ id: i.id, category: i.category, systemId: i.systemId, facilityId: i.facilityId, onsetUnix: i.onsetUnix, endUnix: i.endUnix, provenance: i.provenance })),
    plans, trucks: truckList,
    totals: { doNothing: plannedCosts.reduce((t, p) => t + p.doNothingCost!, 0), plan: plannedCosts.reduce((t, p) => t + p.cost!, 0),
      kept: plannedCosts.reduce((t, p) => t + p.kept!, 0), failures: failures.length,
      inspections: incidents.filter((i) => i.category === "pipeline_leak" || i.category === "pump_degradation").length },
    builtAt: new Date().toISOString(), buildMs: Math.round(performance.now() - t0),
  };
}

/** File stamp of the board results (size:mtime), so a timeline is rebuilt when listen.py has written more. */
export function boardStamp(path: string | undefined): string {
  if (!path) return "none";
  try { const s = statSync(path); return `${s.size}:${s.mtimeMs}`; } catch { return "missing"; }
}

/**
 * Timelines per dataset: concurrent requests share one build; while the board streams (its file changes every second)
 * a timeline is reused for `minAgeMs` before a rebuild, and the previous one is served while the next builds. At most
 * `max` datasets are kept.
 */
export class TimelineCache {
  private entries = new Map<string, { stamp: string; builtAt: number; value?: SimulationTimeline; pending?: Promise<SimulationTimeline> }>();
  constructor(private readonly max = 6, private readonly minAgeMs = 20_000) {}
  async get(datasetId: string, stamp: string, build: () => Promise<SimulationTimeline>): Promise<SimulationTimeline> {
    const e = this.entries.get(datasetId);
    if (e?.value && (e.stamp === stamp || Date.now() - e.builtAt < this.minAgeMs)) return e.value;
    if (e?.pending) return e.value ?? e.pending;
    const pending = build().then((value) => {
      this.entries.set(datasetId, { stamp, builtAt: Date.now(), value });
      return value;
    }).catch((err) => {
      const cur = this.entries.get(datasetId);
      if (cur?.value) this.entries.set(datasetId, { ...cur, pending: undefined }); else this.entries.delete(datasetId);
      throw err;
    });
    this.entries.set(datasetId, { stamp: e?.stamp ?? stamp, builtAt: e?.builtAt ?? 0, value: e?.value, pending });
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
    return e?.value ?? pending;
  }
}
