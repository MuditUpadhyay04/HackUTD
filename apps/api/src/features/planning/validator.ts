import type { PlanOption, SystemPlanningInput, SystemPlanResult } from '../../../../../packages/contracts/src/index';

/** Independent event replay. A threshold reached exactly at an arrival trips first. */
export function validateSystemPlan(input: SystemPlanningInput, result: SystemPlanResult): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const fail = (s: string) => errors.push(s);
  const near = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));
  if (result.systemId !== input.systemId || result.inputRevision !== input.inputRevision) fail('Result identity does not match input');
  const replay = (job: SystemPlanningInput['jobs'][number], option: PlanOption) => {
    const prefix = job.incidentId;
    if (option.inputRevision !== input.inputRevision || option.feasibility !== 'validated') fail(`${prefix}: invalid metadata`);
    if (!Number.isInteger(option.trucks) || option.trucks < 0 || !Number.isInteger(option.tripsPerTruck) || option.tripsPerTruck < 0 || (!!option.trucks !== !!option.tripsPerTruck)) fail(`${prefix}: invalid truck counts`);
    const expected = Array.from({ length: Math.max(0, Math.min(100000, option.tripsPerTruck)) }, (_, i) => job.responseMin + i * job.cycleMin);
    if (expected.length !== option.truckArrivalsMin.length || expected.some((t, i) => t >= job.horizonMin || !near(t, option.truckArrivalsMin[i]))) fail(`${prefix}: invalid arrival schedule`);
    const ids = new Set<string>();
    for (const s of option.shutIns) {
      if (ids.has(s.wellId) || !job.wells.some(w => w.id === s.wellId) || !Number.isFinite(s.startAfterMin) || s.startAfterMin < 0 || s.startAfterMin >= job.horizonMin || s.startAfterMin % 5 !== 0) fail(`${prefix}: invalid shut-in`);
      ids.add(s.wellId);
    }
    if (new Set(option.shutIns.map(s => s.startAfterMin)).size > 1) fail(`${prefix}: shut-ins do not share a start time`);
    let volume = job.levelPct * job.capacityBbl / 100;
    const limit = job.shutdownPct * job.capacityBbl / 100;
    let trip: number | null = job.alreadyTripped || volume >= limit ? 0 : null;
    let cost = option.trucks * option.tripsPerTruck * input.costPerTrip;
    let last = 0;
    const times = [...new Set([0, job.horizonMin, ...expected, ...option.shutIns.map(s => s.startAfterMin)])].sort((a, b) => a - b);
    for (const t of times) {
      const shut = new Set(option.shutIns.filter(s => s.startAfterMin <= last).map(s => s.wellId));
      const flow = job.wells.reduce((s, w) => s + (shut.has(w.id) ? 0 : w.waterBpd / 1440), 0);
      const allRevenue = job.wells.reduce((s, w) => s + w.revenuePerHour, 0);
      const shutRevenue = job.wells.reduce((s, w) => s + (shut.has(w.id) ? w.revenuePerHour : 0), 0);
      if (trip === null && flow > 0 && volume + flow * (t - last) >= limit) {
        trip = last + (limit - volume) / flow;
        cost += shutRevenue * (trip - last) / 60 + allRevenue * (t - trip) / 60;
        volume = limit;
      } else if (trip !== null) cost += allRevenue * (t - last) / 60;
      else { volume += flow * (t - last); cost += shutRevenue * (t - last) / 60; }
      if (expected.includes(t)) {
        const load = option.trucks * input.truckCapacityBbl;
        if (volume < load) fail(`${prefix}: insufficient water for full simultaneous loads`);
        volume -= load;
      }
      last = t;
    }
    if (!near(cost, option.cost)) fail(`${prefix}: cost mismatch`);
    if (option.tankTrips !== (trip !== null) || (trip === null ? option.tripAtMin !== null : option.tripAtMin === null || !near(option.tripAtMin, trip))) fail(`${prefix}: trip mismatch`);
    if (!option.levelCurve.length || option.levelCurve.some(p => !Number.isFinite(p.min) || !Number.isFinite(p.pct))) fail(`${prefix}: invalid curve`);
  };
  let sum = 0, trucks = 0;
  for (const job of input.jobs) {
    const option = result.recommendedByIncident[job.incidentId];
    if (!option) { fail(`${job.incidentId}: missing recommendation`); continue; }
    if (option.systemPlanId !== result.id) fail(`${job.incidentId}: recommendation belongs to another plan`);
    replay(job, option); sum += option.cost; trucks += option.trucks;
    if (!result.optionsByIncident[job.incidentId]?.some(o => o.id === option.id)) fail(`${job.incidentId}: recommendation missing from options`);
  }
  if (trucks > input.fleetSize) fail('Fleet exceeded');
  if (!near(sum, result.totalCost)) fail('Total cost mismatch');
  for (const job of input.jobs) {
    const option = result.recommendedByIncident[job.incidentId];
    if (!option) continue;
    const assignments = result.assignments.filter(a => a.incidentId === job.incidentId);
    if (assignments.length !== option.trucks) fail(`${job.incidentId}: assignment count mismatch`);
    for (const a of assignments) if (a.facilityId !== job.facilityId || a.fromUnix !== input.asOfUnix || !near(a.toUnix, input.asOfUnix + (option.truckArrivalsMin.at(-1)! + job.cycleMin) * 60) || a.tripsArrivalUnix.length !== option.truckArrivalsMin.length || a.tripsArrivalUnix.some((t, i) => !near(t, input.asOfUnix + option.truckArrivalsMin[i] * 60))) fail(`${job.incidentId}: invalid assignment`);
  }
  if (new Set(result.assignments.map(a => a.truck)).size !== result.assignments.length || result.assignments.some(a => !input.jobs.some(j => j.incidentId === a.incidentId) || !Number.isInteger(a.truck) || a.truck < 1 || a.truck > input.fleetSize)) fail('Invalid truck assignment');
  // Every alternative ID must describe a complete independently replayable system plan.
  const alternativeIds = new Set(Object.values(result.optionsByIncident).flat().map(o => o.systemPlanId));
  for (const id of alternativeIds) {
    let count = 0;
    for (const job of input.jobs) {
      const alternatives = (result.optionsByIncident[job.incidentId] ?? []).filter(o => o.systemPlanId === id);
      if (alternatives.length !== 1) { fail(`${id}: incomplete alternative`); continue; }
      replay(job, alternatives[0]); count += alternatives[0].trucks;
    }
    if (count > input.fleetSize) fail(`${id}: alternative exceeds fleet`);
  }
  return { valid: errors.length === 0, errors };
}
