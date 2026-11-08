/**
 * SoftwareRuntime: in-process software/CPU replacement for the FPGA inference
 * engine. Implements the common Runtime interface so a future FPGA adapter and
 * this software adapter share input/output semantics.
 *
 * Deterministic lifecycle: ingest(record) is a pure function of (config, prior
 * facility state, record). No system clock, no answer key, no hardcoded IDs.
 * Bad/missing data is never healthy. No weights => scores unavailable.
 *
 * Logical API supports an arbitrary number of facilities and wells (no 32/8
 * hardware limit). Packed v1-wire adapters enforce their own explicit limits.
 */

import type {
  DatasetConfig,
  FacilityConfig,
  FacilityRunState,
  GlobalConfig,
  InferenceResult,
  MonotonicClock,
  Provenance,
  ReasonBits,
  ResultStatus,
  Runtime,
  TelemetryRecord,
} from "./types.ts";
import { loadDatasetConfig, withModel, withSourceFiles, EMPTY_CONFIG } from "./config.ts";
import {
  CH,
  computeChannel11,
  computeChannels,
  initMemoryState,
  resetMemory,
  updateMemoryFeatures,
} from "./features.ts";
import { computeLogits, scoresAvailable, validateModel } from "./classifier.ts";
import { computeCountdown, initCountdownState } from "./countdown.ts";
import { computeRules } from "./rules.ts";
import { emptyReason, validateRecord } from "./validation.ts";
import { STATUS } from "./types.ts";

const RESULT_NOT_FILLING = 0xffff;
const SINCE_RESET_MAX = 255;
const DEFAULT_STEP_SECONDS = 300;

function nowProvenance(): Provenance {
  return "software";
}

/** Build a DROPPED result for an undeliverable record. */
function droppedResult(
  facilityId: string,
  tsUnix: number,
  reason: ReasonBits,
  resultNo: number,
): InferenceResult {
  return {
    facilityId,
    tsUnix,
    status: STATUS.DROPPED,
    sinceReset: 0,
    reason,
    channels: null,
    memoryFeatures: null,
    logits: null,
    logitThresholds: null,
    rules: {
      pumpFault: false,
      shutIn: false,
      levelAtShutdown: false,
      levelAtWarning: false,
      notFilling: false,
    },
    countdown: {
      p10: RESULT_NOT_FILLING,
      p50: RESULT_NOT_FILLING,
      p90: RESULT_NOT_FILLING,
      notFilling: true,
    },
    weightsVer: 0,
    resultNo,
    provenance: nowProvenance(),
    availability: "available",
    gapNote: "record dropped before inference (duplicate / out-of-order / unknown facility)",
  };
}

export interface SoftwareRuntimeOptions {
  /** Injectible monotonic clock for liveness (separate from replay "now"). */
  clock?: MonotonicClock;
  /** Allow overriding the step seconds (default 300). */
  stepSeconds?: number;
}

export class SoftwareRuntime implements Runtime {
  readonly id: string;
  readonly kind: "software" = "software";
  private config: DatasetConfig = EMPTY_CONFIG;
  private readonly clock: MonotonicClock;
  private readonly stepSeconds: number;
  private readonly states = new Map<string, FacilityRunState>();
  private globalResultNo = 0;
  private runId = "";
  private configIdentity = "";

  constructor(id: string = "software-runtime", options: SoftwareRuntimeOptions = {}) {
    this.id = id;
    this.clock = options.clock ?? { nowMs: () => Date.now() };
    this.stepSeconds = options.stepSeconds ?? DEFAULT_STEP_SECONDS;
  }

  /* ---- Lifecycle ---- */

  configure(config: DatasetConfig): void {
    const copy = structuredClone(config);
    copy.model = validateModel(copy.model);
    this.config = copy;
    this.runId = crypto.randomUUID();
    this.configIdentity = JSON.stringify(this.config, (_key, value) => value instanceof Map ? [...value.entries()] : ArrayBuffer.isView(value) ? Array.from(value as any) : value);
    this.globalResultNo = 0;
    this.states.clear();
    for (const f of config.facilityById.values()) {
      this.states.set(f.facilityId, this.newFacilityState(f));
    }
  }

