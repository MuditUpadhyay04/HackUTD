// Pure logic for the overview panel (docs/ui-v4-balance.md, "Overview panel content"). No React, no I/O.
// Everything is evaluated at snapshot.nowUnix (the latest reading), never at the playhead.
// Unknown stays null and is never summed as 0 (hard rule 9). No middle dots or em dashes in any string.
import type { FacilityState, Incident, Snapshot, SystemState } from "@/lib/engine/types";
import { clockFrom, systemNum } from "@/lib/format";
import { countdownAt, incidentsAt, systemStatusAt, type FacilityStatus } from "./derive";

const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
const count = (n: number) => WORDS[n] ?? String(n);
const lower = (s: string) => s.toLowerCase();

const longDay = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

/** "Saturday, October 10, 15:30 UTC" (nearest minute, like every clock in the app). */
export function readingStamp(unix: number): string {
  const d = new Date(Math.round(unix / 60) * 60 * 1000);
  return `${longDay.format(d)}, ${timeFmt.format(d)} UTC`;
}

/** Dataset labels may carry a middle dot ("Snapshot · Thu Oct 8, 12:00"); the UI never shows one. */
export function datasetLabel(label: string | undefined): string {
  return (label ?? "").replace(/\s*[·•—–]\s*/g, ", ").trim();
}

export const pumpFailures = (incidents: Incident[]) => incidents.filter((i) => i.category === "pump_failure");
/** Leaks and worn pumps: what an inspector is sent for. */
export const inspections = (incidents: Incident[]) => incidents.filter((i) => i.category === "pipeline_leak" || i.category === "pump_degradation");

/** Ongoing incidents at the latest reading, in hard rule 7 order (failures by soonest shutdown first, then the rest). */
export function latestIncidents(snapshot: Snapshot): Incident[] {
  return incidentsAt(snapshot, snapshot.nowUnix);
}

/**
 * Facilities with real data trouble: a key reading is HELD, INVALID or DROPPED, or health says no_data.
 * Health "unknown" alone is NOT missing data: it only means the classifier has not confirmed a state.
 */
export function missingFacilities(snapshot: Snapshot): FacilityState[] {
  return snapshot.systems.flatMap((s) => s.facilities).filter((f) => f.dataQuality.quality !== "VALID" || f.health === "no_data");
}

/**
 * True when leak and wear classification is not producing output: no facility has a confirmed "ok" health, nothing
 * was classified as a leak or worn pump, no board facility carries model scores, and at least one facility is stuck
 * on health "unknown" (the engine's value for "no failure, classifier has not said ok"). Never implies "no leaks".
 */
export function detectionUnavailable(snapshot: Snapshot): boolean {
  const facilities = snapshot.systems.flatMap((s) => s.facilities);
  if (facilities.some((f) => f.health === "ok" || f.health === "leak" || f.health === "degradation")) return false;
  if (snapshot.alerts.some((a) => a.category === "pipeline_leak" || a.category === "pump_degradation")) return false;
  if (snapshot.board?.facilities.some((f) => f.scores != null)) return false;
  return facilities.some((f) => f.health === "unknown");
}

export const DETECTION_NOTE = "Leak and wear checks are off: no model is loaded. Pump failures are still detected from the readings.";

/**
 * Classic's headline, fixed: "no recent readings" counts only facilities with a real data-quality problem.
 * The inspector clause is dropped when detection is unavailable (we cannot say how many problems need one).
 */
export function overviewHeadline(snapshot: Snapshot): string {
  const incidents = latestIncidents(snapshot);
  const failures = pumpFailures(incidents);
  const inspect = inspections(incidents);
  const missing = missingFacilities(snapshot);
  const systems = [...new Set(failures.map((a) => a.systemId))];
  let text: string;
  if (failures.length === 0) text = missing.length ? "No pumps are reported down." : "Every pump is running.";
  else if (systems.length === 1) {
    const fleet = snapshot.systems.find((s) => s.id === systems[0])?.fleetSize ?? 0;
    const clause = fleet === 0 ? "have no emergency trucks" : `share ${fleet === 1 ? "one truck" : `${lower(count(fleet))} trucks`}`;
    text = failures.length === 1
      ? `One pump in System ${systemNum(systems[0])} is down.`
      : `${count(failures.length)} pumps in System ${systemNum(systems[0])} are down and ${clause}.`;
  } else text = `${count(failures.length)} pumps are down across ${lower(count(systems.length))} systems.`;
  if (missing.length) text += ` ${count(missing.length)} ${missing.length === 1 ? "facility has" : "facilities have"} no recent readings.`;
  if (inspect.length) text += ` ${count(inspect.length)} ${inspect.length === 1 ? "problem needs" : "problems need"} an inspector.`;
  return text;
}

