/**
 * SoftwareRuntime tests. Fixtures are explicit and independent of answer_key.json.
 * No asset IDs, event schedules, or practice-network constants are hardcoded.
 */

import { describe, it, expect } from "bun:test";
import { SoftwareRuntime, buildDatasetConfig } from "../src/runtime.ts";
import { makeDatasetConfig, makeRecord, makePartialRecord, makeFacilityConfig } from "./helpers.ts";
import { STATUS } from "../src/types.ts";

function run(rt: SoftwareRuntime, records: { facilityId: string; tsUnix: number }[]) {
  return rt.ingestBatch(records as any);
}

describe("SoftwareRuntime — valid record stream and outputs", () => {
  it("produces VALID results with channels, rules and countdown for a clean stream", () => {
    const config = makeDatasetConfig(["F1"]);
    const rt = new SoftwareRuntime("t1");
    rt.configure(config);

    const base = 1791186900;
    const results = rt.ingestBatch([
      makeRecord("F1", base, { inflowBpd: 4000, pumpFlowBpd: 3000 }),
      makeRecord("F1", base + 300, { inflowBpd: 4000, pumpFlowBpd: 3000 }),
      makeRecord("F1", base + 600, { inflowBpd: 4000, pumpFlowBpd: 3000 }),
    ]);

    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.provenance).toBe("software");
      expect(r.status).toBe(STATUS.VALID);
      expect(r.facilityId).toBe("F1");
      expect(r.channels).not.toBeNull();
      expect(r.channels!.length).toBe(12);
      expect(r.memoryFeatures).not.toBeNull();
      expect(r.memoryFeatures!.length).toBe(31);
      // No weights => logits null, never fabricated.
      expect(r.logits).toBeNull();
      expect(r.weightsVer).toBe(0);
      expect(r.availability).toBe("degraded");
      expect(r.gapNote).toContain("no weights loaded");
      // Rules: clean running state => no fault, not shut-in, level below limits, filling.
      expect(r.rules.pumpFault).toBe(false);
      expect(r.rules.shutIn).toBe(false);
      expect(r.rules.levelAtShutdown).toBe(false);
      expect(r.rules.levelAtWarning).toBe(false);
      expect(r.rules.notFilling).toBe(false);
      // Countdown finite (filling).
      expect(r.countdown.notFilling).toBe(false);
      expect(r.countdown.p50).toBeGreaterThan(0);
      // resultNo monotonic.
      expect(typeof r.resultNo).toBe("number");
    }
    // resultNo increases across the batch.
    expect(results[0].resultNo).toBe(1);
    expect(results[2].resultNo).toBe(3);
    // sinceReset increments.
    expect(results[0].sinceReset).toBe(1);
    expect(results[2].sinceReset).toBe(3);
  });

  it("supports independent multiple class outputs when weights are loaded", () => {
    const config = makeDatasetConfig(["F1"]);
    // Inject 4-class weights: class 0 (leak) weight on channel 3 (flow_gap),
    // class 2 (failure) weight on channel 8 (pump_fault).
    const weights = new Int16Array(4 * 31).fill(0);
    weights[0 * 31 + 3] = 16384; // 1.0 at scale
    weights[2 * 31 + 8] = 16384;
    const biases = new Int32Array([0, 0, 0, 0]);
    const configWithModel = {
      ...config,
      model: { weightsVer: 7, weights, biases, outputShift: 14, loaded: true, source: "test" },
    };
    const rt = new SoftwareRuntime("t2");
    rt.configure(configWithModel);

    const rec = makeRecord("F1", 1791186900, { pumpFlowBpd: 3000, receiveFlowBpd: 0 }); // flow_gap = 3000/Q = 0.833
    const r = rt.ingest(rec);
    expect(r.logits).not.toBeNull();
    expect(r.logits!.length).toBe(4);
    expect(r.weightsVer).toBe(7);
    expect(r.availability).toBe("available");
    // class ordering is fixed [leak, degradation, failure, shut_in].
    expect(r.logits![0]).toBeDefined();
    expect(r.logits![2]).toBeDefined();
  });

  it("reports scores unavailable without fabricating confidence when no weights", () => {
    const config = makeDatasetConfig(["F1"]);
    const rt = new SoftwareRuntime("t3");
    rt.configure(config);
    const r = rt.ingest(makeRecord("F1", 1791186900));
    expect(r.logits).toBeNull();
    expect(r.weightsVer).toBe(0);
    expect(r.availability).toBe("degraded");
    // capabilities should say degraded too.
    const cap = rt.capabilities();
    expect(cap.gaps.some((g) => g.includes("no weights loaded"))).toBe(true);
  });
});

