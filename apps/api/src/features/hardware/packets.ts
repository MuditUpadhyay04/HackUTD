/** Draft v1 board datagrams. Values remain raw; no model or alarm interpretation. */
export interface PacketContext { boardIp: string; sourceIp: string; port: 7001 | 7002; slots: readonly number[]; knownWeights?: readonly number[] }
export type HardwarePacket = { kind: "results" | "stats" | "alerts"; seq: number; aux: number; records: Record<string, unknown>[] };

export function parsePacket(bytes: Uint8Array, context: PacketContext): HardwarePacket {
  if (context.sourceIp !== context.boardIp) throw new Error("unexpected board source");
  if (bytes.length < 16) throw new Error("short header");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint32(0, true) !== 0x46474f45 || v.getUint8(4) !== 1) throw new Error("invalid magic or version");
  const type = v.getUint8(5), count = v.getUint16(6, true);
  const size = type === 2 && context.port === 7001 ? 32 : type === 8 && context.port === 7001 ? 64 : type === 3 && context.port === 7002 ? 16 : 0;
  const max = type === 2 ? 45 : 1;
  if (!size || count < 1 || count > max || bytes.length !== 16 + count * size) throw new Error("invalid type, count or length");
  const records: Record<string, unknown>[] = [];
  const u16 = (o: number) => v.getUint16(o, true), u32 = (o: number) => v.getUint32(o, true);
  for (let i = 0; i < count; i++) {
    const o = 16 + i * size;
    if (type === 8) {
      const names = ["recordsIn", "resultsOut", "droppedDuplicate", "droppedOutOfOrder", "droppedUnknownFacility", "invalid", "held", "historyResets", "dataSequenceGaps", "badPackets", "alertsRaised", "mode", "weightsVer", "busyCycles", "uptimeSeconds", "replayWaiting"];
      const stats = Object.fromEntries(names.map((name, j) => [name, u32(o + 4 * j)]));
      if ((stats.mode as number) > 1 || (stats.weightsVer as number) > 255) throw new Error("invalid stats mode or weights version");
      records.push({ ...stats, weightsKnown: context.knownWeights?.includes(stats.weightsVer as number) ?? false });
      continue;
    }
    const facId = u16(o);
    if (facId >= 32 || !context.slots.includes(facId)) throw new Error("unknown facility slot");
    if (type === 2) {
      const status = v.getUint8(o + 2), weightsVer = v.getUint8(o + 21);
      if (![0, 1, 3, 4].includes(status)) throw new Error("reserved or invalid status");
      records.push({ facId, status, sinceReset: v.getUint8(o + 3), tsUnix: u32(o + 4), reason: u32(o + 8), logits: [0, 1, 2, 3].map(j => v.getInt16(o + 12 + j * 2, true)), rules: v.getUint8(o + 20), weightsVer, weightsKnown: context.knownWeights?.includes(weightsVer) ?? false, countdown: { p10: u16(o + 22), p50: u16(o + 24), p90: u16(o + 26) }, resultNo: u32(o + 28) });
    } else {
      const kind = v.getUint8(o + 2), source = v.getUint8(o + 3);
      if (kind < 1 || kind > 4 || (source & 0xf0)) throw new Error("invalid alert kind or source");
      records.push({ facId, kind, source, tsUnix: u32(o + 4), resultNo: u32(o + 8), rules: v.getUint8(o + 12), classes: v.getUint8(o + 13), countdownP10: u16(o + 14) });
    }
  }
  return { kind: type === 2 ? "results" : type === 8 ? "stats" : "alerts", seq: u32(8), aux: u32(12), records };
}
