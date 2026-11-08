import type { PlanningJob, PlanOption, SystemPlanningInput, SystemPlanResult, TruckAssignment } from '../../../../../packages/contracts/src/index';
import { createHash } from 'node:crypto';

type Choice = { trucks: number; trips: number; wells: string[]; start: number };
const baseline: Choice = { trucks: 0, trips: 0, wells: [], start: 0 };

// This is deliberately a policy search, not a claim of global optimality: trucks
// are called now; shut-ins share a five-minute start grid. The bounded search
// seeds every well before exploring a deterministic prefix/subset policy.
function simulate(input: SystemPlanningInput, job: PlanningJob, c: Choice, planId: string, base: boolean): PlanOption | null {
  let volume = job.capacityBbl * job.levelPct / 100;
  const limit = job.capacityBbl * job.shutdownPct / 100;
  let trip: number | null = job.alreadyTripped || volume >= limit ? 0 : null;
  let cost = c.trucks * c.trips * input.costPerTrip;
  const arrivals = Array.from({ length: c.trips }, (_, i) => job.responseMin + i * job.cycleMin);
  if (arrivals.some(t => t >= job.horizonMin)) return null;
  const times = [...new Set([0, job.horizonMin, ...arrivals, ...(c.wells.length ? [c.start] : [])])].sort((a, b) => a - b);
  const curve = [{ min: 0, pct: job.levelPct }];
  let previous = 0;
  for (const t of times) {
    const active = job.wells.filter(w => !c.wells.includes(w.id) || previous < c.start);
    const rate = active.reduce((s, w) => s + w.waterBpd, 0) / 1440;
    const shutRevenue = job.wells.filter(w => c.wells.includes(w.id) && previous >= c.start).reduce((s, w) => s + w.revenuePerHour, 0);
    if (trip === null && rate > 0 && volume + rate * (t - previous) >= limit) {
      trip = previous + (limit - volume) / rate;
      volume = limit;
      cost += shutRevenue * (trip - previous) / 60 + job.wells.reduce((s, w) => s + w.revenuePerHour, 0) * (t - trip) / 60;
    } else if (trip !== null) {
      cost += job.wells.reduce((s, w) => s + w.revenuePerHour, 0) * (t - previous) / 60;
    } else {
      volume += rate * (t - previous);
      cost += shutRevenue * (t - previous) / 60;
    }
    if (t > 0) curve.push({ min: t, pct: volume / job.capacityBbl * 100 });
    if (arrivals.includes(t)) {
      const load = c.trucks * input.truckCapacityBbl;
      if (volume < load) return null;
      volume -= load;
      curve.push({ min: t, pct: volume / job.capacityBbl * 100 });
    }
    previous = t;
  }
  const kind = c.trucks ? (c.wells.length ? 'mixed' : 'trucks') : c.wells.length ? 'shut_in' : 'do_nothing';
  const optionId = createHash('sha256').update(JSON.stringify([planId, job.incidentId])).digest('hex');
  return { id: `option:${optionId}`, systemPlanId: planId, inputRevision: input.inputRevision, kind,
    label: kind === 'do_nothing' ? 'Do nothing' : `${c.trucks ? `${c.trucks} truck(s), ${c.trips} trip(s)` : ''}${c.trucks && c.wells.length ? '; ' : ''}${c.wells.length ? `shut in ${c.wells.length} well(s) after ${c.start} min` : ''}`,
    cost, trucks: c.trucks, tripsPerTruck: c.trips, truckArrivalsMin: arrivals,
    shutIns: c.wells.map(wellId => ({ wellId, startAfterMin: c.start })), tankTrips: trip !== null, tripAtMin: trip,
    levelCurve: curve, feasibility: 'validated', searchStatus: base ? 'baseline' : 'best_feasible_found' };
}