  private newFacilityState(f: FacilityConfig): FacilityRunState {
    const mem = initMemoryState();
    const cd = initCountdownState(this.config.global.cdLog2);
    return {
      facilityId: f.facilityId,
      slot: f.slot,
      lastTs: null,
      holdCount: 0,
      fieldAges: {},
      sinceReset: 0,
      lastValid: {
        inflowBpd: null,
        levelPct: null,
        pumpStatus: null,
        pumpFlowBpd: null,
        receiveFlowBpd: null,
        dischargePsi: null,
        pipelinePsi: null,
        wellStatus: new Array(f.nWells).fill(null),
        wellWaterBpd: new Array(f.nWells).fill(null),
      },
      lastRunning: mem.lastRunning,
      fastE: mem.fastE,
      slowE: mem.slowE,
      smoothedNetFlowE: mem.smoothedNetFlowE,
      stepsSincePumpRan: mem.stepsSincePumpRan,
      hasRunSinceReset: mem.hasRunSinceReset,
      memoryDepth: mem.memoryDepth,
      netInflowRing: cd.ring,
      ringPos: cd.pos,
      ringFilled: cd.filled,
      inflowRing: [...cd.ring], inflowPos: 0, inflowFilled: false,
      persistCounters: new Array(5).fill(0),
      nightShiftLatched: false,
      eStopLatched: false,
    };
  }

  reset(facilityId?: string): void {
    if (facilityId) {
      const st = this.states.get(facilityId);
      if (st) this.resetFacilityState(st);
    } else {
      for (const st of this.states.values()) this.resetFacilityState(st);
      this.globalResultNo = 0;
      this.runId = crypto.randomUUID();
    }
  }

  private resetFacilityState(st: FacilityRunState): void {
    st.lastTs = null;
    st.holdCount = 0;
    st.fieldAges = {};
    st.sinceReset = 0;
    st.lastValid = {
      inflowBpd: null,
      levelPct: null,
      pumpStatus: null,
      pumpFlowBpd: null,
      receiveFlowBpd: null,
      dischargePsi: null,
      pipelinePsi: null,
      wellStatus: new Array(st.lastValid.wellStatus.length).fill(null),
      wellWaterBpd: new Array(st.lastValid.wellWaterBpd.length).fill(null),
    };
    resetMemory(st);
    const cd = initCountdownState(this.config.global.cdLog2);
    st.netInflowRing = cd.ring;
    st.ringPos = cd.pos;
    st.ringFilled = cd.filled;
    st.inflowRing = [...cd.ring]; st.inflowPos = 0; st.inflowFilled = false;
    st.persistCounters = new Array(5).fill(0);
    st.nightShiftLatched = false;
    st.eStopLatched = false;
  }

  /* ---- Core ingest ---- */

  ingest(record: TelemetryRecord): InferenceResult {
    return this.ingestBatch([record])[0];
  }

  ingestBatch(records: TelemetryRecord[]): InferenceResult[] {
    const results: InferenceResult[] = [];
    for (const record of records) {
      this.globalResultNo += 1;
      results.push(this.ingestOne(record, this.globalResultNo));
    }
    return results;
  }

