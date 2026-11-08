/** Offline v1 DATA encoder. It never opens a network socket. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { importDataset } from "../api/src/features/datasets/service.ts";
import { buildDatasetConfig } from "../../packages/fpga-sim/src/runtime.ts";
import type { Frame, ImportedDataset } from "../../packages/contracts/src/index.ts";

export function encodeFrame(frame: Frame, slot: number, nWells: number): Uint8Array {
  if (!Number.isInteger(slot) || slot < 0 || slot > 31 || !Number.isInteger(nWells) || nWells < 1 || nWells > 8 || frame.wellStatus.length > nWells || frame.wellWaterBpd.length > nWells) throw new Error("invalid facility or well slots");
  if (!Number.isInteger(frame.tsUnix) || frame.tsUnix < 0 || frame.tsUnix > 0xffffffff) throw new Error("timestamp outside uint32");
  const bytes = new Uint8Array(48), v = new DataView(bytes.buffer); let mask = 0;
  v.setUint16(0, slot, true); v.setUint32(4, frame.tsUnix, true);
  const field = (value: number | null | undefined, offset: number, scale: number, bit: number) => {
    if (value == null || !Number.isFinite(value)) return;
    const q = Math.round(value / scale);
    if (q < -32768 || q > 32767) return;
    v.setInt16(offset, q, true); mask |= 1 << bit;
  };
  field(frame.inflowBpd, 12, .5, 0); field(frame.levelPct, 14, .01, 1);
  field(frame.pumpFlowBpd, 16, .5, 3); field(frame.dischargePsi, 20, .1, 4);
  field(frame.receiveFlowBpd, 18, .5, 5); field(frame.pipelinePsi, 22, .1, 6);
  if (frame.pumpStatus != null && Number.isInteger(frame.pumpStatus) && frame.pumpStatus >= 0 && frame.pumpStatus <= 255) { v.setUint8(24, frame.pumpStatus); mask |= 4; }
  let statuses = 0;
  for (let i = 0; i < nWells; i++) {
    const status = frame.wellStatus[i];
    if (status != null && Number.isInteger(status) && status >= 0 && status <= 3) { statuses |= status << (i * 2); mask |= 1 << (8 + i); }
    field(frame.wellWaterBpd[i], 28 + i * 2, .5, 16 + i);
  }
  v.setUint16(26, statuses, true); v.setUint32(8, mask >>> 0, true);
  return bytes;
}

export function encodeDataset(dataset: ImportedDataset): Uint8Array[] {
  const config = buildDatasetConfig(dataset.network, dataset.ops, dataset.info.startUnix, dataset.info.nowUnix);
  const facilities = config.systems.flatMap(s => s.facilities);
  if (!facilities.length || facilities.length > 32 || facilities.some(f => f.nWells < 1 || f.nWells > 8)) throw new Error("dataset exceeds v1 slot limits");
  const slots = new Map(facilities.map(f => [f.facilityId, f]));
  return [...dataset.frames].sort((a, b) => a.tsUnix - b.tsUnix || (slots.get(a.facilityId)?.slot ?? 99) - (slots.get(b.facilityId)?.slot ?? 99)).map(frame => {
    const f = slots.get(frame.facilityId); if (!f) throw new Error("unknown facility in frame");
    return encodeFrame(frame, f.slot, f.nWells);
  });
}

export async function readAndEncode(folder: string): Promise<Uint8Array[]> {
  const [network, ops, telemetry] = await Promise.all(["network.json", "ops.json", "telemetry.csv"].map(name => readFile(join(folder, name), "utf8")));
  return encodeDataset(await importDataset({ network: network!, ops: ops!, telemetry: telemetry! }));
}

if (import.meta.main) {
  const folder = process.argv[2];
  if (!folder) throw new Error("usage: bun apps/encoder/index.ts DATASET_FOLDER > records.bin");
  for (const record of await readAndEncode(folder)) process.stdout.write(record);
}
