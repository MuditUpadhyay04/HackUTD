import type { Incident, Snapshot } from "@hackutd/contracts";
import type { Grounding } from "../prose";

/**
 * Scoped, display-ready facts for the orchestrated sub-agents. Everything is derived deterministically from the run
 * snapshot (runtime inputs only, "now" from telemetry) and optional board results; nothing reads the answer key.
 */
export interface PlanFact { planId: string; label: string; kind: string; costUsd: number; trucks: number; shutIns: number; tankTrips: boolean; recommended: boolean }
export interface IncidentFact {
  incidentId: string; category: string; categoryLabel: string; status: string; systemId: string; facilityId: string; facilityLabel: string; assetId: string;
  age: string; countdown: string; hoursToLimit: number | null; levelPct: number | null; lostRevenuePerHour: number | null;
  confidence: number | null; dataQuality: string | null; planningStatus: string | null;
  evidence: { id: string; text: string }[]; plans: PlanFact[];
}
export interface BoardFact { facilityId: string; status: string; heads: string[]; rules: string[]; countdown: string | null; tsUnix: number; source: "fakeboard" | "fpga" | "unverified" }
export interface RunFacts {
  runId: string; revision: number; nowUnix: number; now: string; scoresAvailable: boolean; coverageComplete: boolean;
  recommendationReady: boolean; incidents: IncidentFact[]; board: BoardFact[];
}

const CATEGORY_LABEL: Record<string, string> = { pump_failure: "pump failure", pipeline_leak: "pipeline leak", pump_degradation: "worn pump", facility_shut_in: "shut-in" };

export function duration(hours: number): string {
  const minutes = Math.max(0, Math.round(hours * 60));
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return h ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`;
}
export function clock(unix: number): string {
  const d = new Date(unix * 1000);
  return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()]} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}
/** S4_FACILITY_C -> S4 C (the console's short name). */
export function facilityLabel(id: string): string {
  const m = /^(S\d+)_FACILITY_([A-Z])$/.exec(id);
  return m ? `${m[1]} ${m[2]}` : id;
}

function countdown(i: Incident): { text: string; hours: number | null } {
  if (i.category !== "pump_failure") return { text: "not applicable", hours: null };
  const c = i.countdown;
  if (!c) return { text: "unavailable", hours: null };
  if (c.status === "available" && c.hours) return { text: duration(c.hours.p50), hours: Math.round(c.hours.p50 * 10) / 10 };
  return { text: c.status.replaceAll("_", " "), hours: c.status === "at_limit" ? 0 : null };
}

export function runFacts(snapshot: Snapshot, board: BoardFact[] = []): RunFacts {
  const fresh = snapshot.recommendation.state === "ready" && snapshot.recommendation.inputRevision === snapshot.revision;
  const incident = (i: Incident): IncidentFact => {
    const cd = countdown(i);
    const options = [i.plan, ...(i.options ?? [])].filter((p): p is NonNullable<typeof p> => !!p && fresh && p.inputRevision === snapshot.revision);
    const seen = new Set<string>();
    const plans = options.filter((p) => !seen.has(p.id) && seen.add(p.id)).map((p) => ({ planId: p.id, label: p.label, kind: p.kind, costUsd: Math.round(p.cost), trucks: p.trucks,
      shutIns: p.shutIns.length, tankTrips: p.tankTrips, recommended: p.id === i.plan?.id }));
    return { incidentId: i.id, category: i.category, categoryLabel: CATEGORY_LABEL[i.category] ?? i.category, status: i.status, systemId: i.systemId, facilityId: i.facilityId,
      facilityLabel: facilityLabel(i.facilityId), assetId: i.assetId, age: duration((snapshot.nowUnix - i.onsetUnix) / 3600), countdown: cd.text, hoursToLimit: cd.hours,
      levelPct: i.levelPct ?? null, lostRevenuePerHour: i.lostRevenuePerHour ?? null, confidence: i.confidence, dataQuality: i.dataQuality?.quality ?? null,
      planningStatus: i.planningStatus ?? null, evidence: i.evidence.map((text, n) => ({ id: `${i.id}:evidence:${n}`, text: text.slice(0, 500) })), plans };
  };
  return { runId: snapshot.runId, revision: snapshot.revision, nowUnix: snapshot.nowUnix, now: clock(snapshot.nowUnix), scoresAvailable: snapshot.runtime?.scoresAvailable ?? false,
    coverageComplete: snapshot.coverage?.complete ?? false, recommendationReady: fresh,
    incidents: [...(snapshot.alerts ?? []), ...(snapshot.history ?? [])].map(incident),
    board: board.filter((b) => b.tsUnix <= snapshot.nowUnix) };
}

/** Rule 7: pump failures first, soonest shutdown first, ties to higher lost revenue per hour; then the rest. */
export function priorityOrder(facts: RunFacts): string[] {
  const ongoing = facts.incidents.filter((i) => i.status === "ongoing");
  const pumps = ongoing.filter((i) => i.category === "pump_failure").sort((a, b) =>
    (a.hoursToLimit ?? Infinity) - (b.hoursToLimit ?? Infinity) || (b.lostRevenuePerHour ?? 0) - (a.lostRevenuePerHour ?? 0) || a.incidentId.localeCompare(b.incidentId));
  const rest = ongoing.filter((i) => i.category !== "pump_failure").sort((a, b) => a.incidentId.localeCompare(b.incidentId));
  return [...pumps, ...rest].map((i) => i.incidentId);
}

export function groundingForRun(facts: RunFacts, data: unknown = facts): Grounding {
  return {
    entities: facts.incidents.flatMap((i) => [i.incidentId, i.systemId, i.facilityId, i.assetId, ...i.plans.map((p) => p.planId), ...i.evidence.map((e) => e.id)]),
    labels: facts.incidents.flatMap((i) => [i.category, i.status, i.planningStatus ?? "", ...i.plans.map((p) => p.kind)]),
    categories: facts.incidents.map((i) => i.category),
    data,
  };
}

/** Latest board result per facility at or before the run cutoff (C11 JSON lines from listen.py). */
export function boardFacts(lines: unknown[], source: BoardFact["source"] = "unverified"): BoardFact[] {
  const latest = new Map<string, BoardFact>();
  for (const line of lines) {
    const r = line as { type?: string; facility?: string; ts_unix?: number; status?: string; active?: unknown[]; above_threshold?: unknown[]; rules?: unknown[]; countdown_min?: { p50?: number } };
    if (r?.type !== "result" || typeof r.facility !== "string" || typeof r.ts_unix !== "number") continue;
    const prev = latest.get(r.facility);
    if (!prev || prev.tsUnix <= r.ts_unix) latest.set(r.facility, { facilityId: r.facility, status: String(r.status ?? "UNKNOWN"), heads: [...(r.active ?? r.above_threshold ?? [])].map(String),
      rules: [...(r.rules ?? [])].map(String), countdown: typeof r.countdown_min?.p50 === "number" ? duration(r.countdown_min.p50 / 60) : null, tsUnix: r.ts_unix, source });
  }
  return [...latest.values()].sort((a, b) => a.facilityId.localeCompare(b.facilityId));
}
