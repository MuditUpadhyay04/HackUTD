/**
 * Dataset configuration loading.
 *
 * Runtime inputs are only network.json, ops.json and telemetry.csv. answer_key.json
 * is never read here. Asset IDs, counts, event times and practice-network constants
 * are read from the files - nothing is hardcoded.
 *
 * The loader is schema-permissive about fields we don't need for inference, but
 * strict about the fields the classifier, rules and countdown require:
 *   facility.id, facility.wells[].baseline_water_bpd (B),
 *   facility.pump.max_flow_bpd (Q), facility.tank.capacity_bbl (C),
 *   system.disposal_site.pressure_psi (P0), tank limits (warning/shutdown),
 *   ops emergency_fleet_size / response_min / cycle_min.
 */

import type {
  DatasetConfig,
  FacilityConfig,
  FacilityId,
  GlobalConfig,
  ModelMetadata,
  SystemConfig,
  SystemId,
} from "./types.ts";

const DEFAULT_STEP_SECONDS = 300;
const DEFAULT_GLOBAL: GlobalConfig = {
  S: 9,
  holdMax: 2,
  cdLog2: 4,
  persistK: 3,
  hbPeriodMs: 1000,
  hbTimeoutMs: 5000,
  logitThr: new Int16Array([0, 0, 0, 0]),
  gapThr: 0,
  streamEnable: false,
};

const DEFAULT_MODEL: ModelMetadata = {
  weightsVer: 0,
  weights: null,
  biases: null,
  outputShift: 0,
  loaded: false,
};

function requireFinite(value: unknown, path: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`[fpga-sim/config] ${path}: expected a finite number, got ${JSON.stringify(value)}`);
  }
  return n;
}

function requirePositive(value: unknown, path: string): number {
  const n = requireFinite(value, path);
  if (n <= 0) {
    throw new Error(`[fpga-sim/config] ${path}: expected a positive number, got ${n}`);
  }
  return n;
}

function requireAtLeastOne(value: unknown, path: string): number {
  const n = requireFinite(value, path);
  if (n < 1) {
    throw new Error(`[fpga-sim/config] ${path}: expected >= 1, got ${n}`);
  }
  return n;
}

function getWellCount(facility: unknown): number {
  const f = facility as { wells?: unknown[] };
  if (!Array.isArray(f.wells) || f.wells.length < 1) {
    throw new Error("[fpga-sim/config] facility must declare at least one well");
  }
  return f.wells.length;
}

function getBaselineWater(facility: unknown): number {
  const f = facility as { wells?: Array<{ baseline_water_bpd?: unknown }> };
  const wells = f.wells;
  if (!Array.isArray(wells) || wells.length < 1) {
    throw new Error("[fpga-sim/config] facility must declare at least one well");
  }
  let sum = 0;
  for (const w of wells) {
    sum += requirePositive(w.baseline_water_bpd, `facility.wells[].baseline_water_bpd`);
  }
  return sum;
}

function loadFacility(
  facility: unknown,
  systemId: SystemId,
  shutdownLvl: number,
  warningLvl: number,
  slot: number,
): FacilityConfig {
  const f = facility as {
    id?: unknown;
    tank?: { capacity_bbl?: unknown };
    pump?: { max_flow_bbl?: unknown; max_flow_bpd?: unknown };
    wells?: Array<{ baseline_water_bpd?: unknown; status?: unknown; water_bpd?: unknown }>;
  };
  const facilityId = String(f.id ?? "");
  if (!facilityId) {
    throw new Error("[fpga-sim/config] facility missing id");
  }
  const B = getBaselineWater(f);
  const Q = requirePositive(f.pump?.max_flow_bpd ?? f.pump?.max_flow_bbl, `facility.pump.max_flow_bpd`);
  const C = requirePositive(f.tank?.capacity_bbl, `facility.tank.capacity_bbl`);
  const W = getWellCount(f);
  const nWells = W;

  // Bounds for the 7 facility readings, same LSBs as DATA. Default to full int16 range
  // when the file does not provide per-facility bounds; callers may tighten these.
  const lo: number[] = [-32768, -32768, -32768, -32768, -32768, -32768, -32768];
  const hi: number[] = [32767, 32767, 32767, 32767, 32767, 32767, 32767];
  const wellLo = -32768;
  const wellHi = 32767;

  return {
    facilityId,
    systemId,
    B,
    Q,
    C,
    W,
    P0: 0, // filled in by the system loop
    shutdownLvl: requireAtLeastOne(shutdownLvl, "tank_limits_pct.shutdown") as number,
    warningLvl: requireAtLeastOne(warningLvl, "tank_limits_pct.warning") as number,
    lo,
    hi,
    wellLo,
    wellHi,
    slot,
    nWells,
  };
}

