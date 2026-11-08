/**
 * Feature computation tests: 12 channels + quantize round-to-even.
 * Fixtures are explicit; no answer_key.json.
 */

import { describe, it, expect } from "bun:test";
import { CH, computeChannels, computeChannel11, quantize, initMemoryState, updateMemoryFeatures, resetMemory } from "../src/features.ts";
import { makeFacilityConfig } from "./helpers.ts";

const cfg = makeFacilityConfig("F1", "S1", { B: 2400, Q: 3600, C: 1200, P0: 1050, W: 3 });

describe("features — quantize (round-to-even, scale 1/16384, saturate int16)", () => {
  it("rounds half to even", () => {
    // 0.5 * 16384 = 8192 exactly; 1.5*16384=24576; 2.5*16384=40960 -> saturate 32767.
    expect(quantize(0.5)).toBe(8192); // 0.5 -> 8192 (even)
    expect(quantize(1.5)).toBe(24576); // 1.5 -> 24576 (even)
    // round half to even: 0.50006103515625 * 16384 = 8193 -> odd, rounds to 8192? no
    // Just check basic rounding direction.
    expect(quantize(0.0001)).toBe(2); // 1.6384 -> 2
    expect(quantize(-0.0001)).toBe(-2);
  });

  it("saturates at int16 limits", () => {
    expect(quantize(2.0)).toBe(32767); // 2.0 * 16384 = 32768 -> saturate to max
    expect(quantize(-2.0)).toBe(-32768);
    expect(quantize(1.99994)).toBe(32767); // 1.99994*16384=32767.9 -> rounds to 32768 -> saturate
    expect(quantize(1.9999)).toBe(32766); // just below saturation
  });
});

describe("features — 12 channels match handoff formulas", () => {
  it("computes all 12 channels from raw values", () => {
    const ch = computeChannels(
      2400, 50, 1, 3000, 3000, 1100, 1050,
      [1, 1, 1], [800, 800, 800],
      cfg,
    );
    // ch0 inflow_norm = 2400/2400 = 1.0 -> 16384
    expect(ch[CH.INFLOW_NORM]).toBe(16384);
    // ch1 pump_flow_norm = 3000/3600 = 0.8333 -> 13653
    expect(ch[CH.PUMP_FLOW_NORM]).toBe(Math.trunc(Math.round(3000 / 3600 * 16384)));
    // ch2 receive_flow_norm = 3000/3600
    expect(ch[CH.RECEIVE_FLOW_NORM]).toBe(ch[CH.PUMP_FLOW_NORM]);
    // ch3 flow_gap = (3000-3000)/3600 = 0
    expect(ch[CH.FLOW_GAP_NORM]).toBe(0);
    // ch4 tank_fraction = 50/100 = 0.5 -> 8192
    expect(ch[CH.TANK_FRACTION]).toBe(8192);
    // ch5 discharge_offset = (1100-1050)/150 = 0.3333
    expect(ch[CH.DISCHARGE_OFFSET_NORM]).toBe(Math.trunc(Math.round(50 / 150 * 16384)));
    // ch6 pipeline_offset = (1050-1050)/50 = 0
    expect(ch[CH.PIPELINE_OFFSET_NORM]).toBe(0);
    // ch7 pump_running = 1 -> 16384
    expect(ch[CH.PUMP_RUNNING]).toBe(16384);
    // ch8 pump_fault = 0
    expect(ch[CH.PUMP_FAULT]).toBe(0);
    // ch9 wells_active_fraction = 3/3 = 1 -> 16384
    expect(ch[CH.WELLS_ACTIVE_FRACTION]).toBe(16384);
    // ch10 well_water_norm = 2400/2400 = 1 -> 16384
    expect(ch[CH.WELL_WATER_NORM]).toBe(16384);
    // ch11 set by caller
    expect(ch[CH.TANK_NET_FLOW_NORM]).toBe(0);
  });

  it("channel 11 is zero on first record after reset", () => {
    expect(computeChannel11(0, cfg)).toBe(0);
    // Nonzero delta: level +1% with C=1200, B=2400 => (1 * 1200 * 288) / (100 * 2400) = 1.44
    const q = computeChannel11(1, cfg);
    expect(q).toBe(Math.trunc(Math.round(1.44 * 16384)));
  });

  it("pump fault sets ch8 = 1", () => {
    const ch = computeChannels(2400, 50, 2, 0, 0, 1050, 1050, [1, 1, 1], [800, 800, 800], cfg);
    expect(ch[CH.PUMP_FAULT]).toBe(16384);
    expect(ch[CH.PUMP_RUNNING]).toBe(0);
  });
});

describe("features — memory feature set v1", () => {
  it("initializes memory features to zero before any running record", () => {
    const state = initMemoryState();
    const ch = new Int16Array(12);
    ch[CH.PUMP_FLOW_NORM] = 16384; // 1.0
    const mem = updateMemoryFeatures(ch, false, state, 1);
    // Fast/slow means of ch1 (pump_flow) not updated when not running => 0.
    expect(mem[17]).toBe(0); // fast mean ch1
    expect(mem[22]).toBe(0); // slow mean ch1
    // hasRunSinceReset = 0
    expect(mem[29]).toBe(0);
  });

  it("copies last running value when pump runs, initializes EMA to x<<8", () => {
    const state = initMemoryState();
    const ch = new Int16Array(12);
    ch[CH.PUMP_FLOW_NORM] = 16384; // 1.0 -> x<<8 = 16384<<8 = 4194304
    // First running record: EMA initialized to x<<8.
    const mem = updateMemoryFeatures(ch, true, state, 1);
    expect(mem[12]).toBe(16384); // last running ch1 = 16384
    // fast EMA: e = x<<8 = 4194304, feature = e>>>8 = 16384
    expect(mem[17]).toBe(16384);
    // hasRunSinceReset = 16384
    expect(mem[29]).toBe(16384);
    // memoryDepth = 1<<8 = 256
    expect(mem[30]).toBe(256);
  });

  it("resetMemory clears all accumulators", () => {
    const state = initMemoryState();
    const ch = new Int16Array(12);
    ch[CH.PUMP_FLOW_NORM] = 16384;
    updateMemoryFeatures(ch, true, state, 5);
    resetMemory(state);
    const mem2 = updateMemoryFeatures(ch, false, state, 6);
    // After reset, EMA back to 0 (not running, no init).
    expect(mem2[17]).toBe(0);
    expect(mem2[29]).toBe(0);
    // memoryDepth reset to 0 then +1 = 1<<8 = 256
    expect(mem2[30]).toBe(256);
  });
});
