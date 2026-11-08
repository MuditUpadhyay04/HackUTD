/**
 * v1 wire codec — packed adapter boundary.
 *
 * Matches the FPGA wire layouts byte-for-byte (little-endian). This is a
 * *packed adapter*: it enforces the per-config hardware limits (fac_id 5-bit,
 * slots 0..31; <=8 wells per facility) and rejects unrepresentable values
 * explicitly. It never silently revises the hardware protocol, and never claims
 * that extended topology (>32 facilities / >8 wells) is compatible with v1
 * hardware. The logical software API (SoftwareRuntime) supports arbitrary counts;
 * this codec is the bounded translation layer.
 *
 * Layouts (all little-endian, signed fields two's complement):
 *  - Common header 16B: magic u32, version u8, type u8, count u16, seq u32, aux u32
 *  - DATA 48B / RESULT 32B / ALERT 16B / STATS 64B / GLOBAL CONFIG 32B /
 *    Facility CONFIG 64B / CONFIG_ACK 8B / HEARTBEAT (header only)
 *
 * Magic: 0x46474F45 ("EOGF" little-endian bytes: 45 4F 47 46)
 */

import type { InferenceResult, ReasonBits, TelemetryRecord } from "../types.ts";

const MAGIC = 0x46474f45;
const VERSION = 1;

const T_DATA = 1;
const T_RESULT = 2;
const T_ALERT = 3;
const T_CONFIG = 4;
const T_STATS = 8;

const STATUS_VALID = 0;
const STATUS_HELD = 1;
const STATUS_INVALID = 3;
const STATUS_DROPPED = 4;

export const V1_MAX_FACILITIES = 32;
export const V1_MAX_FACILITY_SLOT = 31;
export const V1_MAX_WELLS_PER_FACILITY = 8;
export const V1_DATA_RECORD_BYTES = 48;
export const V1_RESULT_RECORD_BYTES = 32;
export const V1_HEADER_BYTES = 16;
export const V1_MAX_DATA_PER_PACKET = 30;
export const V1_MAX_RESULT_PER_PACKET = 45;

export class V1CodecError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "V1CodecError";
  }
}

function u8(b: DataView, o: number): number { return b.getUint8(o); }
function u16(b: DataView, o: number): number { return b.getUint16(o, true); }
function u32(b: DataView, o: number): number { return b.getUint32(o, true); }
function i16(b: DataView, o: number): number { return b.getInt16(o, true); }
function writeU8(b: DataView, o: number, v: number): void { b.setUint8(o, v); }
function writeU16(b: DataView, o: number, v: number): void { b.setUint16(o, v, true); }
function writeU32(b: DataView, o: number, v: number): void { b.setUint32(o, v, true); }
function writeI16(b: DataView, o: number, v: number): void { b.setInt16(o, v, true); }
function dv(bytes: Uint8Array): DataView { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }

const LSB = { inflowBpd: 0.5, levelPct: 0.01, pumpFlowBpd: 0.5, receiveFlowBpd: 0.5,
  dischargePsi: 0.1, pipelinePsi: 0.1, wellWaterBpd: 0.5 };

function toI16(v: number, field: string): number {
  if (!Number.isFinite(v)) throw new V1CodecError("unrepresentable", `${field}: non-finite ${v}`);
  const q = Math.trunc(Math.round(v));
  if (q < -32768 || q > 32767) throw new V1CodecError("unrepresentable", `${field}: ${v} (q=${q}) outside int16`);
  return q;
}

export interface V1Header { version: number; type: number; count: number; seq: number; aux: number; magicOk: boolean; }

export function encodeHeader(type: number, count: number, seq: number, aux: number): Uint8Array {
  const buf = new Uint8Array(V1_HEADER_BYTES);
  const v = dv(buf);
  writeU32(v, 0, MAGIC);
  writeU8(v, 4, VERSION);
  writeU8(v, 5, type);
  writeU16(v, 6, count);
  writeU32(v, 8, seq);
  writeU32(v, 12, aux);
  return buf;
}

export function decodeHeader(bytes: Uint8Array): V1Header {
  if (bytes.length < V1_HEADER_BYTES) throw new V1CodecError("truncated", `header needs ${V1_HEADER_BYTES}B, got ${bytes.length}`);
  const v = dv(bytes);
  const magic = u32(v, 0);
  if (magic !== MAGIC) throw new V1CodecError("bad_magic", `expected 0x${MAGIC.toString(16)}, got 0x${magic.toString(16)}`);
  const version = u8(v, 4);
  if (version !== VERSION) throw new V1CodecError("bad_version", `expected v${VERSION}, got v${version}`);
  return { version, type: u8(v, 5), count: u16(v, 6), seq: u32(v, 8), aux: u32(v, 12), magicOk: true };
}

