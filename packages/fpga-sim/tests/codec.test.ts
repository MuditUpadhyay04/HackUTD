/**
 * v1 wire codec byte-level fixtures. Round-trip DATA and RESULT records,
 * verify header fields, and confirm explicit rejection of unrepresentable
 * values (fac_id > 31, >8 wells, non-finite, out-of-int16-range).
 */

import { describe, it, expect } from "bun:test";
import {
  encodeHeader, decodeHeader,
  encodeDataRecord, decodeDataRecord, withSlot,
  encodeResult, decodeResult,
  encodeFacilityConfig, encodeGlobalConfig,
  V1_MAX_FACILITIES, V1_MAX_WELLS_PER_FACILITY,
  V1_DATA_RECORD_BYTES, V1_RESULT_RECORD_BYTES, V1_HEADER_BYTES,
  V1CodecError,
} from "../src/codec/v1.ts";
import type { InferenceResult, ReasonBits } from "../src/types.ts";
import { STATUS } from "../src/types.ts";

function baseRecord(): any {
  return {
    facilityId: "5", // v1 slot 5
    tsUnix: 1791186900,
    present: {
      inflow: true, level: true, pumpStatus: true, pumpFlow: true,
      receiveFlow: true, discharge: true, pipeline: true,
      wellStatus: [true, true, true], wellWater: [true, true, true],
    },
    inflowBpd: 2400, levelPct: 50, pumpStatus: 1, pumpFlowBpd: 3000,
    receiveFlowBpd: 3000, dischargePsi: 1100, pipelinePsi: 1050,
    wellStatus: [1, 1, 1], wellWaterBpd: [800, 800, 800],
  };
}

