import { existsSync, readFileSync } from "node:fs";

/**
 * Board results (contract C11: the JSON lines `ml/hutd_ml/listen.py` writes) as the detection source for a run.
 * The board (or the bit-exact software board) already applied the trained thresholds and the per-class K, so
 * `active` is the detection. Nothing here reads the answer key; the file is produced from the dataset's telemetry.
 */
export type BoardSource = "fpga" | "fakeboard" | "unverified";
export interface BoardResult {
  facilityId: string; tsUnix: number; status: string; active: string[]; above: string[];
  probability: Partial<Record<string, number>> | null; weightsVer: number | null; source: BoardSource;
}
export type BoardIndex = Map<string, BoardResult>;
export const boardKey = (facilityId: string, tsUnix: number) => `${facilityId}@${tsUnix}`;

export function boardIndex(lines: unknown[], fallback: BoardSource = "unverified"): BoardIndex {
  const out: BoardIndex = new Map();
  for (const line of lines) {
    const r = line as { type?: string; facility?: unknown; ts_unix?: unknown; status?: unknown; active?: unknown; above_threshold?: unknown; probability?: unknown; weights_ver?: unknown; source?: unknown };
    if (r?.type !== "result" || typeof r.facility !== "string" || typeof r.ts_unix !== "number") continue;
    const strs = (x: unknown) => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : []);
    const prob = r.probability && typeof r.probability === "object" ? (r.probability as Record<string, number>) : null;
    out.set(boardKey(r.facility, r.ts_unix), {
      facilityId: r.facility, tsUnix: r.ts_unix, status: String(r.status ?? "UNKNOWN"),
      // older listen.py output has no `active`: fall back to the per-record test (less strict than the board's K)
      active: strs(r.active ?? r.above_threshold), above: strs(r.above_threshold ?? r.active), probability: prob,
      weightsVer: typeof r.weights_ver === "number" ? r.weights_ver : null,
      source: r.source === "fpga" || r.source === "fakeboard" ? r.source : fallback,
    });
  }
  return out;
}

/** Reads a listen.py --jsonl file; a missing or empty file gives an empty index. Re-read per run, so a live file works. */
export function readBoardIndex(path: string | undefined, fallback: BoardSource = "unverified"): BoardIndex {
  if (!path || !existsSync(path)) return new Map();
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  return boardIndex(lines, fallback);
}