  private ingestOne(record: TelemetryRecord, resultNo: number): InferenceResult {
    const cfg = this.config;
    const fac = cfg.facilityById.get(record.facilityId);
    const model = cfg.model;
    const logitThresholds = model.loaded ? new Int16Array(cfg.global.logitThr) : null;

    // Unknown facility.
    if (!fac) {
      return droppedResult(record.facilityId, record.tsUnix, { ...emptyReason(), unknownFacility: true }, resultNo);
    }

    const st = this.states.get(fac.facilityId)!;
    const prevTs = st.lastTs;

    // Duplicate / out of order => DROPPED, no state change.
    if (prevTs !== null) {
      if (record.tsUnix === prevTs) {
        return droppedResult(record.facilityId, record.tsUnix, { ...emptyReason(), duplicate: true }, resultNo);
      }
      if (record.tsUnix < prevTs) {
        return droppedResult(record.facilityId, record.tsUnix, { ...emptyReason(), outOfOrder: true }, resultNo);
      }
    }

    const val = validateRecord(record, fac, cfg.global, prevTs, st.lastValid, st.fieldAges, cfg.stepSeconds);

    if (val.status === STATUS.DROPPED) {
      return droppedResult(record.facilityId, record.tsUnix, val.reason, resultNo);
    }

    // Hold / reset decision.
    // Each missing/gap step counts toward the hold window; exceeding holdMax resets history.
    let status = val.status;
    if (val.reset || status === STATUS.INVALID) {
      // Reset feature history, but retain independently valid/held fields and ages.
      resetMemory(st);
      st.sinceReset = 0;
      const cd = initCountdownState(cfg.global.cdLog2);
      st.netInflowRing = cd.ring; st.ringPos = 0; st.ringFilled = false;
      st.inflowRing = [...cd.ring]; st.inflowPos = 0; st.inflowFilled = false;
      val.reason.historyReset = true;
    }
    st.fieldAges = val.nextAges;

    if (status === STATUS.INVALID) {
      const u = val.used;
      const rules = computeRules({ pumpStatus:u.pumpStatus, wellStatus:u.wellStatus, wellWaterBpd:u.wellWaterBpd, levelPct:u.levelPct, shutdownLvl:fac.shutdownLvl, warningLvl:fac.warningLvl, netInflowBpd:u.inflowBpd == null || u.pumpFlowBpd == null ? null : u.inflowBpd-u.pumpFlowBpd, nWells:fac.nWells });
      st.lastTs = record.tsUnix;
      st.lastValid = structuredClone(u);
      const countdown = u.levelPct != null && u.levelPct >= fac.shutdownLvl / 100 ? {p10:0,p50:0,p90:0,notFilling:false} : {p10:RESULT_NOT_FILLING,p50:RESULT_NOT_FILLING,p90:RESULT_NOT_FILLING,notFilling:false};
      return { ...droppedResult(record.facilityId, record.tsUnix, val.reason, resultNo), status, rules, countdown, availability:'unavailable', gapNote:'incomplete input: inference unavailable' };
    }
    // All values are known for VALID/HELD records.
    const used = val.used as { inflowBpd:number; levelPct:number; pumpStatus:number; pumpFlowBpd:number; receiveFlowBpd:number; dischargePsi:number; pipelinePsi:number; wellStatus:number[]; wellWaterBpd:number[] };

    // sinceReset increments on every accepted (non-dropped) record.
    st.sinceReset = Math.min(st.sinceReset + 1, SINCE_RESET_MAX);
    const isFirstAfterReset = st.sinceReset === 1;

    // Channel 11 needs level delta vs previous level. First record after reset => 0.
    let deltaLevelPct = 0;
    if (!isFirstAfterReset && !val.reset && st.lastValid.levelPct !== null) {
      deltaLevelPct = used.levelPct - st.lastValid.levelPct;
    }

    // 12 channels.
    const ch = computeChannels(
      used.inflowBpd, used.levelPct, used.pumpStatus, used.pumpFlowBpd,
      used.receiveFlowBpd, used.dischargePsi, used.pipelinePsi, used.wellStatus, used.wellWaterBpd,
      fac,
    );
    ch[CH.TANK_NET_FLOW_NORM] = computeChannel11(deltaLevelPct, fac);

    // Feature saturation reason when an out-of-range raw value saturated.
    if (val.reason.outOfRange) {
      let featureSaturated = false;
      for (let i = 0; i < ch.length; i++) {
        if (ch[i] === 32767 || ch[i] === -32768) {
          featureSaturated = true;
          break;
        }
      }
      if (featureSaturated) val.reason.featureSaturated = true;
    }

    // 19 memory features (full 31 vector).
    const running = used.pumpStatus === 1;
    const mem = updateMemoryFeatures(ch, running, st, st.sinceReset);

    // Classifier (null when no weights).
    const logits = scoresAvailable(model) ? computeLogits(mem, model) : null;

    // Rules.
    const netInflowBpd = used.inflowBpd - used.pumpFlowBpd;
    const rules = computeRules({
      pumpStatus: used.pumpStatus,
      wellStatus: used.wellStatus,
      wellWaterBpd: used.wellWaterBpd,
      levelPct: used.levelPct,
      shutdownLvl: fac.shutdownLvl,
      warningLvl: fac.warningLvl,
      netInflowBpd,
      nWells: fac.nWells,
    });

    // Persistence counters (alarm latching, software mirror of FPGA alarm stage).
    const persistK = cfg.global.persistK;
    const ruleBools = [
      rules.pumpFault,
      rules.shutIn,
      rules.levelAtShutdown,
      rules.levelAtWarning,
      rules.notFilling,
    ];
    for (let i = 0; i < 5; i++) {
      if (ruleBools[i]) {
        st.persistCounters[i] += 1;
        if (st.persistCounters[i] >= persistK) {
          if (i === 0) st.eStopLatched = true; // pump_fault
          if (i === 1) st.nightShiftLatched = true; // shut_in
        }
      } else {
        st.persistCounters[i] = 0;
      }
    }

    // Countdown with O7 host correction (uses pump_fault).
    // computeCountdown expects {ring, pos, filled}; map from facility state.
    const cdState = { ring: st.netInflowRing, pos: st.ringPos, filled: st.ringFilled, inflowRing: st.inflowRing, inflowPos: st.inflowPos, inflowFilled: st.inflowFilled };
    const countdown = computeCountdown(
      fac,
      cfg.global,
      cdState,
      used.inflowBpd,
      used.pumpFlowBpd,
      used.levelPct,
      rules.pumpFault,
    );
    // Persist ring mutation back (ring is a reference; pos/filled need reassignment).
    st.netInflowRing = cdState.ring;
    st.ringPos = cdState.pos;
    st.ringFilled = cdState.filled;
    st.inflowRing = cdState.inflowRing; st.inflowPos = cdState.inflowPos; st.inflowFilled = cdState.inflowFilled;

    // Update lastTs / lastValid for accepted record.
    st.lastTs = record.tsUnix;
    st.lastValid = structuredClone(used);

    const availability = model.loaded ? "available" : "degraded";
    const gapNote = model.loaded
      ? undefined
      : "no weights loaded: rule/countdown only; classifier scores unavailable";

    return {
      facilityId: record.facilityId,
      tsUnix: record.tsUnix,
      status,
      sinceReset: st.sinceReset,
      reason: val.reason,
      channels: ch,
      memoryFeatures: mem,
      logits,
      logitThresholds,
      rules,
      countdown,
      weightsVer: model.weightsVer,
      resultNo,
      provenance: nowProvenance(),
      availability,
      gapNote,
    };
  }