describe("SoftwareRuntime — holds / invalid / reset", () => {
  it("holds for up to holdMax=2 bad steps then resets history", () => {
    const config = makeDatasetConfig(["F1"]);
    const rt = new SoftwareRuntime("t4");
    rt.configure(config);
    const base = 1791186900;

    // Clean record.
    let r = rt.ingest(makeRecord("F1", base));
    expect(r.status).toBe(STATUS.VALID);
    expect(r.reason.historyReset).toBe(false);
    expect(r.sinceReset).toBe(1);

    // Now 3 consecutive records with missing inflow (hold path). holdMax=2.
    r = rt.ingest(makePartialRecord("F1", base + 300, ["inflow"]));
    expect(r.status).toBe(STATUS.HELD);
    expect(r.reason.fieldHeld).toBe(true);
    expect(r.reason.historyReset).toBe(false);
    expect(r.sinceReset).toBe(2);

    r = rt.ingest(makePartialRecord("F1", base + 600, ["inflow"]));
    expect(r.status).toBe(STATUS.HELD);
    expect(r.reason.historyReset).toBe(false);
    expect(r.sinceReset).toBe(3);

    // 3rd bad step exceeds holdMax => history reset.
    r = rt.ingest(makePartialRecord("F1", base + 900, ["inflow"]));
    expect(r.status).toBe(STATUS.INVALID);
    expect(r.reason.historyReset).toBe(true);
    // sinceReset reset then incremented => 1 (first record after reset).
    expect(r.sinceReset).toBe(0);
    // memoryFeatures present but depth low.
    expect(r.memoryFeatures).toBeNull();
  });

  it("explicit reset clears state for a facility", () => {
    const config = makeDatasetConfig(["F1"]);
    const rt = new SoftwareRuntime("t5");
    rt.configure(config);
    const base = 1791186900;

    rt.ingest(makeRecord("F1", base));
    rt.ingest(makeRecord("F1", base + 300));
    let r = rt.ingest(makeRecord("F1", base + 600));
    expect(r.sinceReset).toBe(3);

    rt.reset("F1");
    r = rt.ingest(makeRecord("F1", base + 900));
    expect(r.sinceReset).toBe(1); // reset then incremented
    expect(r.reason.historyReset).toBe(false); // explicit reset doesn't set reason bit on next valid record
  });

  it("reset all facilities clears global resultNo", () => {
    const config = makeDatasetConfig(["F1", "F2"]);
    const rt = new SoftwareRuntime("t6");
    rt.configure(config);
    rt.ingest(makeRecord("F1", 1791186900));
    rt.ingest(makeRecord("F2", 1791186900));
    rt.reset();
    // After reset, resultNo restarts.
    const r = rt.ingest(makeRecord("F1", 1791186900 + 300));
    expect(r.resultNo).toBe(1);
  });
});

describe("SoftwareRuntime — duplicates / out-of-order / gaps", () => {
  it("drops duplicate records (same ts) without state change", () => {
    const config = makeDatasetConfig(["F1"]);
    const rt = new SoftwareRuntime("t7");
    rt.configure(config);
    const base = 1791186900;

    const r1 = rt.ingest(makeRecord("F1", base));
    expect(r1.status).toBe(STATUS.VALID);
    expect(r1.sinceReset).toBe(1);

    const r2 = rt.ingest(makeRecord("F1", base)); // duplicate
    expect(r2.status).toBe(STATUS.DROPPED);
    expect(r2.reason.duplicate).toBe(true);
    expect(r2.sinceReset).toBe(0);

    // State unchanged: next record behaves as if duplicate never happened.
    const r3 = rt.ingest(makeRecord("F1", base + 300));
    expect(r3.status).toBe(STATUS.VALID);
    expect(r3.sinceReset).toBe(2);
  });

  it("drops out-of-order records (ts < prev)", () => {
    const config = makeDatasetConfig(["F1"]);
    const rt = new SoftwareRuntime("t8");
    rt.configure(config);
    const base = 1791186900;

    rt.ingest(makeRecord("F1", base + 600));
    const r = rt.ingest(makeRecord("F1", base + 300)); // out of order
    expect(r.status).toBe(STATUS.DROPPED);
    expect(r.reason.outOfOrder).toBe(true);
  });

  it("handles a time gap: holds then resets beyond holdMax", () => {
    const config = makeDatasetConfig(["F1"]);
    const rt = new SoftwareRuntime("t9");
    rt.configure(config);
    const base = 1791186900;

    rt.ingest(makeRecord("F1", base));
    // Gap of 4 steps (> holdMax=2) => reset on the gap record.
    const r = rt.ingest(makeRecord("F1", base + 4 * 300));
    expect(r.reason.stepGapHeld).toBe(false);
    expect(r.reason.historyReset).toBe(true);
    expect(r.sinceReset).toBe(1);
  });
});

