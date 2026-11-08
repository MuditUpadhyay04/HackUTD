/**
 * Test helpers: build configs and telemetry records without touching
 * answer_key.json, hardcoded asset IDs, or practice constants.
 */

import type {
  DatasetConfig,
  FacilityConfig,
  GlobalConfig,
  ModelMetadata,
  TelemetryRecord,
} from "../src/types.ts";
import { buildDatasetConfig } from "../src/runtime.ts";
import { STATUS } from "../src/types.ts";

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

const EMPTY_MODEL: ModelMetadata = {
  weightsVer: 0,
  weights: null,
  biases: null,
  outputShift: 0,
  loaded: false,
};

/** Build one facility config with W wells, baseline B, pump Q, tank C, disposal P0. */
export function makeFacilityConfig(
  facilityId: string,
  systemId: string,
  { B = 2400, Q = 3600, C = 1200, P0 = 1050, shutdownLvl = 9200, warningLvl = 8500, W = 3, slot = 0 }:
    { B?: number; Q?: number; C?: number; P0?: number; shutdownLvl?: number; warningLvl?: number; W?: number; slot?: number } = {},
): FacilityConfig {
  return {
    facilityId,
    systemId,
    B, Q, C, W, P0,
    shutdownLvl,
    warningLvl,
    lo: [-32768, -32768, -32768, -32768, -32768, -32768, -32768],
    hi: [32767, 32767, 32767, 32767, 32767, 32767, 32767],
    wellLo: -32768,
    wellHi: 32767,
    slot,
    nWells: W,
  };
}

/** Build a DatasetConfig with N facilities (distinct IDs, unbounded for logical API). */
export function makeDatasetConfig(
  facilityIds: string[],
  overrides: Record<string, Partial<Parameters<typeof makeFacilityConfig>[2]> & { slot?: number }> = {},
): DatasetConfig {
  const facilityById = new Map<string, FacilityConfig>();
  let slot = 0;
  for (const id of facilityIds) {
    const o = overrides[id] ?? {};
    const f = makeFacilityConfig(id, "S1", { ...o, slot: o.slot ?? slot });
    facilityById.set(id, f);
    slot += 1;
  }
  return {
    datasetId: "test-dataset",
    sourceFiles: { network: "", ops: "", telemetry: "" },
    firstTsUnix: 1791186900,
    lastTsUnix: 1791186900 + 100000,
    stepSeconds: 300,
    systems: [{ systemId: "S1", disposalPsi: 1050, facilities: Array.from(facilityById.values()), emergencyFleetSize: 2, facilityOps: new Map() }],
    facilityById,
    global: DEFAULT_GLOBAL,
    model: EMPTY_MODEL,
  } as DatasetConfig;
}

/** Build a telemetry record. All fields present by default. */
export function makeRecord(
  facilityId: string,
  tsUnix: number,
  {
    inflowBpd = 2400,
    levelPct = 50,
    pumpStatus = 1,
    pumpFlowBpd = 3000,
    receiveFlowBpd = 3000,
    dischargePsi = 1100,
    pipelinePsi = 1050,
    wellStatus = [1, 1, 1],
    wellWaterBpd = [800, 800, 800],
    presentAll = true,
  }: {
    inflowBpd?: number; levelPct?: number; pumpStatus?: number; pumpFlowBpd?: number;
    receiveFlowBpd?: number; dischargePsi?: number; pipelinePsi?: number;
    wellStatus?: number[]; wellWaterBpd?: number[]; presentAll?: boolean;
  } = {},
): TelemetryRecord {
  const W = wellStatus.length;
  const present = {
    inflow: presentAll,
    level: presentAll,
    pumpStatus: presentAll,
    pumpFlow: presentAll,
    receiveFlow: presentAll,
    discharge: presentAll,
    pipeline: presentAll,
    wellStatus: new Array(W).fill(presentAll),
    wellWater: new Array(W).fill(presentAll),
  };
  return {
    facilityId,
    tsUnix,
    present,
    inflowBpd,
    levelPct,
    pumpStatus,
    pumpFlowBpd,
    receiveFlowBpd,
    dischargePsi,
    pipelinePsi,
    wellStatus,
    wellWaterBpd,
  };
}

/** Build a record with selected fields missing (present=false, value=null). */
export function makePartialRecord(
  facilityId: string,
  tsUnix: number,
  missing: ("inflow" | "level" | "pumpStatus" | "pumpFlow" | "receiveFlow" | "discharge" | "pipeline")[],
  wellsMissing: boolean[] = [],
): TelemetryRecord {
  const W = wellsMissing.length;
  const present = {
    inflow: !missing.includes("inflow"),
    level: !missing.includes("level"),
    pumpStatus: !missing.includes("pumpStatus"),
    pumpFlow: !missing.includes("pumpFlow"),
    receiveFlow: !missing.includes("receiveFlow"),
    discharge: !missing.includes("discharge"),
    pipeline: !missing.includes("pipeline"),
    wellStatus: wellsMissing.map((m) => !m),
    wellWater: wellsMissing.map((m) => !m),
  };
  return {
    facilityId, tsUnix, present,
    inflowBpd: present.inflow ? 2400 : null,
    levelPct: present.level ? 50 : null,
    pumpStatus: present.pumpStatus ? 1 : null,
    pumpFlowBpd: present.pumpFlow ? 3000 : null,
    receiveFlowBpd: present.receiveFlow ? 3000 : null,
    dischargePsi: present.discharge ? 1100 : null,
    pipelinePsi: present.pipeline ? 1050 : null,
    wellStatus: wellsMissing.map((m, i) => (!m ? 1 : null)),
    wellWaterBpd: wellsMissing.map((m, i) => (!m ? 800 : null)),
  };
}

export { STATUS };