  /* ---- Snapshot / restore ---- */

  snapshot(): {
    runId: string;
    configIdentity: string;
    cutoffTsUnix: number | null;
    facilities: Map<string, FacilityRunState>;
    globalResultNo: number;
    provenance: Provenance;
  } {
    const facilities = new Map<string, FacilityRunState>();
    for (const [k, v] of this.states) {
      facilities.set(k, this.cloneFacilityState(v));
    }
    let cutoff = null;
    for (const st of this.states.values()) {
      if (st.lastTs !== null && (cutoff === null || st.lastTs > cutoff)) cutoff = st.lastTs;
    }
    return {
      runId: this.runId,
      configIdentity: this.configIdentity,
      cutoffTsUnix: cutoff,
      facilities,
      globalResultNo: this.globalResultNo,
      provenance: nowProvenance(),
    };
  }

  restore(snapshot: import('./types.ts').RunSnapshot): void {
    if (snapshot.runId !== this.runId || snapshot.configIdentity !== this.configIdentity || snapshot.provenance !== 'software' || !(snapshot.facilities instanceof Map) || snapshot.facilities.size !== this.config.facilityById.size || !Number.isSafeInteger(snapshot.globalResultNo) || snapshot.globalResultNo < 0) throw new Error('incompatible checkpoint');
    let cutoff: number | null = null;
    const restored = new Map<string, FacilityRunState>();
    for (const [k, v] of snapshot.facilities) {
      const fac = this.config.facilityById.get(k);
      if (!fac || v.facilityId !== k || v.slot !== fac.slot || v.lastValid.wellStatus.length !== fac.nWells || v.lastValid.wellWaterBpd.length !== fac.nWells || (v.lastTs !== null && (!Number.isSafeInteger(v.lastTs) || v.lastTs < this.config.firstTsUnix || v.lastTs > this.config.lastTsUnix))) throw new Error('invalid checkpoint state');
      if (v.lastTs !== null && (cutoff === null || v.lastTs > cutoff)) cutoff = v.lastTs;
      restored.set(k, this.cloneFacilityState(v));
    }
    if (cutoff !== snapshot.cutoffTsUnix) throw new Error('invalid checkpoint cutoff');
    this.states.clear();
    for (const [k,v] of restored) this.states.set(k,v);
    this.globalResultNo = snapshot.globalResultNo;
  }