const PRESENT_BITS = ["inflow","level","pumpStatus","pumpFlow","discharge","receiveFlow","pipeline"] as const;

export interface DecodedDataRecord extends TelemetryRecord { slot: number; }

export function decodeDataRecord(bytes: Uint8Array): DecodedDataRecord {
  if (bytes.length < V1_DATA_RECORD_BYTES) throw new V1CodecError("truncated", `DATA needs ${V1_DATA_RECORD_BYTES}B, got ${bytes.length}`);
  const v = dv(bytes);
  const slot = u16(v, 0);
  if (slot > V1_MAX_FACILITY_SLOT) throw new V1CodecError("bad_slot", `fac_id ${slot} > v1 limit ${V1_MAX_FACILITY_SLOT}`);
  const ts = u32(v, 4);
  const present = u32(v, 8);
  const wellStatus: (number|null)[] = [];
  const wellStatusPresent: boolean[] = [];
  const wellWaterBpd: (number|null)[] = [];
  const wellWaterPresent: boolean[] = [];
  const wsPacked = u16(v, 26);
  for (let i = 0; i < 8; i++) {
    wellStatusPresent[i] = (present & (1 << (8 + i))) !== 0;
    wellStatus[i] = wellStatusPresent[i] ? ((wsPacked >> (2 * i)) & 3) : null;
    wellWaterPresent[i] = (present & (1 << (16 + i))) !== 0;
    wellWaterBpd[i] = wellWaterPresent[i] ? i16(v, 28 + i * 2) * LSB.wellWaterBpd : null;
  }
  return {
    facilityId: String(slot), tsUnix: ts,
    present: {
      inflow: (present & 1) !== 0, level: (present & 2) !== 0, pumpStatus: (present & 4) !== 0,
      pumpFlow: (present & 8) !== 0, receiveFlow: (present & 32) !== 0, discharge: (present & 16) !== 0,
      pipeline: (present & 64) !== 0, wellStatus: wellStatusPresent, wellWater: wellWaterPresent,
    },
    inflowBpd: (present & 1) ? i16(v, 12) * LSB.inflowBpd : null,
    levelPct: (present & 2) ? i16(v, 14) * LSB.levelPct : null,
    pumpStatus: (present & 4) ? u8(v, 24) : null,
    pumpFlowBpd: (present & 8) ? i16(v, 16) * LSB.pumpFlowBpd : null,
    receiveFlowBpd: (present & 32) ? i16(v, 18) * LSB.receiveFlowBpd : null,
    dischargePsi: (present & 16) ? i16(v, 20) * LSB.dischargePsi : null,
    pipelinePsi: (present & 64) ? i16(v, 22) * LSB.pipelinePsi : null,
    wellStatus, wellWaterBpd, slot,
  } as DecodedDataRecord;
}

export function encodeDataRecord(rec: TelemetryRecord): Uint8Array {
  const buf = new Uint8Array(V1_DATA_RECORD_BYTES);
  const v = dv(buf);
  const slot = (rec as any).__slotHint ?? 0;
  if (!Number.isInteger(slot) || slot < 0 || slot > V1_MAX_FACILITY_SLOT) throw new V1CodecError("bad_slot", `fac_id ${slot} outside 0..${V1_MAX_FACILITY_SLOT}`);
  if ([rec.wellStatus.length, rec.wellWaterBpd.length, rec.present.wellStatus.length, rec.present.wellWater.length].some(n => n > 8)) throw new V1CodecError("bad_wells", "v1 supports at most 8 well slots");
  writeU16(v, 0, slot);
  writeU16(v, 2, 0);
  writeU32(v, 4, rec.tsUnix);
  let present = 0;
  if (rec.present.inflow) present |= 1 << 0;
  if (rec.present.level) present |= 1 << 1;
  if (rec.present.pumpStatus) present |= 1 << 2;
  if (rec.present.pumpFlow) present |= 1 << 3;
  if (rec.present.discharge) present |= 1 << 4;
  if (rec.present.receiveFlow) present |= 1 << 5;
  if (rec.present.pipeline) present |= 1 << 6;
  for (let i = 0; i < rec.present.wellStatus.length; i++) if (rec.present.wellStatus[i]) present |= 1 << (8 + i);
  for (let i = 0; i < rec.present.wellWater.length; i++) if (rec.present.wellWater[i]) present |= 1 << (16 + i);
  writeU32(v, 8, present);
  writeI16(v, 12, toI16((rec.inflowBpd ?? 0) / LSB.inflowBpd, "inflow_bpd"));
  writeI16(v, 14, toI16((rec.levelPct ?? 0) / LSB.levelPct, "level_pct"));
  writeI16(v, 16, toI16((rec.pumpFlowBpd ?? 0) / LSB.pumpFlowBpd, "pump_flow_bpd"));
  writeI16(v, 18, toI16((rec.receiveFlowBpd ?? 0) / LSB.receiveFlowBpd, "receive_flow_bpd"));
  writeI16(v, 20, toI16((rec.dischargePsi ?? 0) / LSB.dischargePsi, "discharge_psi"));
  writeI16(v, 22, toI16((rec.pipelinePsi ?? 0) / LSB.pipelinePsi, "pipeline_psi"));
  const ps = rec.pumpStatus ?? 0;
  if (ps < 0 || ps > 2) throw new V1CodecError("illegal_enum", `pump_status ${ps} not in {0,1,2}`);
  writeU8(v, 24, ps);
  writeU8(v, 25, 0);
  let wsPacked = 0;
  for (let i = 0; i < 8; i++) {
    const s = rec.wellStatus[i];
    if (s === null || s === undefined) continue;
    if (s < 0 || s > 3) throw new V1CodecError("illegal_enum", `well_status[${i}] ${s} not in 0..3`);
    wsPacked |= (s & 3) << (2 * i);
  }
  writeU16(v, 26, wsPacked);
  for (let i = 0; i < 8; i++) writeI16(v, 28 + i * 2, toI16((rec.wellWaterBpd[i] ?? 0) / LSB.wellWaterBpd, `well_water_bpd[${i}]`));
  writeU32(v, 44, 0);
  return buf;
}

