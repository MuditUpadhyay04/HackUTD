import { describe, expect, test } from 'bun:test';
import type { SystemPlanningInput } from '../../../../../packages/contracts/src/index';
import { solveSystemPlan } from './solver';
import { validateSystemPlan } from './validator';

const make = (): SystemPlanningInput => ({ systemId: 's', asOfUnix: 1000, inputRevision: 1, fleetSize: 1, truckCapacityBbl: 50, costPerTrip: 1, maxCandidates: 1000, jobs: [{ incidentId: 'a', facilityId: 'f', systemId: 's', levelPct: 50, capacityBbl: 100, shutdownPct: 90, horizonMin: 120, responseMin: 30, cycleMin: 60, alreadyTripped: false, wells: [{ id: 'w', waterBpd: 720, revenuePerHour: 100 }] }] });

describe('system planner', () => {
  test('uses full truck loads and does not mutate the input', () => {
    const input = make(), copy = JSON.stringify(input), result = solveSystemPlan(input);
    expect(validateSystemPlan(input, result)).toEqual({ valid: true, errors: [] });
    expect(result.recommendedByIncident.a.trucks).toBe(1);
    expect(JSON.stringify(input)).toBe(copy);
  });
  test('shares one truck across failures', () => {
    const input = make(); input.jobs.push({ ...input.jobs[0], incidentId: 'b', facilityId: 'g' });
    const result = solveSystemPlan(input);
    expect(result.recommendedByIncident.a.trucks + result.recommendedByIncident.b.trucks).toBeLessThanOrEqual(1);
    expect(validateSystemPlan(input, result).valid).toBe(true);
  });
  test('budget zero returns a valid baseline', () => {
    const input = make(); input.maxCandidates = 0;
    const result = solveSystemPlan(input);
    expect(result.timedOut).toBe(true);
    expect(result.recommendedByIncident.a.kind).toBe('do_nothing');
    expect(validateSystemPlan(input, result).valid).toBe(true);
  });
  test('zero fleet and delayed shut-in account for revenue', () => {
    const input = make(); input.fleetSize = 0;
    input.jobs[0].wells = [{ id: 'cheap', waterBpd: 600, revenuePerHour: 1 }, { id: 'valuable', waterBpd: 120, revenuePerHour: 100 }];
    const result = solveSystemPlan(input), option = result.recommendedByIncident.a;
    expect(option.shutIns[0].startAfterMin).toBeGreaterThan(0);
    expect(option.cost).toBeCloseTo((120 - option.shutIns[0].startAfterMin) / 60);
    expect(validateSystemPlan(input, result).valid).toBe(true);
  });
  test('threshold equality trips before a truck; repair boundary disallows arrival', () => {
    const input = make(); input.jobs[0].responseMin = 80; input.jobs[0].horizonMin = 120;
    const result = solveSystemPlan(input);
    expect(validateSystemPlan(input, result).valid).toBe(true);
    input.jobs[0].responseMin = 120;
    expect(solveSystemPlan(input).recommendedByIncident.a.trucks).toBe(0);
  });
  test('validator rejects simultaneous loads exceeding available water', () => {
    const input = make(); input.fleetSize = 2;
    const result = solveSystemPlan(input), option = result.recommendedByIncident.a;
    option.trucks = 2; option.tripsPerTruck = 1; option.truckArrivalsMin = [30];
    expect(validateSystemPlan(input, result).errors.some(e => e.includes('insufficient water'))).toBe(true);
  });
  test('seeds wells beyond FPGA capacity with a bounded budget', () => {
    const input = make(); input.fleetSize = 0; input.maxCandidates = 30;
    input.jobs[0].wells = Array.from({ length: 12 }, (_, i) => ({ id: `well${String(i).padStart(2, '0')}`, waterBpd: i === 11 ? 600 : 120 / 11, revenuePerHour: i === 11 ? 1 : 100 }));
    const result = solveSystemPlan(input);
    expect(result.recommendedByIncident.a.shutIns.map(s => s.wellId)).toEqual(['well11']);
    expect(validateSystemPlan(input, result).valid).toBe(true);
  });
  test('plan and option IDs are bounded and identify the full snapshot', () => {
    const input = make(); input.maxCandidates = 0;
    const first = solveSystemPlan(input);
    const other = structuredClone(input); other.asOfUnix++; other.jobs[0].incidentId = 'run-two-incident';
    const second = solveSystemPlan(other);
    expect(first.id).not.toBe(second.id);
    expect(first.id.length).toBeLessThanOrEqual(100);
    expect(first.recommendedByIncident.a.id.length).toBeLessThanOrEqual(100);
  });
  test('crossing exactly at arrival trips before an impossible full load', () => {
    const input = make(); input.truckCapacityBbl = 95; input.jobs[0].responseMin = 80;
    const result = solveSystemPlan(input), option = result.recommendedByIncident.a;
    option.trucks = 1; option.tripsPerTruck = 1; option.truckArrivalsMin = [80];
    expect(validateSystemPlan(input, result).errors.some(e => e.includes('insufficient water'))).toBe(true);
  });
});
