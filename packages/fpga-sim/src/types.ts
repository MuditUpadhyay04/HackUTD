/**
 * Shared runtime contracts for the FPGA-inference software replacement.
 *
 * These types describe the logical (non-wire) surface that both a software
 * adapter and a future FPGA adapter must honour. The v1 wire codec (src/codec/v1.ts)
 * translates between these logical types and the on-the-wire byte layouts; it does
 * NOT change the logical contract.
 *
 * Design principles:
 *  - No 32-facility / 8-well hardware limits leak into the logical API. Those are
 *    per-config hardware limits, enforced only by packed adapters (see codec limits).
 *  - Every result carries explicit provenance ("fpga" | "software" | "unavailable")
 *    and availability so callers never mistake software output for board output.
 *  - Bad/missing data is never reported healthy: every result carries status +
 *    reason bits.
 *  - No weights loaded => scores unavailable; we never fabricate calibrated
 *    confidence or 0.5 probabilities.
 */

export type FacilityId = string;
export type SystemId = string;

/** Provenance of a result. "unavailable" means no classifier could run. */
export type Provenance = "fpga" | "software" | "unavailable";

/** Result status, matching the FPGA RESULT record. */
export type ResultStatus = 0 | 1 | 2 | 3 | 4;

export const STATUS = {
  VALID: 0 as ResultStatus,
  HELD: 1 as ResultStatus,
  RESERVED: 2 as ResultStatus,
  INVALID: 3 as ResultStatus,
  DROPPED: 4 as ResultStatus,
} as const;

export interface ReasonBits {
  /** 0: at least one field was held (last valid value reused). */
  fieldHeld: boolean;
  /** 1: a step gap was held (timestamp > expected + step). */
  stepGapHeld: boolean;
  /** 2: facility history was reset (gap > hold_max, or explicit reset). */
  historyReset: boolean;
  /** 3: a value was out of its configured physical range. */
  outOfRange: boolean;
  /** 4: an illegal enum (pump status not in {0,1,2}, well status not in {0,1}). */
  illegalEnum: boolean;
  /** 5: a feature saturated the int16 range [-2, 2). */
  featureSaturated: boolean;
  /** 6: pump/flow cross-field inconsistency (e.g. pump off but flow > 0). */
  pumpFlowInconsistent: boolean;
  /** 7: well status/water inconsistency. */
  wellInconsistent: boolean;
  /** 8: duplicate record (same ts as previous for this facility). */
  duplicate: boolean;
  /** 9: out-of-order record (ts < previous ts for this facility). */
  outOfOrder: boolean;
  /** 10: unknown facility id (not in config). */
  unknownFacility: boolean;
}

export interface RuleFlags {
  /** bit 0: pump_fault (pump status == 2). */
  pumpFault: boolean;
  /** bit 1: shut_in (all configured wells status 0 and water 0). */
  shutIn: boolean;
  /** bit 2: level >= shutdown limit. */
  levelAtShutdown: boolean;
  /** bit 3: level >= warning limit. */
  levelAtWarning: boolean;
  /** bit 4: not filling (net inflow <= 0). */
  notFilling: boolean;
}

/** Countdown output in minutes. 0xFFFF sentinel = not filling or beyond range. */
export const COUNTDOWN_NOT_FILLING = 0xffff;
export type CountdownMinutes = number;

export interface Countdown {
  p10: CountdownMinutes; // soonest (rolling max net inflow)
  p50: CountdownMinutes; // rolling mean net inflow
  p90: CountdownMinutes; // latest (rolling min net inflow)
  /** True when any value is the not-filling sentinel. */
  notFilling: boolean;
}

