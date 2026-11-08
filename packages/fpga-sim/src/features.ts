/**
 * Feature computation: 12 channels + 19 memory features (31 total), matching the
 * FPGA memory feature set v1.
 *
 * Channels are the documented float formulas (handoff section 4), then quantized to
 * int16 at scale 1/16384 with round-half-up and saturation to [-2, 2). Memory
 * features run in the integer domain using arithmetic right shift (>> in JS =
 * sign-propagating = rounds toward -inf), matching the plan's `>>>` semantics.
 *
 * Capability note: features_int.py (the bit-exact integer reference, planned but not
 * written) uses sat16((raw·M + 2^(S-1)) >> S) = round-half-up per channel. This
 * software build quantizes float channels directly, not via CONFIG multipliers.
 * We do not claim bit-exact parity.
 */

import type { FacilityConfig, GlobalConfig } from "./types.ts";

const SCALE = 16384;
const INT16_MIN = -32768;
const INT16_MAX = 32767;

/** Channel index constants (handoff order). */
export const CH = {
  INFLOW_NORM: 0,
  PUMP_FLOW_NORM: 1,
  RECEIVE_FLOW_NORM: 2,
  FLOW_GAP_NORM: 3,
  TANK_FRACTION: 4,
  DISCHARGE_OFFSET_NORM: 5,
  PIPELINE_OFFSET_NORM: 6,
  PUMP_RUNNING: 7,
  PUMP_FAULT: 8,
  WELLS_ACTIVE_FRACTION: 9,
  WELL_WATER_NORM: 10,
  TANK_NET_FLOW_NORM: 11,
  COUNT: 12,
} as const;

/** Memory feature indices. The full vector is 31: 12 channels + 19 memory. */
export const MEM = {
  LAST_RUNNING_START: 12, // 12..16: last running value of ch 1,2,3,5,6
  FAST_MEAN_START: 17, // 17..21: fast running mean (alpha 1/8) of same 5
  SLOW_MEAN_START: 22, // 22..26: slow running mean (alpha 1/64) of same 5
  SMOOTHED_NET_FLOW: 27, // smoothed tank net flow (ch 11, alpha 1/8)
  STEPS_SINCE_PUMP_RAN: 28, // min(n,64)<<8
  HAS_RUN_SINCE_RESET: 29, // 0 or 16384
  MEMORY_DEPTH: 30, // min(since_reset,64)<<8
  COUNT: 19,
} as const;

const RUNNING_CHANNELS = [1, 2, 3, 5, 6]; // pump_flow, receive_flow, flow_gap, discharge_offset, pipeline_offset

function sat16(v: number): number {
  if (v < INT16_MIN) return INT16_MIN;
  if (v > INT16_MAX) return INT16_MAX;
  return Math.trunc(v);
}

/** Round half upward, then saturate to int16. Scale 1/16384. */
export function quantize(x: number): number {
  return sat16(Math.round(x * SCALE));
}

/** Arithmetic right shift (sign-propagating, rounds toward -inf). JS `>>`. */
function arsh(v: number, n: number): number {
  return v >> n;
}

/** Compute the 12 current channels as int16. Returns null fields as 0 with no saturation flag here;
 *  the caller (runtime) decides HELD/INVALID handling. */
export function computeChannels(
  inflowBpd: number,
  levelPct: number,
  pumpStatus: number,
  pumpFlowBpd: number,
  receiveFlowBpd: number,
  dischargePsi: number,
  pipelinePsi: number,
  wellStatus: number[],
  wellWaterBpd: number[],
  cfg: FacilityConfig,
): Int16Array {
  const ch = new Int16Array(CH.COUNT);

  const B = cfg.B;
  const Q = cfg.Q;
  const C = cfg.C;
  const P0 = cfg.P0;
  const W = cfg.W;

  const wellStatusSum = wellStatus.reduce((a, b) => a + b, 0);
  const wellWaterSum = wellWaterBpd.reduce((a, b) => a + b, 0);

  ch[CH.INFLOW_NORM] = quantize(inflowBpd / B);
  ch[CH.PUMP_FLOW_NORM] = quantize(pumpFlowBpd / Q);
  ch[CH.RECEIVE_FLOW_NORM] = quantize(receiveFlowBpd / Q);
  ch[CH.FLOW_GAP_NORM] = quantize((pumpFlowBpd - receiveFlowBpd) / Q);
  ch[CH.TANK_FRACTION] = quantize(levelPct / 100);
  ch[CH.DISCHARGE_OFFSET_NORM] = quantize((dischargePsi - P0) / 150);
  ch[CH.PIPELINE_OFFSET_NORM] = quantize((pipelinePsi - P0) / 50);
  ch[CH.PUMP_RUNNING] = pumpStatus === 1 ? 16384 : 0; // 1.0 at scale
  ch[CH.PUMP_FAULT] = pumpStatus === 2 ? 16384 : 0;
  ch[CH.WELLS_ACTIVE_FRACTION] = quantize(wellStatusSum / W);
  ch[CH.WELL_WATER_NORM] = quantize(wellWaterSum / B);

  // tank_net_flow_norm needs previous level; caller passes deltaLevel = levelPct - prevLevelPct.
  // Here we accept levelPct directly and the caller pre-computes delta. To keep this signature simple,
  // the delta form is handled by computeChannel11 below.
  ch[CH.TANK_NET_FLOW_NORM] = 0; // filled by caller via setChannel11
  return ch;
}

