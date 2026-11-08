import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

/**
 * Dataset folders on disk (DATA_ROOT): judging day is "drop the test/ folder in, reload, pick it". A dataset folder holds
 * network.json, ops.json and telemetry.csv; only those three are read (never answer_key.json). DATA_ROOT itself and up to
 * two levels below are searched, so the reference repo's root finds history/<name>/ and test/.
 */
export const DATASET_FILES = ["network.json", "ops.json", "telemetry.csv"] as const;
export interface DatasetFolder { path: string; label: string; stamp: string }

async function isDataset(dir: string): Promise<string | null> {
  try {
    const stats = await Promise.all(DATASET_FILES.map((f) => stat(join(dir, f))));
    return stats.every((s) => s.isFile()) ? stats.map((s) => `${s.size}:${s.mtimeMs}`).join("|") : null;
  } catch { return null; }
}

export async function findDatasetFolders(root: string, depth = 2): Promise<DatasetFolder[]> {
  const out: DatasetFolder[] = [];
  const visit = async (dir: string, level: number) => {
    const stamp = await isDataset(dir);
    if (stamp) { out.push({ path: dir, label: basename(dir), stamp }); return; }
    if (level >= depth) return;
    let entries: string[] = [];
    try { entries = (await readdir(dir, { withFileTypes: true })).filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith(".") && e.name !== "node_modules").map((e) => e.name).sort(); } catch { return; }
    for (const name of entries) await visit(join(dir, name), level + 1);
  };
  await visit(root, 0);
  return out;
}

export async function readDatasetFolder(dir: string): Promise<{ network: string; ops: string; telemetry: string }> {
  const [network, ops, telemetry] = await Promise.all(DATASET_FILES.map((f) => readFile(join(dir, f), "utf8")));
  return { network: network!, ops: ops!, telemetry: telemetry! };
}