/** One inference result per facility record. */
export interface InferenceResult {
  facilityId: FacilityId;
  tsUnix: number;
  status: ResultStatus;
  sinceReset: number; // 0..255 saturating
  reason: ReasonBits;
  /** 12 current channels, int16 at scale 1/16384 (feature units). null when INVALID/DROPPED. */
  channels: Int16Array | null;
  /** 19 memory features (indices 12..30 of the 31-feature vector), int16. null when INVALID/DROPPED. */
  memoryFeatures: Int16Array | null;
  /**
   * Four logits in order [pipeline_leak, pump_degradation, pump_failure, facility_shut_in].
   * null when no weights are loaded / metadata unknown. Never fabricated.
   */
  logits: Int16Array | null;
  /** Per-class thresholds applied (from config), or null. */
  logitThresholds: Int16Array | null;
  rules: RuleFlags;
  countdown: Countdown;
  weightsVer: number; // 0 = no weights loaded
  resultNo: number; // monotonic across all facilities
  provenance: Provenance;
  availability: "available" | "degraded" | "unavailable";
  /** Human-readable capability gap note, when a part of the contract cannot be honoured. */
  gapNote?: string;
}

/** Per-facility configuration derived from network.json + ops.json. */
export interface FacilityConfig {
  facilityId: FacilityId;
  systemId: SystemId;
  // Per-facility metadata (all must exist, be finite, positive where noted).
  B: number; // sum of well baseline_water_bpd (bbl/day) - must be > 0
  Q: number; // pump max_flow_bpd (bbl/day) - must be > 0
  C: number; // tank capacity_bbl - must be > 0
  W: number; // well count - must be >= 1
  P0: number; // system disposal_site pressure_psi
  shutdownLvl: number; // tank shutdown limit, 0.01 % (u16)
  warningLvl: number; // tank warning limit, 0.01 % (u16)
  // Bounds (i16 pairs) for the 7 facility readings + 2 well slots, from CONFIG.
  lo: number[];
  hi: number[];
  wellLo: number;
  wellHi: number;
  // Derived slot index (logical software API: unbounded; packed adapters enforce <= 31).
  slot: number;
  nWells: number;
}

/** Global run configuration (GLOBAL CONFIG record). */
export interface GlobalConfig {
  S: number; // feature shift for every M multiplier (0..S max)
  holdMax: number; // longest hold before history reset (2)
  cdLog2: number; // countdown window = 2^cdLog2 steps (4 -> 16)
  persistK: number; // consecutive steps to raise an alarm
  hbPeriodMs: number;
  hbTimeoutMs: number;
  logitThr: Int16Array; // per-class thresholds in logit units, handoff order
  gapThr: number; // leak flow-gap threshold, feature units (1/16384)
  streamEnable: boolean;
}

/** Model metadata. Unknown / missing => scores unavailable. */
export interface ModelMetadata {
  weightsVer: number;
  /** int16 weights: 4 classes x 31 features. null when not loaded. */
  weights: Int16Array | null;
  /** int32 biases: 4 classes. null when not loaded. */
  biases: Int32Array | null;
  outputShift: number; // S for the logistic head
  /** Source / version string for provenance reporting. */
  source?: string;
  loaded: boolean;
}

/** Capabilities reported by a runtime. */
export interface Capabilities {
  kind: "software" | "fpga";
  /** Max facilities the logical API supports (Infinity = unbounded). */
  maxFacilitiesLogical: number;
  /** Max wells per facility the logical API supports (Infinity = unbounded). */
  maxWellsPerFacilityLogical: number;
  /** Max facilities a packed (v1 wire) adapter can carry without rejection. */
  maxFacilitiesPacked: number;
  /** Max wells per facility a packed adapter can carry. */
  maxWellsPerFacilityPacked: number;
  /** Whether v1 wire codecs are available. */
  v1WireAvailable: boolean;
  /** Whether model weights can be loaded at runtime. */
  weightsLoadable: boolean;
  /** Whether countdown O7 correction is active. */
  countdownO7Correction: boolean;
  /** Known capability gaps (honest, not silent). */
  gaps: string[];
}