export function solveSystemPlan(input: SystemPlanningInput): SystemPlanResult {
  if (input.jobs.some(j => !(j.horizonMin > 0))) throw new Error('Planning jobs require a positive remaining horizon');
  const jobs = [...input.jobs].sort((a, b) => a.incidentId.localeCompare(b.incidentId));
  const budget = Math.max(0, Math.floor(input.maxCandidates ?? 10000));
  let visited = 0, timedOut = false;
  let best = jobs.map(() => baseline), bestCost = Infinity;
  const evaluate = (choices: Choice[]) => {
    const opts = jobs.map((j, i) => simulate(input, j, choices[i], 'candidate', false));
    if (opts.some(o => !o)) return;
    const cost = opts.reduce((s, o) => s + o!.cost, 0);
    if (cost < bestCost - 1e-9) { bestCost = cost; best = choices.slice(); }
  };
  evaluate(best);
  function* choices(job: PlanningJob, remaining: number): Generator<Choice> {
    yield baseline;
    const wells = [...job.wells].sort((a, b) => a.id.localeCompare(b.id));
    // Generate lazily: neither well count nor horizon allocates an exponential array.
    for (let trucks = 1; trucks <= remaining; trucks++) {
      const maxTrips = job.cycleMin > 0 ? Math.max(0, Math.ceil((job.horizonMin - job.responseMin) / job.cycleMin)) : 0;
      for (let trips = 1; trips <= maxTrips; trips++) yield { trucks, trips, wells: [], start: 0 };
    }
    for (let trucks = 0; trucks <= remaining; trucks++) {
      const maxTrips = trucks && job.cycleMin > 0 ? Math.max(0, Math.ceil((job.horizonMin - job.responseMin) / job.cycleMin)) : 0;
      for (let trips = trucks ? 1 : 0; trips <= maxTrips; trips++) {
        // Prefixes and pairs cover all wells without bit shifts or materializing
        // the power set. Search budget still bounds the potentially large grid.
        for (let size = 1; size <= wells.length; size++) {
          const selected = wells.slice(0, size).map(w => w.id);
          for (let start = 0; start < job.horizonMin; start += 5) yield { trucks, trips, wells: selected, start };
        }
        for (let a = 0; a < wells.length; a++) for (let b = a + 1; b < wells.length; b++)
          for (let start = 0; start < job.horizonMin; start += 5) yield { trucks, trips, wells: [wells[a].id, wells[b].id], start };
      }
    }
  }
  // Round-robin seeds: one trip, every singleton, and all wells per job.
  // Analytically choose the latest grid point strictly below the threshold at
  // repair; replay decides feasibility, including earlier threshold crossings.
  const seedLists = jobs.map(job => {
    const wells = [...job.wells].sort((a, b) => a.id.localeCompare(b.id));
    const groups = [...wells.map(w => [w]), ...(wells.length > 1 ? [wells] : [])];
    const seeds: Choice[] = [];
    if (input.fleetSize > 0 && job.responseMin < job.horizonMin) seeds.push({ trucks: 1, trips: 1, wells: [], start: 0 });
    for (const group of groups) {
      const total = wells.reduce((s, w) => s + w.waterBpd, 0) / 1440;
      const removed = group.reduce((s, w) => s + w.waterBpd, 0) / 1440;
      const room = job.capacityBbl * (job.shutdownPct - job.levelPct) / 100;
      const latest = removed > 0 ? (room - (total - removed) * job.horizonMin) / removed : 0;
      const start = Math.max(0, Math.min(Math.ceil(job.horizonMin / 5) * 5 - 5, (Math.ceil(latest / 5) - 1) * 5));
      seeds.push({ trucks: 0, trips: 0, wells: group.map(w => w.id), start });
    }
    return seeds;
  });
  for (let round = 0; seedLists.some(list => round < list.length) && visited < budget; round++) {
    for (let i = 0; i < jobs.length && visited < budget; i++) if (seedLists[i][round]) {
      const candidate = jobs.map(() => baseline);
      candidate[i] = seedLists[i][round];
      visited++; evaluate(candidate);
    }
  }
  const current: Choice[] = [];
  function search(i: number, remaining: number): void {
    if (timedOut) return;
    if (i === jobs.length) {
      if (visited >= budget) { timedOut = true; return; }
      visited++; evaluate(current); return;
    }
    for (const c of choices(jobs[i], remaining)) {
      current.push(c); search(i + 1, remaining - c.trucks); current.pop();
      if (timedOut) return;
    }
  }
  search(0, Math.max(0, Math.floor(input.fleetSize)));
  // The complete choices are encoded, avoiding collisions between coherent alternatives.
  const makeId = (choices: Choice[]) => `plan:${createHash('sha256').update(JSON.stringify([input, choices])).digest('hex')}`;
  const baseId = makeId(jobs.map(() => baseline));
  const isBaseline = best.every(c => !c.trucks && !c.wells.length);
  const id = isBaseline ? baseId : makeId(best);
  const recommendedByIncident: Record<string, PlanOption> = {}, optionsByIncident: Record<string, PlanOption[]> = {};
  const assignments: TruckAssignment[] = [];
  let truck = 0;
  jobs.forEach((j, i) => {
    const option = simulate(input, j, best[i], id, isBaseline)!;
    const original = simulate(input, j, baseline, baseId, true)!;
    recommendedByIncident[j.incidentId] = option;
    optionsByIncident[j.incidentId] = isBaseline ? [option] : [option, original];
    for (let n = 0; n < option.trucks; n++) assignments.push({ truck: ++truck, incidentId: j.incidentId, facilityId: j.facilityId, fromUnix: input.asOfUnix, toUnix: input.asOfUnix + (option.truckArrivalsMin.at(-1)! + j.cycleMin) * 60, tripsArrivalUnix: option.truckArrivalsMin.map(t => input.asOfUnix + t * 60) });
  });
  return { id, systemId: input.systemId, inputRevision: input.inputRevision, totalCost: bestCost, optionsByIncident, recommendedByIncident, assignments, searchStatus: 'best_feasible_found', policy: `Immediate static fleet allocation; integer trips; common 5-minute shut-in grid; round-robin singleton and all-well seeds, then ID-ordered prefixes and pairs; ${visited}/${budget} candidates evaluated`, timedOut };
}