  private cloneFacilityState(st: FacilityRunState): FacilityRunState {
    return {
      facilityId: st.facilityId,
      slot: st.slot,
      lastTs: st.lastTs,
      holdCount: st.holdCount,
      fieldAges: {...st.fieldAges},
      sinceReset: st.sinceReset,
      lastValid: {
        inflowBpd: st.lastValid.inflowBpd,
        levelPct: st.lastValid.levelPct,
        pumpStatus: st.lastValid.pumpStatus,
        pumpFlowBpd: st.lastValid.pumpFlowBpd,
        receiveFlowBpd: st.lastValid.receiveFlowBpd,
        dischargePsi: st.lastValid.dischargePsi,
        pipelinePsi: st.lastValid.pipelinePsi,
        wellStatus: [...st.lastValid.wellStatus],
        wellWaterBpd: [...st.lastValid.wellWaterBpd],
      },
      lastRunning: new Int16Array(st.lastRunning),
      fastE: new Int32Array(st.fastE),
      slowE: new Int32Array(st.slowE),
      smoothedNetFlowE: st.smoothedNetFlowE,
      stepsSincePumpRan: st.stepsSincePumpRan,
      hasRunSinceReset: st.hasRunSinceReset,
      memoryDepth: st.memoryDepth,
      netInflowRing: [...st.netInflowRing],
      ringPos: st.ringPos,
      ringFilled: st.ringFilled,
      inflowRing: [...st.inflowRing], inflowPos: st.inflowPos, inflowFilled: st.inflowFilled,
      persistCounters: [...st.persistCounters],
      nightShiftLatched: st.nightShiftLatched,
      eStopLatched: st.eStopLatched,
    };
  }

  /* ---- Capabilities ---- */

  capabilities(): {
    kind: "software";
    maxFacilitiesLogical: number;
    maxWellsPerFacilityLogical: number;
    maxFacilitiesPacked: number;
    maxWellsPerFacilityPacked: number;
    v1WireAvailable: boolean;
    weightsLoadable: boolean;
    countdownO7Correction: boolean;
    gaps: string[];
  } {
    const gaps: string[] = [];
    if (!this.config.model.loaded) {
      gaps.push("no weights loaded: classifier scores unavailable (rules/countdown only)");
    }
    gaps.push("float feature formulas do not reproduce unconfirmed fixed-point multipliers or golden vectors");
    gaps.push("countdown uses host O7 inflow-only correction; not a claimed FPGA parity fix");
    gaps.push("v1 packed adapters support at most 32 facilities / 8 wells per facility");
    return {
      kind: "software",
      maxFacilitiesLogical: Infinity,
      maxWellsPerFacilityLogical: Infinity,
      maxFacilitiesPacked: 32, // u16 wire field, hardware slots 0..31
      maxWellsPerFacilityPacked: 8,
      v1WireAvailable: false,
      weightsLoadable: true,
      countdownO7Correction: true,
      gaps,
    };
  }

  dispose(): void {
    this.states.clear();
    this.globalResultNo = 0;
  }
}

/** Load a dataset from file paths (network.json, ops.json) plus telemetry bounds. */
export async function loadDatasetFromFiles(
  networkPath: string,
  opsPath: string,
  firstTsUnix: number,
  lastTsUnix: number,
  stepSeconds?: number,
): Promise<DatasetConfig> {
  const [networkText, opsText] = await Promise.all([
    fetch(networkPath).then((r) => r.text()),
    fetch(opsPath).then((r) => r.text()),
  ]);
  const network = JSON.parse(networkText);
  const ops = JSON.parse(opsText);
  return withSourceFiles(
    loadDatasetConfig(network, ops, firstTsUnix, lastTsUnix, stepSeconds),
    { network: networkPath, ops: opsPath, telemetry: "" },
  );
}

/** Re-export the config type for consumers. */
export type { DatasetConfig } from "./types.ts";

/** Build a DatasetConfig from already-parsed JSON objects. */
export function buildDatasetConfig(
  network: unknown,
  ops: unknown,
  firstTsUnix: number,
  lastTsUnix: number,
  stepSeconds?: number,
): DatasetConfig {
  return loadDatasetConfig(network, ops, firstTsUnix, lastTsUnix, stepSeconds);
}