/** Sum that stays unknown (null) when any term is unknown, never $0. An empty list sums to a known 0. */
export function sumOrNull(values: (number | null | undefined)[]): number | null {
  let total = 0;
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) return null;
    total += v;
  }
  return total;
}

export type FirstShutdown = { kind: "clock"; unix: number } | { kind: "none" } | { kind: "shut" } | { kind: "unknown" };

export interface OverviewStats {
  pumpsDown: number;
  firstShutdown: FirstShutdown;
  /** null = Unknown. */
  planCost: number | null;
  ifNobodyActs: number | null;
}

export function pumpCountdown(incident: Incident, snapshot: Snapshot): PumpCountdown {
  const now = snapshot.nowUnix;
  const c = countdownAt(incident, snapshot, now);
  if (c.kind === "shut") return { kind: "shut_in" };
  if (c.kind === "not_filling") return { kind: "not_filling" };
  if (c.kind === "counting" && c.remainingHours && c.shutdownUnix) {
    const at = c.shutdownUnix.p50;
    if (incident.repairEndsUnix && at >= incident.repairEndsUnix) return { kind: "repair_first", repairAt: incident.repairEndsUnix };
    return { kind: "counting", hours: c.remainingHours.p50, at, p10At: c.shutdownUnix.p10, p90At: c.shutdownUnix.p90 };
  }
  return { kind: "unknown" };
}

export type PumpCountdown =
  | { kind: "counting"; hours: number; at: number; p10At: number; p90At: number }
  | { kind: "repair_first"; repairAt: number }
  | { kind: "shut_in" }
  | { kind: "not_filling" }
  | { kind: "unknown" };

const doNothing = (i: Incident) => i.options?.find((o) => o.kind === "do_nothing");

export function overviewStats(snapshot: Snapshot): OverviewStats {
  const failures = pumpFailures(latestIncidents(snapshot));
  const states = failures.map((a) => pumpCountdown(a, snapshot));
  const etas = states.flatMap((c) => (c.kind === "counting" ? [c.at] : []));
  let firstShutdown: FirstShutdown;
  if (failures.length === 0) firstShutdown = { kind: "none" };
  else if (etas.length) firstShutdown = { kind: "clock", unix: Math.min(...etas) };
  else if (states.every((c) => c.kind === "shut_in")) firstShutdown = { kind: "shut" };
  else if (states.every((c) => c.kind === "not_filling" || c.kind === "repair_first" || c.kind === "shut_in")) firstShutdown = { kind: "none" };
  else firstShutdown = { kind: "unknown" };
  return {
    pumpsDown: failures.length,
    firstShutdown,
    planCost: sumOrNull(failures.map((a) => a.plan?.cost)),
    ifNobodyActs: sumOrNull(failures.map((a) => doNothing(a)?.cost)),
  };
}

/** Savings of the recommended plan over doing nothing, or null when either side is unknown or it saves nothing. */
export function savings(incident: Incident): number | null {
  const idle = doNothing(incident)?.cost;
  const plan = incident.plan?.cost;
  if (idle == null || plan == null) return null;
  return idle - plan > 0 ? idle - plan : null;
}

export type SystemTone = "ok" | "red" | "magenta" | "nodata";
export interface SystemRow {
  id: string;
  /** "System 5" */
  name: string;
  status: FacilityStatus;
  word: string;
  tone: SystemTone;
  facilities: number;
  trucksFree: number;
  fleetSize: number;
}

const STATUS_WORD: Record<FacilityStatus, { word: string; tone: SystemTone }> = {
  shut: { word: "Shut in", tone: "red" },
  down: { word: "Pump down", tone: "red" },
  leak: { word: "Leak", tone: "magenta" },
  worn: { word: "Worn pump", tone: "magenta" },
  nodata: { word: "No data", tone: "nodata" },
  idle: { word: "Running", tone: "ok" },
  flowing: { word: "Running", tone: "ok" },
};

export function trucksFreeAt(system: SystemState, snapshot: Snapshot, t: number): number {
  const fleet = snapshot.fleets.find((f) => f.systemId === system.id);
  const busy = new Set((fleet?.assignments ?? []).filter((a) => t >= a.fromUnix && t <= a.toUnix).map((a) => a.truck)).size;
  return Math.max(0, system.fleetSize - busy);
}

export function systemRows(snapshot: Snapshot): SystemRow[] {
  return snapshot.systems.map((s) => {
    const status = systemStatusAt(snapshot, s, snapshot.nowUnix);
    return {
      id: s.id, name: `System ${systemNum(s.id)}`, status, ...STATUS_WORD[status],
      facilities: s.facilities.length, trucksFree: trucksFreeAt(s, snapshot, snapshot.nowUnix), fleetSize: s.fleetSize,
    };
  });
}

/** "Pump down since 14:00" (weekday added when it began on another day). */
export function downSince(incident: Incident, nowUnix: number): string {
  return `Pump down since ${clockFrom(incident.onsetUnix, nowUnix)}`;
}
