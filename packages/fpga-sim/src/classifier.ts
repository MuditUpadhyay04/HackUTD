/**
 * Four independent logistic regressions in order
 * [pipeline_leak, pump_degradation, pump_failure, facility_shut_in].
 *
 * int16 weights, int32 biases, 48-bit accumulator, one output shift:
 *   logit = sat16((sum w_i * x_i + b + 2^(S-1)) >> S)
 *
 * No weights loaded => scores unavailable (logits null, weightsVer 0). We never
 * fabricate calibrated confidence or 0.5 probabilities. Sigmoid/thresholding is a
 * server-side concern (Mudit contract); this layer returns raw int16 logits only.
 */

import type { ModelMetadata } from "./types.ts";

const ACCUMULATOR_BITS = 48;
const MAX_ACCUMULATOR = 1n << BigInt(ACCUMULATOR_BITS - 1); // 2^47, safety bound
const FEATURE_COUNT = 31;
const CLASS_COUNT = 4;

function sat16(v: number): number {
  if (v < -32768) return -32768;
  if (v > 32767) return 32767;
  return Math.trunc(v);
}

function bigIntSat16(v: bigint): number {
  const min = BigInt(-32768);
  const max = BigInt(32767);
  if (v < min) return -32768;
  if (v > max) return 32767;
  return Number(v);
}

/** Validate model metadata shape. Returns a normalized metadata or throws. */
export function validateModel(meta: ModelMetadata): ModelMetadata {
  if (!meta.loaded) {
    return { ...meta, weights: null, biases: null, weightsVer: 0, loaded: false };
  }
  if (!meta.weights || !meta.biases) {
    throw new Error("[fpga-sim/classifier] model marked loaded but weights/biases missing");
  }
  if (meta.weights.length !== CLASS_COUNT * FEATURE_COUNT) {
    throw new Error(
      `[fpga-sim/classifier] expected ${CLASS_COUNT * FEATURE_COUNT} weights, got ${meta.weights.length}`,
    );
  }
  if (meta.biases.length !== CLASS_COUNT) {
    throw new Error(`[fpga-sim/classifier] expected ${CLASS_COUNT} biases, got ${meta.biases.length}`);
  }
  return meta;
}

/**
 * Compute 4 int16 logits from the full 31-feature int16 vector. Returns null when
 * no weights are loaded. Does not apply sigmoid.
 */
export function computeLogits(
  features: Int16Array,
  model: ModelMetadata,
): Int16Array | null {
  if (!model.loaded || !model.weights || !model.biases) {
    return null;
  }

  const logits = new Int16Array(CLASS_COUNT);
  const roundBits = 1n << BigInt(model.outputShift - 1); // 2^(S-1); if S=0 this is 0.5-> handled below
  const shift = model.outputShift;

  for (let c = 0; c < CLASS_COUNT; c++) {
    let acc = BigInt(model.biases[c]);
    const base = c * FEATURE_COUNT;
    let overflow = false;
    for (let i = 0; i < FEATURE_COUNT; i++) {
      acc += BigInt(model.weights[base + i]) * BigInt(features[i]);
      if (acc > MAX_ACCUMULATOR || acc < -MAX_ACCUMULATOR) {
        overflow = true;
        break;
      }
    }
    if (overflow) {
      // Saturate rather than wrap: hardware guarantees no overflow, but software is
      // more general (unbounded topology). Report saturation via clamp.
      acc = acc > 0 ? MAX_ACCUMULATOR : -MAX_ACCUMULATOR;
    }
    // round-shift: (acc + 2^(S-1)) >> S, arithmetic
    let shifted: bigint;
    if (shift <= 0) {
      shifted = acc;
    } else {
      shifted = (acc + roundBits) >> BigInt(shift);
    }
    logits[c] = bigIntSat16(shifted);
  }
  return logits;
}

/** Whether a classifier can produce scores right now. */
export function scoresAvailable(model: ModelMetadata): boolean {
  return Boolean(model.loaded && model.weights && model.biases);
}