function loadSystem(system: unknown, defaults: unknown, slotCursor: number): SystemConfig {
  const s = system as {
    id?: unknown;
    disposal_site?: { pressure_psi?: unknown };
    facilities?: unknown[];
  };
  const systemId = String(s.id ?? "");
  if (!systemId) {
    throw new Error("[fpga-sim/config] system missing id");
  }
  const disposalPsi = requireFinite(s.disposal_site?.pressure_psi, `system.${systemId}.disposal_site.pressure_psi`);

  const tankLimits = (defaults as { tank_limits_pct?: { warning?: unknown; shutdown?: unknown } } ?? {})
    .tank_limits_pct ?? {};
  const shutdownLvl = requireAtLeastOne(tankLimits.shutdown, "defaults.tank_limits_pct.shutdown");
  const warningLvl = requireAtLeastOne(tankLimits.warning, "defaults.tank_limits_pct.warning");

  const facilities: FacilityConfig[] = [];
  let slot = slotCursor;
  for (const f of s.facilities ?? []) {
    const fc = loadFacility(f, systemId, shutdownLvl, warningLvl, slot);
    fc.P0 = disposalPsi;
    facilities.push(fc);
    slot += 1;
  }

  return {
    systemId,
    disposalPsi,
    facilities,
    emergencyFleetSize: 0, // filled in from ops
    facilityOps: new Map(),
  };
}

export function loadDatasetConfig(
  network: unknown,
  ops: unknown,
  firstTsUnix: number,
  lastTsUnix: number,
  stepSeconds: number = DEFAULT_STEP_SECONDS,
  model: ModelMetadata = DEFAULT_MODEL,
): DatasetConfig {
  const net = network as {
    systems?: unknown[];
    defaults?: { tank_limits_pct?: { warning?: unknown; shutdown?: unknown } };
  };
  const opsDoc = ops as {
    emergency_trucking?: { truck_capacity_bbl?: unknown; cost_per_trip?: unknown };
    systems?: Record<string, { emergency_fleet_size?: unknown; facilities?: Record<string, { response_min?: unknown; cycle_min?: unknown }> }>;
    prices?: { oil_per_bbl?: unknown; gas_per_mcf?: unknown };
  };

  const systems: SystemConfig[] = [];
  const facilityById = new Map<FacilityId, FacilityConfig>();
  let slotCursor = 0;

  for (const s of net.systems ?? []) {
    const sys = loadSystem(s, net.defaults, slotCursor);
    systems.push(sys);
    for (const f of sys.facilities) {
      facilityById.set(f.facilityId, f);
      slotCursor += 1;
    }
  }

  // Apply ops: fleet size and per-facility response/cycle minutes.
  const opsSystems = opsDoc.systems ?? {};
  for (const sys of systems) {
    const os = opsSystems[sys.systemId];
    if (os) {
      sys.emergencyFleetSize = requireAtLeastOne(
        os.emergency_fleet_size ?? 0,
        `systems.${sys.systemId}.emergency_fleet_size`,
      );
      const of = os.facilities ?? {};
      for (const f of sys.facilities) {
        const fo = of[f.facilityId];
        if (fo) {
          sys.facilityOps.set(f.facilityId, {
            responseMin: requireFinite(fo.response_min ?? 0, `systems.${sys.systemId}.facilities.${f.facilityId}.response_min`),
            cycleMin: requireFinite(fo.cycle_min ?? 0, `systems.${sys.systemId}.facilities.${f.facilityId}.cycle_min`),
          });
        }
      }
    }
  }

  const global: GlobalConfig = { ...DEFAULT_GLOBAL };

  return {
    datasetId: `${net.systems?.length ?? 0}-systems`,
    sourceFiles: { network: "", ops: "", telemetry: "" },
    firstTsUnix,
    lastTsUnix,
    stepSeconds,
    systems,
    facilityById,
    global,
    model,
  };
}

export function withSourceFiles(
  config: DatasetConfig,
  sources: { network: string; ops: string; telemetry: string },
): DatasetConfig {
  return { ...config, sourceFiles: sources };
}

export function withModel(config: DatasetConfig, model: ModelMetadata): DatasetConfig {
  return { ...config, model };
}

export const EMPTY_CONFIG: DatasetConfig = {
  datasetId: "empty",
  sourceFiles: { network: "", ops: "", telemetry: "" },
  firstTsUnix: 0,
  lastTsUnix: 0,
  stepSeconds: DEFAULT_STEP_SECONDS,
  systems: [],
  facilityById: new Map(),
  global: DEFAULT_GLOBAL,
  model: DEFAULT_MODEL,
};