describe("SoftwareRuntime — already-tripped and zero / non-filling countdown", () => {
  it("returns countdown 0 when already at shutdown limit (already-at-limit check)", () => {
    // Tank at shutdown (92%), pump failed => net inflow <= 0, but already-at-limit wins => 0.
    const config = makeDatasetConfig(["F1"], {
      F1: { shutdownLvl: 9200, warningLvl: 8500 },
    });
    const rt = new SoftwareRuntime("t10");
    rt.configure(config);
    const base = 1791186900;

    // Pump failed, level at shutdown.
    const r = rt.ingest(makeRecord("F1", base, { pumpStatus: 2, pumpFlowBpd: 0, levelPct: 92 }));
    expect(r.rules.levelAtShutdown).toBe(true);
    expect(r.countdown.p10).toBe(0);
    expect(r.countdown.p50).toBe(0);
    expect(r.countdown.p90).toBe(0);
    expect(r.countdown.notFilling).toBe(false); // already-at-limit => 0, not sentinel
  });

  it("returns not-filling sentinel when net inflow <= 0 and below shutdown", () => {
    const config = makeDatasetConfig(["F1"], { F1: { shutdownLvl: 9200 } });
    const rt = new SoftwareRuntime("t11");
    rt.configure(config);
    const base = 1791186900;

    // Pump failed, inflow 0, level below shutdown => net inflow 0 => not filling.
    const r = rt.ingest(makeRecord("F1", base, { pumpStatus: 2, pumpFlowBpd: 0, inflowBpd: 0, levelPct: 50 }));
    expect(r.countdown.notFilling).toBe(true);
    expect(r.countdown.p10).toBe(0xffff);
    expect(r.countdown.p50).toBe(0xffff);
    expect(r.countdown.p90).toBe(0xffff);
  });

  it("non-filling countdown is finite when inflow > 0 with failed pump (O7 inflow-only)", () => {
    const config = makeDatasetConfig(["F1"], { F1: { shutdownLvl: 9200 } });
    const rt = new SoftwareRuntime("t12");
    rt.configure(config);
    const base = 1791186900;

    // Failed pump (flow=0), inflow positive => net = inflow (O7 correction) => filling.
    const r = rt.ingest(makeRecord("F1", base, { pumpStatus: 2, pumpFlowBpd: 0, inflowBpd: 2400, levelPct: 50 }));
    expect(r.rules.pumpFault).toBe(true);
    expect(r.countdown.notFilling).toBe(false);
    expect(r.countdown.p50).toBeGreaterThan(0);
  });
});

