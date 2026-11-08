/**
 * @hackutd/fpga-sim — public API.
 *
 * Reusable TypeScript software/CPU replacement for the FPGA inference runtime.
 * Standalone in-process library with explicit common runtime contracts and a thin
 * v1 wire-codec boundary. No Elysia server, DB, React, model training, or board
 * deployment.
 *
 * The logical software API supports an arbitrary number of facilities and wells.
 * Packed v1-wire adapters enforce the per-config hardware limits (32 facilities,
 * 8 wells per facility) explicitly and reject unrepresentable values.
 *
 * Honesty guarantees:
 *  - No weights loaded => scores unavailable (never fabricated confidence).
 *  - Bad/missing data is never healthy (status + reason bits on every result).
 *  - Countdown uses the documented host O7 correction, not a claimed FPGA fix.
 *  - Round-to-even quantization; not bit-exact with planned features_int.py
 *    (round-half-up sat16). Differences are reported as capability gaps.
 */

// ---- Types & contracts ----
export type {
  DatasetConfig,
  FacilityConfig,
  GlobalConfig,
  ModelMetadata,
  SystemConfig,
  TelemetryRecord,
  PresentMask,
  InferenceResult,
  ReasonBits,
  RuleFlags,
  Countdown,
  ResultStatus,
  Provenance,
  Runtime,
  Capabilities,
  RunSnapshot,
  FacilityRunState,
} from "./types.ts";

export { STATUS, COUNTDOWN_NOT_FILLING } from "./types.ts";

// ---- Features ----
export {
  CH,
  MEM,
  computeChannels,
  computeChannel11,
  quantize,
  initMemoryState,
  resetMemory,
  updateMemoryFeatures,
} from "./features.ts";

// ---- Classifier ----
export { computeLogits, scoresAvailable, validateModel } from "./classifier.ts";

// ---- Countdown ----
export {
  computeCountdown,
  initCountdownState,
  resetCountdownState,
  COUNTDOWN_NOT_FILLING as CD_NOT_FILLING,
} from "./countdown.ts";

// ---- Rules ----
export { computeRules } from "./rules.ts";

// ---- Validation ----
export { emptyReason, validateRecord } from "./validation.ts";

// ---- Runtime ----
export {
  SoftwareRuntime,
  type SoftwareRuntimeOptions,
  buildDatasetConfig,
  loadDatasetFromFiles,
} from "./runtime.ts";

// ---- v1 wire codec (packed adapter — bounded by v1 hardware limits) ----
export {
  V1CodecError,
  V1_MAX_FACILITIES,
  V1_MAX_FACILITY_SLOT,
  V1_MAX_WELLS_PER_FACILITY,
  V1_DATA_RECORD_BYTES,
  V1_RESULT_RECORD_BYTES,
  V1_HEADER_BYTES,
  V1_MAX_DATA_PER_PACKET,
  V1_MAX_RESULT_PER_PACKET,
  type V1Header,
  type DecodedDataRecord,
  type V1FacilityConfigWire,
  type V1GlobalConfigWire,
  encodeHeader,
  decodeHeader,
  encodeDataRecord,
  decodeDataRecord,
  withSlot,
  encodeResult,
  decodeResult,
  encodeFacilityConfig,
  encodeGlobalConfig,
} from "./codec/v1.ts";
