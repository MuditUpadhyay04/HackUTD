import { describe, expect, test } from "bun:test";
import { importDataset } from "./service";

function fixture(facilityCount = 1, wellCount = 1) {
  const facilities = Array.from({ length: facilityCount }, (_, i) => ({
    id: `facility-${i}`, lat: 1, lon: 2,
    wells: Array.from({ length: wellCount }, (_, j) => ({ id: `well-${i}-${j}`, baseline_water_bpd: 10, oil_bpd: 2, gas_mcfd: 3 })),
    tank: { id: `tank-${i}`, capacity_bbl: 100 },
    pump: { id: `pump-${i}`, max_flow_bpd: 100, start_level_pct: 70, stop_level_pct: 30 },
    pipeline: { id: `pipe-${i}` },
  }));
  const network = { defaults: { tank_limits_pct: { warning: 85, shutdown: 92 } }, systems: [{ id: "unfamiliar-system", center: [1, 2], truck_yard: [1, 2], disposal_site: { id: "disposal", lat: 1, lon: 2, pressure_psi: 100 }, facilities }] };
  const ops = { prices: { oil_per_bbl: 1, gas_per_mcf: 2 }, expected_repair_hours: { pump_failure: 6 }, emergency_trucking: { truck_capacity_bbl: 10, cost_per_trip: 1 }, systems: { "unfamiliar-system": { emergency_fleet_size: 1, facilities: Object.fromEntries(facilities.map(f => [f.id, { response_min: 5, cycle_min: 10 }])) } } };
  const header = "timestamp,ts_unix,asset_id,metric,value\n";
  const early = '2026-01-01T00:00:00Z,1767225600,well-0-0,status,1';
  const late = '2026-01-01T00:10:00Z,1767226200,facility-0,inflow_bpd,"12.5"';
  return { network, ops, header, early, late, files: () => ({ network: JSON.stringify(network), ops: JSON.stringify(ops), telemetry: `${header}${late}\n${early}\n` }) };
}

describe("dataset import", () => {
  test("sorts by recorded time, pivots gaps and hashes immutable input", async () => {
    const f = fixture(), a = await importDataset(f.files()), b = await importDataset(f.files());
    expect(a.info.id).toBe(b.info.id);
    expect(a.info.startUnix).toBe(1767225600); expect(a.info.nowUnix).toBe(1767226200);
    expect(a.frames.map(frame => frame.tsUnix)).toEqual([1767225600, 1767225900, 1767226200]);
    expect(a.frames[0]!.wellStatus).toEqual([1]); expect(a.frames[1]!.wellWaterBpd).toEqual([null]);
    expect(a.frames[2]!.inflowBpd).toBe(12.5); expect(a.info.warnings.length).toBeGreaterThan(0);
  });
  test("deduplicates identical values, rejects conflicts, invalid enum is unknown", async () => {
    const f = fixture(), files = f.files();
    files.telemetry += `${f.early}\n2026-01-01T00:00:00Z,1767225600,pump-0,status,9\n`;
    const data = await importDataset(files);
    expect(data.frames[0]!.pumpStatus).toBeNull(); expect(data.samples.length).toBe(3);
    files.telemetry += '2026-01-01T00:00:00Z,1767225600,well-0-0,status,0\n';
    await expect(importDataset(files)).rejects.toThrow("conflicting duplicate");
  });
  test("rejects malformed schema, unsafe IDs, references, fleet and travel", async () => {
    const f = fixture(); f.ops.systems["unfamiliar-system"].emergency_fleet_size = -1;
    await expect(importDataset(f.files())).rejects.toThrow();
    f.ops.systems["unfamiliar-system"].emergency_fleet_size = 1;
    f.ops.systems["unfamiliar-system"].facilities["facility-0"]!.cycle_min = -1;
    await expect(importDataset(f.files())).rejects.toThrow();
    f.ops.systems["unfamiliar-system"].facilities["facility-0"]!.cycle_min = 1;
    f.network.systems[0]!.facilities[0]!.tank.id = "constructor";
    await expect(importDataset(f.files())).rejects.toThrow();
    f.network.systems[0]!.facilities[0]!.tank.id = "tank-0";
    const files = f.files(); files.telemetry += '2026-01-01T00:00:00Z,1767225600,alien,status,1\n';
    await expect(importDataset(files)).rejects.toThrow();
  });
  test("large topology remains valid in software", async () => {
    const data = await importDataset(fixture(40, 12).files());
    expect(data.info.hardwareEligible).toBe(false); expect(data.info.hardwareReasons).toHaveLength(2);
    expect(data.frames).toHaveLength(120); expect(data.frames[0]!.wellStatus).toHaveLength(12);
  });
  test("rejects extra inputs and off-grid timestamps", async () => {
    const f = fixture(), files = f.files();
    const extra = { ...files, answer_key: "{}" };
    await expect(importDataset(extra)).rejects.toThrow();
    files.telemetry += '2026-01-01T00:00:01Z,1767225601,pump-0,status,1\n';
    await expect(importDataset(files)).rejects.toThrow("300-second grid");
  });
});