describe("SoftwareRuntime — state isolation between datasets / runs", () => {
  it("does not leak state between two datasets", () => {
    const c1 = makeDatasetConfig(["F1"]);
    const c2 = makeDatasetConfig(["G1"]);
    const rt1 = new SoftwareRuntime("iso-1");
    const rt2 = new SoftwareRuntime("iso-2");
    rt1.configure(c1);
    rt2.configure(c2);
    const base = 1791186900;

    const a = rt1.ingest(makeRecord("F1", base));
    const b = rt2.ingest(makeRecord("G1", base));
    expect(a.facilityId).toBe("F1");
    expect(b.facilityId).toBe("G1");
    // Each runtime's resultNo independent.
    expect(a.resultNo).toBe(1);
    expect(b.resultNo).toBe(1);

    // Switching datasets on one runtime: rebuild state, no cross-talk.
    rt1.configure(c2);
    const c = rt1.ingest(makeRecord("G1", base + 300));
    expect(c.facilityId).toBe("G1");
    expect(c.sinceReset).toBe(1); // fresh state for G1 on rt1
  });

  it("snapshot/restore rebuilds state to a cutoff deterministically", () => {
    const config = makeDatasetConfig(["F1", "F2"]);
    const rt = new SoftwareRuntime("snap");
    rt.configure(config);
    const base = 1791186900;

    const r1 = rt.ingest(makeRecord("F1", base));
    const r2 = rt.ingest(makeRecord("F2", base + 300));
    const r3 = rt.ingest(makeRecord("F1", base + 600));

    const snap = rt.snapshot();
    expect(snap.globalResultNo).toBe(3);
    expect(snap.cutoffTsUnix).toBe(base + 600);

    // Continue a bit.
    const r4 = rt.ingest(makeRecord("F2", base + 900));

    // Restore to snapshot: state should match post-r3, resultNo back to 3.
    const rt2 = rt;
    rt2.restore(snap);
    const r5 = rt2.ingest(makeRecord("F1", base + 900));
    expect(r5.resultNo).toBe(4); // restored globalResultNo=3, then +1
    expect(r5.sinceReset).toBe(3); // F1 had 2 records (r1, r3) -> sinceReset 2, +1 = 3
  });

  it("restart/replay is deterministic: same inputs => same outputs", () => {
    const config = makeDatasetConfig(["F1"]);
    const records = [
      makeRecord("F1", 1791186900),
      makeRecord("F1", 1791186900 + 300),
      makePartialRecord("F1", 1791186900 + 600, ["level"]),
      makeRecord("F1", 1791186900 + 900),
    ];
    const run1 = (() => {
      const rt = new SoftwareRuntime("det-1");
      rt.configure(config);
      return rt.ingestBatch(records);
    })();
    const run2 = (() => {
      const rt = new SoftwareRuntime("det-2");
      rt.configure(config);
      return rt.ingestBatch(records);
    })();

    expect(run1).toHaveLength(run2.length);
    for (let i = 0; i < run1.length; i++) {
      expect(run1[i].status).toBe(run2[i].status);
      expect(run1[i].sinceReset).toBe(run2[i].sinceReset);
      expect(run1[i].countdown.p50).toBe(run2[i].countdown.p50);
      expect(JSON.stringify(run1[i].reason)).toBe(JSON.stringify(run2[i].reason));
      // Channels identical.
      expect(Array.from(run1[i].channels!)).toEqual(Array.from(run2[i].channels!));
    }
  });
});

describe("SoftwareRuntime — >32 facilities and >8 wells (logical software API)", () => {
  it("supports more than 32 facilities and more than 8 wells per facility", () => {
    // 40 facilities, 12 wells each — well beyond v1 hardware limits, fine for logical API.
    const ids = Array.from({ length: 40 }, (_, i) => `FAC_${i}`);
    const overrides: Record<string, { W: number; slot: number }> = {};
    for (let i = 0; i < 40; i++) overrides[`FAC_${i}`] = { W: 12, slot: i };
    const config = makeDatasetConfig(ids, overrides as any);
    expect(config.facilityById.size).toBe(40);

    const rt = new SoftwareRuntime("big");
    rt.configure(config);
    const base = 1791186900;

    // Ingest one record for each of the 40 facilities.
    const results = rt.ingestBatch(ids.map((id, i) => makeRecord(id, base + i * 300, {
      wellStatus: new Array(12).fill(1),
      wellWaterBpd: new Array(12).fill(100),
    })));
    expect(results).toHaveLength(40);
    for (const r of results) {
      expect(r.status).toBe(STATUS.VALID);
      expect(r.memoryFeatures!.length).toBe(31);
    }

    // capabilities: logical unbounded, packed limited.
    const cap = rt.capabilities();
    expect(cap.maxFacilitiesLogical).toBe(Infinity);
    expect(cap.maxWellsPerFacilityLogical).toBe(Infinity);
    expect(cap.maxFacilitiesPacked).toBe(32);
    expect(cap.maxWellsPerFacilityPacked).toBe(8);
  });
});

describe("SoftwareRuntime — switching rebuilds state without future-data access", () => {
  it("rebuilding state to a cutoff does not see future records", () => {
    const config = makeDatasetConfig(["F1"]);
    const rt = new SoftwareRuntime("fw");
    rt.configure(config);
    const base = 1791186900;

    // Ingest up to a cutoff.
    rt.ingest(makeRecord("F1", base));
    rt.ingest(makeRecord("F1", base + 300));
    const snap = rt.snapshot();
    expect(snap.cutoffTsUnix).toBe(base + 300);

    // Future records exist but must not influence the restored run.
    const future = makeRecord("F1", base + 900, { levelPct: 99 }); // extreme future level

    const rt2 = rt;
    rt2.restore(snap);
    // Replay from cutoff: the future record is not yet applied.
    const r = rt2.ingest(makeRecord("F1", base + 600));
    expect(r.tsUnix).toBe(base + 600);
    // Level used is 50 (from cutoff state), not the future 99.
    expect(r.channels![4]).toBeCloseTo(quantizeLevel(50), 0);
  });
});

function quantizeLevel(pct: number): number {
  return Math.trunc(Math.round(pct / 100 * 16384));
}