export function withSlot(rec: TelemetryRecord, slot: number): TelemetryRecord {
  return { ...rec, __slotHint: slot } as TelemetryRecord;
}

export function encodeResult(res: InferenceResult): Uint8Array {
  const buf = new Uint8Array(V1_RESULT_RECORD_BYTES);
  const v = dv(buf);
  const slot = Number(res.facilityId);
  if (!Number.isInteger(slot) || slot < 0 || slot > V1_MAX_FACILITY_SLOT) throw new V1CodecError("bad_slot", `facility ${res.facilityId} not v1-representable`);
  writeU16(v, 0, slot);
  writeU8(v, 2, res.status);
  writeU8(v, 3, res.sinceReset);
  writeU32(v, 4, res.tsUnix);
  const r = res.reason;
  let reasonBits = 0;
  const bits = [r.fieldHeld, r.stepGapHeld, r.historyReset, r.outOfRange, r.illegalEnum,
    r.featureSaturated, r.pumpFlowInconsistent, r.wellInconsistent, r.duplicate, r.outOfOrder, r.unknownFacility];
  for (let i = 0; i < bits.length; i++) if (bits[i]) reasonBits |= 1 << i;
  writeU32(v, 8, reasonBits >>> 0);
  // RESULT bytes 12..18 are the 4 logits (not channels).
  if (res.logits) for (let i = 0; i < 4; i++) writeI16(v, 12 + i * 2, res.logits[i] ?? 0);
  else for (let i = 0; i < 4; i++) writeI16(v, 12 + i * 2, 0);
  let rulesByte = 0;
  if (res.rules.pumpFault) rulesByte |= 1 << 0;
  if (res.rules.shutIn) rulesByte |= 1 << 1;
  if (res.rules.levelAtShutdown) rulesByte |= 1 << 2;
  if (res.rules.levelAtWarning) rulesByte |= 1 << 3;
  if (res.rules.notFilling) rulesByte |= 1 << 4;
  writeU8(v, 20, rulesByte);
  writeU8(v, 21, res.weightsVer);
  writeU16(v, 22, res.countdown.p10);
  writeU16(v, 24, res.countdown.p50);
  writeU16(v, 26, res.countdown.p90);
  writeU32(v, 28, res.resultNo);
  return buf;
}

