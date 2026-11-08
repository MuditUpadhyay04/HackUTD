import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ImportedDataset, Snapshot } from "@hackutd/contracts";
import { importDataset } from "../../datasets/service";
import { buildRunSnapshot } from "../../runtimes/service";
import { boardFacts, type BoardFact } from "./facts";

/** Reads only the three runtime input files of a dataset folder; any answer key in the folder is never opened. */
export async function loadDataset(dir: string, label?: string): Promise<ImportedDataset> {
  const read = (name: string) => readFileSync(join(dir, name), "utf8");
  return importDataset({ network: read("network.json"), ops: read("ops.json"), telemetry: read("telemetry.csv") }, label ?? dir.split("/").filter(Boolean).at(-1));
}

export async function snapshotAt(dataset: ImportedDataset, at: number, runId?: string): Promise<Snapshot> {
  return buildRunSnapshot(dataset, { runId: runId ?? `case-${dataset.info.label}-${at}`, at, runtime: "software", revision: 1 });
}

/** listen.py --jsonl output (C11 JSON lines), if present. */
export function readBoardJsonl(path: string | undefined, source: BoardFact["source"] = "fakeboard"): BoardFact[] {
  if (!path || !existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  return boardFacts(lines, source);
}

export interface Case { id: string; dataset: string; at: number; snapshot: Snapshot; systems: string[]; pumpIncidents: number }

/**
 * Evaluation cases: cutoffs on the dataset's five-minute grid inside [from, to), every strideHours, kept when an
 * incident is ongoing; at most `limit`, preferring cutoffs that add a system not seen yet.
 */
export async function buildCases(dataset: ImportedDataset, window: { from: number; to: number }, options: { strideHours: number; limit: number }): Promise<Case[]> {
  const start = dataset.info.startUnix, step = 300;
  const out: Case[] = [];
  const seen = new Set<string>();
  const candidates: Case[] = [];
  for (let t = Math.max(window.from, start + step * 12); t < Math.min(window.to, dataset.info.nowUnix); t += options.strideHours * 3600) {
    const at = start + Math.floor((t - start) / step) * step;
    const snapshot = await snapshotAt(dataset, at);
    const ongoing = snapshot.alerts.filter((i) => i.status === "ongoing");
    if (!ongoing.length) continue;
    candidates.push({ id: `${dataset.info.label}@${at}`, dataset: dataset.info.label, at, snapshot, systems: [...new Set(ongoing.map((i) => i.systemId))].sort(), pumpIncidents: ongoing.filter((i) => i.category === "pump_failure").length });
  }
  for (const c of candidates) if (out.length < options.limit && c.systems.some((s) => !seen.has(s))) { out.push(c); c.systems.forEach((s) => seen.add(s)); }
  for (const c of candidates) if (out.length < options.limit && !out.includes(c)) out.push(c);
  return out.sort((a, b) => a.at - b.at);
}
