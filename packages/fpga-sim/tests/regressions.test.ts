import { describe, expect, it } from 'bun:test';
import { SoftwareRuntime } from '../src/runtime.ts';
import { encodeDataRecord, withSlot, encodeFacilityConfig } from '../src/codec/v1.ts';
import { makeDatasetConfig, makeRecord } from './helpers.ts';

const t = 1791186900;
describe('regressions', () => {
  it('does not turn absent fields into observations; holds each field independently through invalid records', () => {
    const rt = new SoftwareRuntime(); rt.configure(makeDatasetConfig(['F']));
    rt.ingest(makeRecord('F',t));
    const r = makeRecord('F',t+300); r.present.inflow = false; r.inflowBpd = 9999;
    expect(rt.ingest(r).status).toBe(1);
    const s = makeRecord('F',t+600); s.present.inflow = false; s.present.level = false;
    expect(rt.ingest(s).status).toBe(1);
    const q = makeRecord('F',t+900); q.present.inflow = false; q.present.level = false;
    expect(rt.ingest(q).status).toBe(3);
    const next = makeRecord('F',t+1200); next.present.level = false;
    expect(rt.ingest(next).status).toBe(3);
  });
  it('does not assert rules for initially absent pump or wells', () => {
    const rt = new SoftwareRuntime(); rt.configure(makeDatasetConfig(['F']));
    const r = makeRecord('F',t); r.present.pumpStatus = false; r.present.wellStatus.fill(false); r.present.wellWater.fill(false);
    const out = rt.ingest(r); expect(out.status).toBe(3); expect(out.rules.pumpFault).toBe(false); expect(out.rules.shutIn).toBe(false); expect(out.logits).toBeNull();
  });
  it('uses inflow history at failure onset, not prior net flow', () => {
    const rt = new SoftwareRuntime(); rt.configure(makeDatasetConfig(['F']));
    for (let i=0;i<16;i++) rt.ingest(makeRecord('F',t+i*300));
    const r=rt.ingest(makeRecord('F',t+16*300,{pumpStatus:2,pumpFlowBpd:0}));
    expect(r.countdown.p50).toBeGreaterThan(0); expect(r.countdown.p50).toBeLessThan(65535);
  });
  it('rejects foreign and future checkpoints atomically', () => {
    const a=new SoftwareRuntime(), b=new SoftwareRuntime(); const cfg=makeDatasetConfig(['F']); a.configure(cfg); b.configure(cfg);
    a.ingest(makeRecord('F',t)); const snap=a.snapshot(); expect(()=>b.restore(snap)).toThrow();
    const original=a.snapshot(); snap.facilities.get('F')!.lastTs=cfg.lastTsUnix+300; expect(()=>a.restore(snap)).toThrow();
    expect(a.snapshot().cutoffTsUnix).toBe(original.cutoffTsUnix);
  });
  it('requires an explicit wire slot and checks integer widths', () => {
    const r=makeRecord('F',t); expect(()=>encodeDataRecord(r)).toThrow();
    expect(encodeDataRecord(withSlot(r,31))[0]).toBe(31);
    expect(()=>encodeDataRecord(withSlot(r,32))).toThrow();
  });
});