export function decodeResult(bytes: Uint8Array): InferenceResult {
  if (bytes.length < V1_RESULT_RECORD_BYTES) throw new V1CodecError("truncated", `RESULT needs ${V1_RESULT_RECORD_BYTES}B, got ${bytes.length}`);
  const v = dv(bytes);
  const slot = u16(v, 0);
  const status = u8(v, 2);
  const sinceReset = u8(v, 3);
  const ts = u32(v, 4);
  const reasonBits = u32(v, 8);
  const logits = new Int16Array([i16(v, 12), i16(v, 14), i16(v, 16), i16(v, 18)]);
  const rulesByte = u8(v, 20);
  const weightsVer = u8(v, 21);
  const p10 = u16(v, 22), p50 = u16(v, 24), p90 = u16(v, 26);
  const resultNo = u32(v, 28);
  const reason: ReasonBits = {
    fieldHeld: (reasonBits & 1) !== 0, stepGapHeld: (reasonBits & 2) !== 0,
    historyReset: (reasonBits & 4) !== 0, outOfRange: (reasonBits & 8) !== 0,
    illegalEnum: (reasonBits & 16) !== 0, featureSaturated: (reasonBits & 32) !== 0,
    pumpFlowInconsistent: (reasonBits & 64) !== 0, wellInconsistent: (reasonBits & 128) !== 0,
    duplicate: (reasonBits & 256) !== 0, outOfOrder: (reasonBits & 512) !== 0,
    unknownFacility: (reasonBits & 1024) !== 0,
  };
  return {
    facilityId: String(slot), tsUnix: ts, status: status as 0 | 1 | 2 | 3 | 4, sinceReset,
    reason,
    channels: null, memoryFeatures: null, logits, logitThresholds: null,
    rules: {
      pumpFault: (rulesByte & 1) !== 0, shutIn: (rulesByte & 2) !== 0,
      levelAtShutdown: (rulesByte & 4) !== 0, levelAtWarning: (rulesByte & 8) !== 0,
      notFilling: (rulesByte & 16) !== 0,
    },
    countdown: { p10, p50, p90, notFilling: p10 === 0xffff && p50 === 0xffff && p90 === 0xffff },
    weightsVer, resultNo, provenance: "fpga", availability: "available",
  } as InferenceResult;
}

export interface V1FacilityConfigWire {
  facId: number; nWells: number; enabled: boolean; MInvB: number; MInvQ: number;
  MInvW: number; MNet: number; p0: number; shutdownLvl: number; warningLvl: number;
  kCd: number; lo: number[]; hi: number[]; wellLo: number; wellHi: number;
}

export function encodeFacilityConfig(cfg: V1FacilityConfigWire): Uint8Array {
  if (!Number.isInteger(cfg.facId) || cfg.facId < 0 || cfg.facId > V1_MAX_FACILITY_SLOT) throw new V1CodecError("bad_slot", `fac_id ${cfg.facId} outside v1 slots`);
  if (cfg.nWells < 1 || cfg.nWells > V1_MAX_WELLS_PER_FACILITY) throw new V1CodecError("bad_wells", `n_wells ${cfg.nWells} outside 1..${V1_MAX_WELLS_PER_FACILITY}`);
  const buf = new Uint8Array(64);
  const v = dv(buf);
  writeU16(v, 0, cfg.facId);
  writeU8(v, 2, cfg.nWells);
  writeU8(v, 3, cfg.enabled ? 1 : 0);
  writeU32(v, 4, cfg.MInvB >>> 0);
  writeU32(v, 8, cfg.MInvQ >>> 0);
  writeU32(v, 12, cfg.MInvW >>> 0);
  writeU32(v, 16, cfg.MNet >>> 0);
  // P0 wire field is 0.1 psi; p0 is supplied in actual psi.
  writeI16(v, 20, toI16(cfg.p0 / 0.1, "P0"));
  // shutdown/warning lvl are already in 0.01% units (matching FacilityConfig).
  writeU16(v, 22, toI16(cfg.shutdownLvl, "shutdown_lvl"));
  writeU16(v, 24, toI16(cfg.warningLvl, "warning_lvl"));
  writeU16(v, 26, 0);
  writeU32(v, 28, cfg.kCd >>> 0);
  for (let i = 0; i < 7; i++) writeI16(v, 32 + i * 2, toI16(cfg.lo[i], `lo[${i}]`));
  for (let i = 0; i < 7; i++) writeI16(v, 46 + i * 2, toI16(cfg.hi[i], `hi[${i}]`));
  writeI16(v, 60, toI16(cfg.wellLo, "well_lo"));
  writeI16(v, 62, toI16(cfg.wellHi, "well_hi"));
  return buf;
}

export interface V1GlobalConfigWire {
  s: number; holdMax: number; cdLog2: number; persistK: number;
  hbPeriodMs: number; hbTimeoutMs: number; logitThr: number[]; gapThr: number; streamEnable: boolean;
}

export function encodeGlobalConfig(cfg: V1GlobalConfigWire): Uint8Array {
  const buf = new Uint8Array(32);
  const v = dv(buf);
  writeU8(v, 0, cfg.s);
  writeU8(v, 1, cfg.holdMax);
  writeU8(v, 2, cfg.cdLog2);
  writeU8(v, 3, cfg.persistK);
  writeU16(v, 4, cfg.hbPeriodMs);
  writeU16(v, 6, cfg.hbTimeoutMs);
  for (let i = 0; i < 4; i++) writeI16(v, 8 + i * 2, toI16(cfg.logitThr[i], `logit_thr[${i}]`));
  writeI16(v, 16, toI16(cfg.gapThr, "gap_thr"));
  writeU8(v, 18, cfg.streamEnable ? 1 : 0);
  return buf;
}