/** Snapshot for checkpoint / restore (rebuild state to a cutoff). */
export interface RunSnapshot {
  runId: string;
  configIdentity: string;
  cutoffTsUnix: number | null;
  facilities: Map<FacilityId, FacilityRunState>;
  globalResultNo: number;
  provenance: Provenance;
}

/** Internal per-facility run state (not part of the public wire contract). */
export interface FacilityRunState {
  facilityId: FacilityId;
  slot: number;
  lastTs: number | null;
  holdCount: number;
  fieldAges: Record<string, number>;
  sinceReset: number;
  // Last valid raw values (unscaled) for held fields.
  lastValid: {
    inflowBpd: number | null;
    levelPct: number | null;
    pumpStatus: number | null;
    pumpFlowBpd: number | null;
    receiveFlowBpd: number | null;
    dischargePsi: number | null;
    pipelinePsi: number | null;
    wellStatus: (number | null)[];
    wellWaterBpd: (number | null)[];
  };
  // Last running value of channels 1,2,3,5,6 (copied when pump running).
  lastRunning: Int16Array; // 5 values
  // Memory feature accumulators (int domain, matches features_int.py).
  fastE: Int32Array; // 5 accumulators
  slowE: Int32Array; // 5 accumulators
  smoothedNetFlowE: number;
  stepsSincePumpRan: number;
  hasRunSinceReset: boolean;
  memoryDepth: number;
  // Countdown ring (net inflow values), power-of-two size.
  netInflowRing: number[];
  ringPos: number;
  ringFilled: boolean;
  inflowRing: number[];
  inflowPos: number;
  inflowFilled: boolean;
  // Alarm persistence.
  persistCounters: number[]; // one per rule
  nightShiftLatched: boolean;
  eStopLatched: boolean;
}

/** Injectible monotonic clock for liveness (separate from replay "now"). */
export interface MonotonicClock {
  nowMs(): number;
}

/** Common runtime interface. Software and future FPGA adapters implement this. */
export interface Runtime {
  readonly id: string;
  readonly kind: "software" | "fpga";
  configure(config: DatasetConfig): void;
  ingest(record: TelemetryRecord): InferenceResult;
  ingestBatch(records: TelemetryRecord[]): InferenceResult[];
  reset(facilityId?: FacilityId): void;
  snapshot(): RunSnapshot;
  restore(snapshot: RunSnapshot): void;
  capabilities(): Capabilities;
  dispose(): void;
}

/** One logical telemetry record (decoded from CSV or wire). */
export interface TelemetryRecord {
  facilityId: FacilityId;
  tsUnix: number;
  present: PresentMask;
  inflowBpd: number | null;
  levelPct: number | null;
  pumpStatus: number | null; // 0,1,2
  pumpFlowBpd: number | null;
  receiveFlowBpd: number | null;
  dischargePsi: number | null;
  pipelinePsi: number | null;
  wellStatus: (number | null)[]; // 0,1 per well
  wellWaterBpd: (number | null)[];
}

export interface PresentMask {
  inflow: boolean;
  level: boolean;
  pumpStatus: boolean;
  pumpFlow: boolean;
  receiveFlow: boolean;
  discharge: boolean;
  pipeline: boolean;
  wellStatus: boolean[];
  wellWater: boolean[];
}

/** Full dataset configuration (network.json + ops.json + defaults). */
export interface DatasetConfig {
  datasetId: string;
  sourceFiles: { network: string; ops: string; telemetry: string };
  firstTsUnix: number;
  lastTsUnix: number;
  stepSeconds: number;
  systems: SystemConfig[];
  facilityById: Map<FacilityId, FacilityConfig>;
  global: GlobalConfig;
  model: ModelMetadata;
}

/** One system in config. */
export interface SystemConfig {
  systemId: SystemId;
  disposalPsi: number;
  facilities: FacilityConfig[];
  emergencyFleetSize: number;
  // ops per facility
  facilityOps: Map<FacilityId, { responseMin: number; cycleMin: number }>;
}