describe("v1 codec — header", () => {
  it("encodes and decodes the 16-byte common header byte-for-byte", () => {
    const bytes = encodeHeader(1, 30, 12345, 0);
    expect(bytes.length).toBe(V1_HEADER_BYTES);
    const h = decodeHeader(bytes);
    expect(h.magicOk).toBe(true);
    expect(h.version).toBe(1);
    expect(h.type).toBe(1);
    expect(h.count).toBe(30);
    expect(h.seq).toBe(12345);
    expect(h.aux).toBe(0);
    // Magic bytes little-endian: 45 4F 47 46.
    expect(bytes[0]).toBe(0x45);
    expect(bytes[1]).toBe(0x4F);
    expect(bytes[2]).toBe(0x47);
    expect(bytes[3]).toBe(0x46);
  });

  it("rejects bad magic", () => {
    const bytes = new Uint8Array([0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(() => decodeHeader(bytes)).toThrow(V1CodecError);
  });

  it("rejects unsupported version", () => {
    const bytes = encodeHeader(1, 1, 1, 0);
    bytes[4] = 9; // version
    expect(() => decodeHeader(bytes)).toThrow(V1CodecError);
  });
});

describe("v1 codec — DATA record round-trip", () => {
  it("encodes a DATA record to exactly 48 bytes and decodes back", () => {
    const rec = withSlot(baseRecord(), 5);
    const bytes = encodeDataRecord(rec);
    expect(bytes.length).toBe(V1_DATA_RECORD_BYTES);
    const dec = decodeDataRecord(bytes);
    expect(dec.slot).toBe(5);
    expect(dec.facilityId).toBe("5");
    expect(dec.tsUnix).toBe(1791186900);
    expect(dec.present.inflow).toBe(true);
    expect(dec.inflowBpd).toBeCloseTo(2400);
    expect(dec.levelPct).toBeCloseTo(50);
    expect(dec.pumpStatus).toBe(1);
    expect(dec.pumpFlowBpd).toBeCloseTo(3000);
    expect(dec.receiveFlowBpd).toBeCloseTo(3000);
    expect(dec.dischargePsi).toBeCloseTo(1100);
    expect(dec.pipelinePsi).toBeCloseTo(1050);
    expect(dec.wellStatus.slice(0, 3)).toEqual([1, 1, 1]);
    expect(dec.wellWaterBpd.slice(0, 3)).toEqual([800, 800, 800]);
    // Wire is fixed at 8 slots; beyond configured count they are absent.
    expect(dec.wellStatus).toHaveLength(8);
    expect(dec.present.wellStatus[3]).toBe(false);
  });

  it("encodes absent fields with present bit cleared", () => {
    const rec = withSlot({ ...baseRecord(), present: { ...baseRecord().present, inflow: false, level: false }, inflowBpd: null, levelPct: null }, 3);
    const bytes = encodeDataRecord(rec);
    const dec = decodeDataRecord(bytes);
    expect(dec.present.inflow).toBe(false);
    expect(dec.present.level).toBe(false);
    expect(dec.inflowBpd).toBeNull();
    expect(dec.levelPct).toBeNull();
    // Other fields still present.
    expect(dec.present.pumpStatus).toBe(true);
  });

  it("round-trips negative int16 values", () => {
    const rec = withSlot({
      ...baseRecord(),
      inflowBpd: -100, dischargePsi: 900, pipelinePsi: 905,
    }, 2);
    const bytes = encodeDataRecord(rec);
    const dec = decodeDataRecord(bytes);
    expect(dec.inflowBpd).toBeCloseTo(-100);
    expect(dec.dischargePsi).toBeCloseTo(900);
    expect(dec.pipelinePsi).toBeCloseTo(905);
  });

  it("round-trips well status 2-bit packing", () => {
    const rec = withSlot({
      ...baseRecord(),
      wellStatus: [0, 1, 0, 1],
      present: {
        ...baseRecord().present,
        wellStatus: [true, true, true, true, false, false, false, false],
      },
    }, 7);
    const bytes = encodeDataRecord(rec);
    const dec = decodeDataRecord(bytes);
    expect(dec.wellStatus.slice(0, 4)).toEqual([0, 1, 0, 1]);
  });
});

describe("v1 codec — explicit rejection of unrepresentable values", () => {
  it("rejects fac_id > 31 on encode", () => {
    const rec = withSlot({ ...baseRecord(), __slotHint: 32 }, 32);
    expect(() => encodeDataRecord(rec)).toThrow(V1CodecError);
    // 31 is the max valid slot.
    const ok = withSlot({ ...baseRecord(), __slotHint: 31 }, 31);
    expect(() => encodeDataRecord(ok)).not.toThrow();
  });

  it("rejects >8 wells per facility (well arrays length)", () => {
    const rec = withSlot({
      ...baseRecord(),
      wellStatus: new Array(9).fill(1),
      wellWaterBpd: new Array(9).fill(100),
      present: {
        ...baseRecord().present,
        wellStatus: new Array(9).fill(true),
        wellWater: new Array(9).fill(true),
      },
    }, 1);
    expect(() => encodeDataRecord(rec)).toThrow(V1CodecError);
  });

  it("rejects non-finite values", () => {
    const rec = withSlot({ ...baseRecord(), inflowBpd: NaN }, 1);
    expect(() => encodeDataRecord(rec)).toThrow(V1CodecError);
    const rec2 = withSlot({ ...baseRecord(), inflowBpd: Infinity }, 1);
    expect(() => encodeDataRecord(rec2)).toThrow(V1CodecError);
  });

  it("rejects values outside int16 after quantization", () => {
    // inflow LSB 0.5 => int16 max 32767 => 16383.5 bpd max. 200000 bpd overflows.
    const rec = withSlot({ ...baseRecord(), inflowBpd: 200000 }, 1);
    expect(() => encodeDataRecord(rec)).toThrow(V1CodecError);
  });

  it("rejects illegal pump_status enum", () => {
    const rec = withSlot({ ...baseRecord(), pumpStatus: 9 }, 1);
    expect(() => encodeDataRecord(rec)).toThrow(V1CodecError);
  });

  it("decode rejects fac_id above v1 limit", () => {
    // Build a 48-byte buffer with fac_id = 40 (invalid).
    const bytes = new Uint8Array(V1_DATA_RECORD_BYTES);
    const dv = new DataView(bytes.buffer);
    dv.setUint16(0, 40, true); // fac_id
    expect(() => decodeDataRecord(bytes)).toThrow(V1CodecError);
  });
});

describe("v1 codec — RESULT record round-trip", () => {
  it("encodes and decodes a RESULT record byte-for-byte", () => {
    const res: InferenceResult = {
      facilityId: "3",
      tsUnix: 1791186900,
      status: STATUS.VALID,
      sinceReset: 5,
      reason: {
        fieldHeld: true, stepGapHeld: false, historyReset: false, outOfRange: false,
        illegalEnum: false, featureSaturated: false, pumpFlowInconsistent: false,
        wellInconsistent: false, duplicate: false, outOfOrder: false, unknownFacility: false,
      } as ReasonBits,
      channels: new Int16Array([16384, 0, -8192, 32767]),
      memoryFeatures: new Int16Array(31),
      logits: new Int16Array([100, -50, 200, 0]),
      logitThresholds: new Int16Array([0, 0, 0, 0]),
      rules: { pumpFault: true, shutIn: false, levelAtShutdown: true, levelAtWarning: false, notFilling: false },
      countdown: { p10: 120, p50: 240, p90: 360, notFilling: false },
      weightsVer: 7,
      resultNo: 42,
      provenance: "software",
      availability: "available",
    };
    const bytes = encodeResult(res);
    expect(bytes.length).toBe(V1_RESULT_RECORD_BYTES);
    const dec = decodeResult(bytes);
    expect(dec.facilityId).toBe("3");
    expect(dec.tsUnix).toBe(1791186900);
    expect(dec.status).toBe(STATUS.VALID);
    expect(dec.sinceReset).toBe(5);
    expect(dec.reason.fieldHeld).toBe(true);
    expect(dec.rules.pumpFault).toBe(true);
    expect(dec.rules.levelAtShutdown).toBe(true);
    expect(dec.countdown.p10).toBe(120);
    expect(dec.countdown.p50).toBe(240);
    expect(dec.countdown.p90).toBe(360);
    expect(dec.weightsVer).toBe(7);
    expect(dec.resultNo).toBe(42);
    expect(dec.provenance).toBe("fpga"); // wire decode is fpga-sourced
    // Logits preserved.
    expect(Array.from(dec.logits!)).toEqual([100, -50, 200, 0]);
  });

  it("encodes countdown not-filling sentinel 0xFFFF", () => {
    const res: InferenceResult = {
      facilityId: "1", tsUnix: 1, status: STATUS.VALID, sinceReset: 1,
      reason: { fieldHeld: false, stepGapHeld: false, historyReset: false, outOfRange: false,
        illegalEnum: false, featureSaturated: false, pumpFlowInconsistent: false,
        wellInconsistent: false, duplicate: false, outOfOrder: false, unknownFacility: false } as ReasonBits,
      channels: null, memoryFeatures: null, logits: null, logitThresholds: null,
      rules: { pumpFault: false, shutIn: false, levelAtShutdown: false, levelAtWarning: false, notFilling: true },
      countdown: { p10: 0xffff, p50: 0xffff, p90: 0xffff, notFilling: true },
      weightsVer: 0, resultNo: 1, provenance: "software", availability: "degraded",
    };
    const bytes = encodeResult(res);
    const dv = new DataView(bytes.buffer);
    expect(dv.getUint16(22, true)).toBe(0xffff);
    expect(dv.getUint16(24, true)).toBe(0xffff);
    expect(dv.getUint16(26, true)).toBe(0xffff);
  });

  it("rejects RESULT for a facility not v1-representable (non-numeric id)", () => {
    const res: InferenceResult = {
      facilityId: "not-a-slot" as any, tsUnix: 1, status: STATUS.VALID, sinceReset: 1,
      reason: { fieldHeld: false, stepGapHeld: false, historyReset: false, outOfRange: false,
        illegalEnum: false, featureSaturated: false, pumpFlowInconsistent: false,
        wellInconsistent: false, duplicate: false, outOfOrder: false, unknownFacility: false } as ReasonBits,
      channels: null, memoryFeatures: null, logits: null, logitThresholds: null,
      rules: { pumpFault: false, shutIn: false, levelAtShutdown: false, levelAtWarning: false, notFilling: false },
      countdown: { p10: 0, p50: 0, p90: 0, notFilling: false },
      weightsVer: 0, resultNo: 1, provenance: "software", availability: "available",
    };
    expect(() => encodeResult(res)).toThrow(V1CodecError);
  });
});

describe("v1 codec — CONFIG encode (bounded)", () => {
  it("encodes a facility config and rejects >8 wells", () => {
    const cfg = {
      facId: 0, nWells: 3, enabled: true, MInvB: 1000, MInvQ: 1000, MInvW: 1000, MNet: 1000,
      p0: 1050, shutdownLvl: 9200, warningLvl: 8500, kCd: 100,
      lo: [-32768, -32768, -32768, -32768, -32768, -32768, -32768],
      hi: [32767, 32767, 32767, 32767, 32767, 32767, 32767],
      wellLo: -32768, wellHi: 32767,
    };
    const bytes = encodeFacilityConfig(cfg);
    expect(bytes.length).toBe(64);

    const bad = { ...cfg, nWells: 9 };
    expect(() => encodeFacilityConfig(bad)).toThrow(V1CodecError);
  });

  it("encodes global config 32 bytes", () => {
    const bytes = encodeGlobalConfig({
      s: 9, holdMax: 2, cdLog2: 4, persistK: 3, hbPeriodMs: 1000, hbTimeoutMs: 5000,
      logitThr: [0, 0, 0, 0], gapThr: 0, streamEnable: true,
    });
    expect(bytes.length).toBe(32);
    expect(bytes[0]).toBe(9); // S
    expect(bytes[18]).toBe(1); // stream enable
  });
});
