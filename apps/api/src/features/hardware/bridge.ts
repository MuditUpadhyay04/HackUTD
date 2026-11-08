import { parsePacket, type HardwarePacket } from "./packets.ts";

export interface BridgeOptions {
  boardIp: string; runId: string; epochId: string; slots: number[]; knownWeights?: number[]; capacity: number;
  sendBatch: (batch: object) => Promise<void>; sendHeartbeat: (bytes: Uint8Array) => void;
}

/** Volatile bounded queue. Overflow latches unhealthy until operator restart; it is never hidden. */
export class HardwareBridge {
  private queue: HardwarePacket[] = [];
  private flushing = false;
  private lost = false;
  readonly counters = { received: 0, rejected: 0, overflow: 0, delivered: 0, sendFailures: 0, heartbeats: 0 };
  constructor(readonly options: BridgeOptions) {
    if (!options.boardIp || !options.runId || !options.epochId || !Number.isInteger(options.capacity) || options.capacity < 1 || !options.slots.length || options.slots.some(n => !Number.isInteger(n) || n < 0 || n > 31) || new Set(options.slots).size !== options.slots.length) throw new Error("invalid bridge configuration");
  }
  get health() { return { healthy: !this.lost && this.queue.length < this.options.capacity, queued: this.queue.length, volatile: true, ...this.counters }; }
  receive(bytes: Uint8Array, sourceIp: string, port: 7001 | 7002) {
    let packet: HardwarePacket;
    try { packet = parsePacket(bytes, { ...this.options, sourceIp, port }); } catch { this.counters.rejected++; return; }
    this.counters.received++;
    if (this.queue.length >= this.options.capacity) { this.counters.overflow++; this.lost = true; return; }
    this.queue.push(packet);
    void this.flush();
  }
  async flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length) {
        const packet = this.queue[0]!;
        try {
          await this.options.sendBatch({ runId: this.options.runId, epochId: this.options.epochId, kind: packet.kind, seq: packet.seq, aux: packet.aux, [packet.kind]: packet.records });
        } catch { this.counters.sendFailures++; break; }
        this.queue.shift(); this.counters.delivered++;
      }
    } finally { this.flushing = false; }
  }
  tick() {
    void this.flush();
    if (!this.health.healthy) return;
    const b = new Uint8Array(16), v = new DataView(b.buffer);
    v.setUint32(0, 0x46474f45, true); v.setUint8(4, 1); v.setUint8(5, 9);
    v.setUint32(8, this.counters.heartbeats >>> 0, true);
    this.options.sendHeartbeat(b); this.counters.heartbeats++;
  }
}
