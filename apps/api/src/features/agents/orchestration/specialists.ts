import type { IncidentFact, RunFacts } from "./facts";
import { priorityOrder } from "./facts";

/**
 * Deterministic specialists exposed to agents as read-only tools ("specialists as tools"). The math lives here;
 * agents only explain and compare what these return (global_plan.md rule 12).
 */
export function requireIncident(facts: RunFacts, id: unknown): IncidentFact {
  const incident = facts.incidents.find((i) => i.incidentId === id);
  if (!incident) throw new Error("Incident outside scope");
  return incident;
}

/** Fleet planner view: the solver's validated options for one incident, cheapest first, with deltas. */
export function comparePlans(facts: RunFacts, incidentId: unknown) {
  const incident = requireIncident(facts, incidentId);
  const recommended = incident.plans.find((p) => p.recommended);
  if (!incident.plans.length) return { incidentId: incident.incidentId, facility: incident.facilityLabel, available: false, note: "No current validated plan for this incident." };
  return {
    incidentId: incident.incidentId, facility: incident.facilityLabel, available: true, recommendedPlanId: recommended?.planId ?? null,
    options: [...incident.plans].sort((a, b) => a.costUsd - b.costUsd).map((p) => ({ ...p, deltaVsRecommendedUsd: recommended ? p.costUsd - recommended.costUsd : null })),
    note: "Costs and feasibility come from the deterministic solver and validator; the recommended option is the solver's choice.",
  };
}

/** Well economist view: revenue exposure from snapshot fields only. */
export function wellEconomics(facts: RunFacts, incidentId: unknown) {
  const i = requireIncident(facts, incidentId);
  const hours = i.hoursToLimit, rate = i.lostRevenuePerHour;
  return { incidentId: i.incidentId, facility: i.facilityLabel, lostRevenuePerHour: rate, hoursToLimit: hours, countdown: i.countdown, levelPct: i.levelPct,
    revenueAtRiskPer8hShiftUsd: rate === null ? null : Math.round(rate * 8),
    note: rate === null ? "Lost revenue per hour is unavailable for this incident." : "Shut-in loses about lostRevenuePerHour for every hour the wells are shut." };
}

/** Inspection view for leaks and worn pumps: no countdown applies; the action is a field inspection. */
export function inspectionAdvice(facts: RunFacts, incidentId: unknown) {
  const i = requireIncident(facts, incidentId);
  if (i.category === "pump_failure") return { incidentId: i.incidentId, applicable: false, note: "Pump failures are handled by the fleet planner, not inspection." };
  return { incidentId: i.incidentId, facility: i.facilityLabel, applicable: true, action: "field inspection", countdown: "not applicable", evidence: i.evidence };
}

/** The deterministic rule 7 order with display lines (the console's Alerts view). */
export function alertsView(facts: RunFacts) {
  return priorityOrder(facts).map((id, rank) => {
    const i = requireIncident(facts, id);
    const line = i.category === "pump_failure" ? `${i.facilityLabel} pump down, tank ${i.levelPct ?? "unknown"}%, ${i.hoursToLimit === 0 ? "at the limit" : `${i.countdown} to limit`}` : `${i.facilityLabel} ${i.categoryLabel}, field inspection`;
    return { rank: rank + 1, incidentId: id, line };
  });
}
