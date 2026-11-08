import { describe, expect, test } from "bun:test";
import { parsePacket } from "./packets.ts";
import { HardwareBridge } from "./bridge.ts";

function packet(type: number, size: number) {
  const b = new Uint8Array(16 + size), v = new DataView(b.buffer);
  v.setUint32(0, 0x46474f45, true); v.setUint8(4, 1); v.setUint8(5, type); v.setUint16(6, 1, true);
  return { b, v };
}
const ctx = { boardIp: "10.0.0.1", sourceIp: "10.0.0.1", port: 7001 as const, slots: [0] };
describe("hardware packet parser", () => {
  test("retains signed logits, unknown weights and rejects malformed packets", () => {
    const { b, v } = packet(2, 32); v.setInt16(28, -32768, true); v.setUint8(37, 7); v.setUint32(44, 0xffffffff, true);
    const r = parsePacket(b, ctx).records[0]!;
    expect(r.logits).toEqual([-32768, 0, 0, 0]); expect(r.weightsKnown).toBe(false); expect(r.resultNo).toBe(0xffffffff);
    expect(() => parsePacket(b.subarray(0, 47), ctx)).toThrow();
    expect(() => parsePacket(b, { ...ctx, sourceIp: "10.0.0.2" })).toThrow();
    v.setUint8(18, 2); expect(() => parsePacket(b, ctx)).toThrow();
    v.setUint8(18, 0); v.setUint16(16, 1, true); expect(() => parsePacket(b, ctx)).toThrow();
  });
  test("parses stats and alerts", () => {
    const stats = packet(8, 64); stats.v.setUint32(16 + 15 * 4, 123, true);
    expect(parsePacket(stats.b, ctx).records[0]!.replayWaiting).toBe(123);
    const alert = packet(3, 16); alert.v.setUint8(18, 2); alert.v.setUint8(19, 12); alert.v.setUint16(30, 65535, true);
    expect(parsePacket(alert.b, { ...ctx, port: 7002 }).records[0]).toMatchObject({ kind: 2, source: 12, countdownP10: 65535 });
    alert.v.setUint8(19, 128); expect(() => parsePacket(alert.b, { ...ctx, port: 7002 })).toThrow();
  });
});
test("overflow latches heartbeat suppression and preserves queued packet", async () => {
  let release!: () => void, beats = 0;
  const bridge = new HardwareBridge({ boardIp: ctx.boardIp, runId: "r", epochId: "e", slots: [0], capacity: 1, sendBatch: () => new Promise<void>(resolve => { release = resolve; }), sendHeartbeat: () => { beats++; } });
  bridge.tick(); expect(beats).toBe(1);
  const { b } = packet(2, 32); bridge.receive(b, ctx.boardIp, 7001); bridge.tick(); expect(beats).toBe(1);
  bridge.receive(b, ctx.boardIp, 7001); expect(bridge.health.overflow).toBe(1);
  release(); await Promise.resolve(); await Promise.resolve(); bridge.tick(); expect(beats).toBe(1); expect(bridge.health.healthy).toBe(false);
});