/** Channel 11: tank net flow from level delta. First record of a history => 0. */
export function computeChannel11(deltaLevelPct: number, cfg: FacilityConfig): number {
  return quantize((deltaLevelPct * cfg.C * 288) / (100 * cfg.B));
}

/** Initialize memory feature state for a facility. */
export function initMemoryState(): {
  lastRunning: Int16Array; // 5 values (ch 1,2,3,5,6)
  fastE: Int32Array; // 5 accumulators
  slowE: Int32Array; // 5 accumulators
  smoothedNetFlowE: number;
  stepsSincePumpRan: number;
  hasRunSinceReset: boolean;
  memoryDepth: number;
} {
  return {
    lastRunning: new Int16Array(5),
    fastE: new Int32Array(5),
    slowE: new Int32Array(5),
    smoothedNetFlowE: 0,
    stepsSincePumpRan: 0,
    hasRunSinceReset: false,
    memoryDepth: 0,
  };
}

/**
 * Update memory features for one record. Returns the full 31-feature int16 vector
 * (channels 0-11 + memory 12-30).
 *
 * `running` = pump status == 1 for this record. Held records update memory like
 * normal records. On reset, call resetMemory() first.
 */
export function updateMemoryFeatures(
  ch: Int16Array,
  running: boolean,
  state: ReturnType<typeof initMemoryState>,
  sinceReset: number,
): Int16Array {
  const mem = new Int16Array(31);

  // 0-11: current channels.
  for (let i = 0; i < 12; i++) mem[i] = ch[i];

  // 12-16: last running value of channels 1,2,3,5,6 (copied when pump running).
  const isFirstRunning = running && !state.hasRunSinceReset;
  if (running) state.hasRunSinceReset = true;
  if (running) {
    for (let k = 0; k < 5; k++) {
      state.lastRunning[k] = ch[RUNNING_CHANNELS[k]];
    }
  }
  for (let k = 0; k < 5; k++) mem[MEM.LAST_RUNNING_START + k] = state.lastRunning[k];

  // 17-21 fast mean, 22-26 slow mean of the same 5 channels.
  // Plan: on the first running record after a reset, both moving averages are set
  // to x << 8 so they don't start biased toward 0.
  for (let k = 0; k < 5; k++) {
    const x = ch[RUNNING_CHANNELS[k]];
    if (running) {
      if (isFirstRunning) {
        state.fastE[k] = x << 8;
        state.slowE[k] = x << 8;
      } else {
        // e += ((x << 8) - e) >>> n ; feature = e >>> n
        // fast: n=3, slow: n=6
        const fastRaw = (x << 8) - state.fastE[k];
        state.fastE[k] += arsh(fastRaw, 3);
        const slowRaw = (x << 8) - state.slowE[k];
        state.slowE[k] += arsh(slowRaw, 6);
      }
      mem[MEM.FAST_MEAN_START + k] = arsh(state.fastE[k], 8);
      mem[MEM.SLOW_MEAN_START + k] = arsh(state.slowE[k], 8);
    } else {
      // Not running: averages hold last value (update only on running records).
      mem[MEM.FAST_MEAN_START + k] = arsh(state.fastE[k], 8);
      mem[MEM.SLOW_MEAN_START + k] = arsh(state.slowE[k], 8);
    }
  }

  // 27: smoothed tank net flow (ch 11, alpha 1/8), every record.
  const netRaw = (ch[CH.TANK_NET_FLOW_NORM] << 8) - state.smoothedNetFlowE;
  state.smoothedNetFlowE += arsh(netRaw, 3);
  mem[MEM.SMOOTHED_NET_FLOW] = arsh(state.smoothedNetFlowE, 8);

  // 28: steps since pump last ran: +1 per record; 0 on running records. Cap at 64<<8.
  if (running) {
    state.stepsSincePumpRan = 0;
  } else {
    state.stepsSincePumpRan = Math.min(state.stepsSincePumpRan + 1, 64);
  }
  mem[MEM.STEPS_SINCE_PUMP_RAN] = state.stepsSincePumpRan << 8;

  // 29: has run since reset: 0 or 16384. Set on first running record.
  if (running) state.hasRunSinceReset = true;
  mem[MEM.HAS_RUN_SINCE_RESET] = state.hasRunSinceReset ? 16384 : 0;

  // 30: memory depth: min(since_reset, 64) << 8. +1 per record.
  state.memoryDepth = Math.min(state.memoryDepth + 1, 64);
  mem[MEM.MEMORY_DEPTH] = state.memoryDepth << 8;

  return mem;
}

/** Reset all memory (called on history reset). */
export function resetMemory(state: ReturnType<typeof initMemoryState>): void {
  state.lastRunning.fill(0);
  state.fastE.fill(0);
  state.slowE.fill(0);
  state.smoothedNetFlowE = 0;
  state.stepsSincePumpRan = 0;
  state.hasRunSinceReset = false;
  state.memoryDepth = 0;
}
