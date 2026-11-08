import type { ImportedDataset, Snapshot } from "@hackutd/contracts";
import { randomUUID } from "node:crypto";
import { snapshotAt } from "../orchestration/cases";
import { runFacts } from "../orchestration/facts";
import type { AgentRunTrace, TaskNode } from "../orchestration/orchestrator";
import type { ExplainerOutput } from "../orchestration/roles";
import type { DecisionRecord, Outcome } from "./store";

/**
 * One decision per ongoing pump failure with validated plans: the solver's recommendation (which decides), the
 * agent's suggested first option (advice), and the approval if any. In the simulation the approval is labeled
 * "simulated" and is the solver's recommendation; in the API it comes from the operator's acknowledge action.
 */
export function decisionsFor(trace: AgentRunTrace, snapshot: Snapshot, cycle: string, caseId: string, approvals: Map<string, string> | "simulate"): DecisionRecord[] {
  const facts = runFacts(snapshot);
  const explained = new Map(trace.nodes.filter((n: TaskNode) => n.role === "plan_explainer" && n.status === "accepted").map((n) => [n.incidentId!, (n.output as ExplainerOutput).presentFirstPlanId]));
  return facts.incidents.filter((i) => i.status === "ongoing" && i.category === "pump_failure" && i.plans.some((p) => p.recommended)).map((i) => {
    const rec = i.plans.find((p) => p.recommended)!;
    const approved = approvals === "simulate" ? rec.planId : approvals.get(i.incidentId) ?? null;
    return { id: `decision-${randomUUID()}`, cycle, caseId, runId: trace.runId, agentRunId: trace.id, incidentId: i.incidentId, facilityId: i.facilityId,
      recommendedPlanId: rec.planId, recommendedKind: rec.kind, recommendedCostUsd: rec.costUsd, agentPlanId: explained.get(i.incidentId) ?? null,
      approvedPlanId: approved, approvedBy: approved ? (approvals === "simulate" ? "simulated" : "operator") : null, outcome: null, createdAt: new Date().toISOString() };
  });
}

/**
 * What the telemetry of the following window shows for the facility: highest tank level, whether it reached the
 * shutdown limit (or was observed shut in), and whether the incident is still ongoing. Compared with the
 * recommended plan's forecast (tankTrips). Uses only the dataset's runtime inputs.
 */
export async function measureOutcome(dataset: ImportedDataset, cutoff: number, decision: Pick<DecisionRecord, "facilityId" | "recommendedPlanId">, forecastTankTrip: boolean,
  windowHours: number, cache = new Map<number, Snapshot>()): Promise<Outcome | null> {
  const step = 300, start = dataset.info.startUnix;
  const later = Math.min(start + Math.floor((cutoff + windowHours * 3600 - start) / step) * step, dataset.info.nowUnix);
  if (later <= cutoff) return null;
  let snap = cache.get(later);
  if (!snap) { snap = await snapshotAt(dataset, later); cache.set(later, snap); }
  const facility = snap.systems.flatMap((s) => s.facilities).find((f) => f.id === decision.facilityId);
  if (!facility) return null;
  const levels = facility.series.level.t.map((t, n) => [t, facility.series.level.v[n]] as const).filter(([t, v]) => t > cutoff && t <= later && typeof v === "number").map(([, v]) => v as number);
  const maxLevelPct = levels.length ? Math.max(...levels) : null;
  const tankLimitReached = maxLevelPct === null && facility.observedShutIn === null ? null : (maxLevelPct ?? 0) >= snap.limits.shutdownPct || facility.observedShutIn === true;
  const incidentStillOngoing = snap.alerts.some((a) => a.facilityId === decision.facilityId && a.category === "pump_failure" && a.status === "ongoing");
  return { windowHours, observedAtUnix: later, maxLevelPct, tankLimitReached, incidentStillOngoing, forecastTankTrip, forecastMatched: tankLimitReached === null ? null : tankLimitReached === forecastTankTrip };
}
