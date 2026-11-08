/**
 * Per-record validation. Produces ResultStatus + ReasonBits for one facility record,
 * and decides which fields to hold (last valid value) vs reset.
 *
 * Policy (FPGA bad-data, Sat 20:00):
 *  - Missing / out-of-range / illegal enum => treated as missing, then hold <= 2
 *    steps, then history reset.
 *  - Duplicate (same ts) => dropped, counted.
 *  - Out of order (ts < prev) => dropped, counted.
 *  - Gap (> step) => hold up to holdMax, then reset.
 *  - Out-of-range => treated as missing (hold/reset path), never fed as real reading.
 *  - Pump/flow inconsistency (pump off but flow > 0) => flagged only, never clamped.
 *  - Well status/water inconsistency => flagged only.
 *  - Bad/missing data is never reported healthy.
 */

import type { FacilityConfig, GlobalConfig, ReasonBits, ResultStatus, TelemetryRecord } from "./types.ts";

const STEP_TOLERANCE = 0; // exact step match expected; duplicates/out-of-order/gap detected by delta

export interface ValidationOutcome {
  status: ResultStatus;
  reason: ReasonBits;
  /** Number of steps skipped (0 = clean, 1 = duplicate/adjacent, >1 = gap). */
  gapSteps: number;
  /** Whether to hold (reuse last valid) rather than reset. */
  hold: boolean;
  /** Whether to reset history after this record. */
  reset: boolean;
  /** Filled-in values used for feature computation (last valid for held fields). */
  used: {
    inflowBpd: number;
    levelPct: number;
    pumpStatus: number;
    pumpFlowBpd: number;
    receiveFlowBpd: number;
    dischargePsi: number;
    pipelinePsi: number;
    wellStatus: number[];
    wellWaterBpd: number[];
  };
}

export function emptyReason(): ReasonBits {
  return {
    fieldHeld: false,
    stepGapHeld: false,
    historyReset: false,
    outOfRange: false,
    illegalEnum: false,
    featureSaturated: false,
    pumpFlowInconsistent: false,
    wellInconsistent: false,
    duplicate: false,
    outOfOrder: false,
    unknownFacility: false,
  };
}

export function validateRecord(
  record: TelemetryRecord,
  cfg: FacilityConfig | null,
  global: GlobalConfig,
  prevTs: number | null,
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
  },
): ValidationOutcome {
  const reason = emptyReason();
  const nWells = cfg ? cfg.nWells : 0;
  const step = global.holdMax > 0 ? (record as any).__stepSeconds ?? 300 : 300;

  // Unknown facility => DROPPED.
  if (!cfg) {
    reason.unknownFacility = true;
    return {
      status: 4 as ResultStatus, // DROPPED
      reason,
      gapSteps: 0,
      hold: false,
      reset: false,
      used: zeroUsed(nWells),
    };
  }

  // Duplicate detection.
  if (prevTs !== null && record.tsUnix === prevTs) {
    reason.duplicate = true;
    return {
      status: 4 as ResultStatus,
      reason,
      gapSteps: 1,
      hold: false,
      reset: false,
      used: zeroUsed(nWells),
    };
  }

  // Out of order.
  if (prevTs !== null && record.tsUnix < prevTs) {
    reason.outOfOrder = true;
    return {
      status: 4 as ResultStatus,
      reason,
      gapSteps: 0,
      hold: false,
      reset: false,
      used: zeroUsed(nWells),
    };
  }

  // Step gap: delta != step.
  let gapSteps = 0;
  if (prevTs !== null) {
    const delta = record.tsUnix - prevTs;
    if (delta !== step) {
      gapSteps = Math.round(delta / step);
      if (gapSteps > 1) reason.stepGapHeld = true;
    }
  }

  // Range / enum checks per field, build "present & valid" mask.
  const checkRange = (v: number | null, lo: number, hi: number): { ok: boolean; used: number } => {
    if (v === null) return { ok: false, used: 0 };
    if (v < lo || v > hi) {
      return { ok: false, used: 0 }; // out of range => treated as missing
    }
    return { ok: true, used: v };
  };

  const inflowOk = checkRange(record.inflowBpd, cfg.lo[0], cfg.hi[0]);
  const levelOk = checkRange(record.levelPct, cfg.lo[1], cfg.hi[1]);
  const pumpFlowOk = checkRange(record.pumpFlowBpd, cfg.lo[3], cfg.hi[3]);
  const receiveFlowOk = checkRange(record.receiveFlowBpd, cfg.lo[4], cfg.hi[4]);
  const dischargeOk = checkRange(record.dischargePsi, cfg.lo[5], cfg.hi[5]);
  const pipelineOk = checkRange(record.pipelinePsi, cfg.lo[6], cfg.hi[6]);

  // Pump status enum.
  let pumpStatusOk = false;
  let pumpStatusUsed = 0;
  if (record.pumpStatus === null) {
    pumpStatusOk = false;
  } else if (record.pumpStatus === 0 || record.pumpStatus === 1 || record.pumpStatus === 2) {
    pumpStatusOk = true;
    pumpStatusUsed = record.pumpStatus;
  } else {
    reason.illegalEnum = true;
    pumpStatusOk = false;
  }

  // Well statuses.
  const wellStatusUsed: number[] = [];
  let wellStatusAllOk = true;
  for (let i = 0; i < nWells; i++) {
    const v = record.wellStatus[i];
    if (v === null || v < 0 || v > 1) {
      reason.illegalEnum = true;
      wellStatusAllOk = false;
      wellStatusUsed.push(0);
    } else {
      wellStatusUsed.push(v);
    }
  }
  const wellWaterUsed: number[] = [];
  let wellWaterAllOk = true;
  for (let i = 0; i < nWells; i++) {
    const v = record.wellWaterBpd[i];
    if (v === null || v < cfg.wellLo || v > cfg.wellHi) {
      if (v !== null) reason.outOfRange = true;
      wellWaterAllOk = false;
      wellWaterUsed.push(0);
    } else {
      wellWaterUsed.push(v);
    }
  }

  // Any field out of range => flag.
  if (
    !inflowOk.ok || !levelOk.ok || !pumpFlowOk.ok || !receiveFlowOk.ok ||
    !dischargeOk.ok || !pipelineOk.ok || !wellWaterAllOk
  ) {
    reason.outOfRange = true;
  }

  // Cross-field consistency flags (flagged only, never clamped).
  if (pumpStatusUsed === 0 && pumpFlowOk.ok && pumpFlowOk.used > 0) {
    reason.pumpFlowInconsistent = true;
  }
  if (pumpStatusUsed === 2 && pumpFlowOk.ok && pumpFlowOk.used > 0) {
    reason.pumpFlowInconsistent = true;
  }
  for (let i = 0; i < nWells; i++) {
    const ws = wellStatusUsed[i];
    const ww = wellWaterUsed[i];
    if (ws === 0 && ww > 0) {
      reason.wellInconsistent = true;
    }
    if (ws === 1 && ww === 0) {
      // producing well with zero water - flag but allow (could be real).
    }
  }

  // Decide hold vs reset. Hold up to holdMax consecutive bad/gap steps.
  const anyMissing = !inflowOk.ok || !levelOk.ok || !pumpStatusOk || !pumpFlowOk.ok ||
    !receiveFlowOk.ok || !dischargeOk.ok || !pipelineOk.ok || !wellStatusAllOk || !wellWaterAllOk;

  let hold = false;
  let reset = false;

  if (gapSteps > 1) {
    // A gap: hold if within holdMax, else reset.
    // holdCount tracked by caller; here we signal gap.
    hold = true; // caller increments holdCount and decides reset
    reason.stepGapHeld = true;
  } else if (anyMissing) {
    hold = true;
    reason.fieldHeld = true;
  }

  // Build used values: last valid for held/missing, actual for present.
  const used: ValidationOutcome["used"] = {
    inflowBpd: inflowOk.ok ? inflowOk.used : (lastValid.inflowBpd ?? 0),
    levelPct: levelOk.ok ? levelOk.used : (lastValid.levelPct ?? 0),
    pumpStatus: pumpStatusOk ? pumpStatusUsed : (lastValid.pumpStatus ?? 0),
    pumpFlowBpd: pumpFlowOk.ok ? pumpFlowOk.used : (lastValid.pumpFlowBpd ?? 0),
    receiveFlowBpd: receiveFlowOk.ok ? receiveFlowOk.used : (lastValid.receiveFlowBpd ?? 0),
    dischargePsi: dischargeOk.ok ? dischargeOk.used : (lastValid.dischargePsi ?? 0),
    pipelinePsi: pipelineOk.ok ? pipelineOk.used : (lastValid.pipelinePsi ?? 0),
    wellStatus: wellStatusUsed.map((v, i) => v !== 0 || wellStatusAllOk ? v : (lastValid.wellStatus[i] ?? 0)),
    wellWaterBpd: wellWaterUsed.map((v, i) => v !== 0 || wellWaterAllOk ? v : (lastValid.wellWaterBpd[i] ?? 0)),
  };

  // Status: if any missing/out-of-range/illegal => HELD (still producing, flagged).
  // If reset pending (gap > holdMax handled by caller), INVALID.
  // Clean record => VALID.
  let status: ResultStatus = 0 as ResultStatus; // VALID
  if (anyMissing || reason.stepGapHeld || reason.illegalEnum || reason.outOfRange) {
    status = 1 as ResultStatus; // HELD
  }

  return { status, reason, gapSteps, hold, reset, used };
}

function zeroUsed(nWells: number): ValidationOutcome["used"] {
  return {
    inflowBpd: 0,
    levelPct: 0,
    pumpStatus: 0,
    pumpFlowBpd: 0,
    receiveFlowBpd: 0,
    dischargePsi: 0,
    pipelinePsi: 0,
    wellStatus: new Array(nWells).fill(0),
    wellWaterBpd: new Array(nWells).fill(0),
  };
}
