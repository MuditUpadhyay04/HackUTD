// Dataset discovery and fast telemetry loading.
// Reads ONLY network.json, ops.json and telemetry.csv. Never answer_key.json.
import fs from "node:fs";
import path from "node:path";
import type { DatasetInfo } from "./types";

// ---------- raw file shapes ----------
export interface NetWell {
  id: string;
  baseline_water_bpd: number;
  oil_bpd: number;
  gas_mcfd: number;
}
export interface NetFacility {
  id: string;
  lat: number;
  lon: number;
  wells: NetWell[];
  tank: { id: string; capacity_bbl: number };
  pump: { id: string; max_flow_bpd: number; start_level_pct: number; stop_level_pct: number };
  pipeline: { id: string; max_bpd?: number; max_pressure_psi?: number };
}
export interface NetSystem {
  id: string;
  center: [number, number];
  truck_yard: [number, number];
  disposal_site: { id: string; lat: number; lon: number; pressure_psi: number };
  facilities: NetFacility[];
}
export interface Network {
  defaults: { tank_limits_pct: { warning: number; shutdown: number } };
  systems: NetSystem[];
}
export interface Ops {
  prices: { oil_per_bbl: number; gas_per_mcf: number };
  expected_repair_hours: { pump_failure: number; [k: string]: number };
  emergency_trucking: { truck_capacity_bbl: number; cost_per_trip: number };
  systems: Record<
    string,
    {
      emergency_fleet_size: number;
      facilities: Record<string, { response_min: number; cycle_min: number }>;
    }
  >;
}

export interface LoadedDataset {
  id: string;
  dir: string;
  label: string;
  network: Network;
  ops: Ops;
  t0: number; // first ts_unix
  dt: number; // seconds per step (300)
  n: number; // number of steps
  series: Map<string, Float64Array>; // key "ASSET|metric", NaN where missing (gaps held <= HOLD_STEPS)
  quality: Map<string, Uint8Array>; // per step: Q_VALID / Q_HELD / Q_INVALID / Q_DROPPED
  lastObs: Map<string, Int32Array>; // per step: index of the last real (VALID) reading at or before it, -1 if none
  mtimeKey: string;
}

// Per-reading quality codes (ordered: higher is worse). Matches the Quality type in types.ts.
export const Q_VALID = 0; // measured at this step
export const Q_HELD = 1; // missing or unreadable, last good value carried forward (at most HOLD_STEPS)
export const Q_INVALID = 2; // a row exists but its value is blank or unreadable
export const Q_DROPPED = 3; // no row at all
export const HOLD_STEPS = 2; // team plan: hold <= 2 steps, then the reading is treated as missing

const REQUIRED = ["network.json", "ops.json", "telemetry.csv"];

function roots(): string[] {
  const primary = process.env.DATA_ROOT ?? path.resolve(process.cwd(), "../data-repo/history");
  const out = [primary];
  // sibling test/ folder (../data-repo/test), plus any folders listed in DATA_EXTRA (path-delimited)
  out.push(path.resolve(primary, "../test"));
  if (process.env.DATA_EXTRA) out.push(...process.env.DATA_EXTRA.split(path.delimiter));
  return Array.from(new Set(out));
}

function hasFiles(dir: string): boolean {
  return REQUIRED.every((f) => fs.existsSync(path.join(dir, f)));
}

/** Map dataset id -> directory. A root that itself holds the 3 files is a dataset (e.g. test/). */
function discover(): Map<string, string> {
  const found = new Map<string, string>();
  for (const root of roots()) {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue;
    if (hasFiles(root)) {
      let id = path.basename(root);
      while (found.has(id)) id += "_";
      found.set(id, root);
    }
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const dir = path.join(root, ent.name);
      if (!hasFiles(dir)) continue;
      let id = ent.name;
      while (found.has(id)) id += "_";
      found.set(id, dir);
    }
  }
  return found;
}

// ---------- time range from the telemetry (cheap: read first and last lines) ----------
function readRange(file: string): { first: number; last: number } {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(4096, size));
    fs.readSync(fd, head, 0, head.length, 0);
    const lines = head.toString("utf8").split("\n");
    const first = Number(lines[1].split(",")[1]);
    const tailLen = Math.min(4096, size);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    const tl = tail.toString("utf8").trimEnd().split("\n");
    const last = Number(tl[tl.length - 1].split(",")[1]);
    return { first, last };
  } finally {
    fs.closeSync(fd);
  }
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function fmtDay(unix: number): string {
  const d = new Date(unix * 1000);
  return `${DOW[d.getUTCDay()]} ${MON[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
export function fmtClock(unix: number): string {
  const d = new Date(unix * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function makeLabel(id: string, dir: string, first: number, last: number): string {
  const lower = id.toLowerCase();
  const span = (last - first) / 86400;
  const systems = (() => {
    try {
      const n = JSON.parse(fs.readFileSync(path.join(dir, "network.json"), "utf8")) as Network;
      const ids = n.systems.map((s) => s.id);
      return ids.length ? `${ids[0]}–${ids[ids.length - 1]}` : "";
    } catch {
      return "";
    }
  })();
  const at = `${fmtDay(last)}, ${fmtClock(last)}`;
  if (lower.startsWith("mock")) return `Mock test, ${at}`;
  if (lower === "test" || lower.startsWith("test")) return `Test network (${systems}), ${span >= 6.9 ? "full week" : at}`;
  if (lower.startsWith("snapshot")) return `Snapshot, ${at}`;
  if (span >= 6.9) return `Full week, ${fmtDay(first)} to ${fmtDay(last)}`;
  return `${id}, ${at}`;
}

interface InfoCacheEntry {
  info: DatasetInfo;
  key: string;
}
const infoCache = new Map<string, InfoCacheEntry>();

function mtimeKey(dir: string): string {
  return REQUIRED.map((f) => {
    const s = fs.statSync(path.join(dir, f));
    return `${s.mtimeMs}:${s.size}`;
  }).join("|");
}

export function listDatasets(): DatasetInfo[] {
  const out: DatasetInfo[] = [];
  for (const [id, dir] of discover()) {
    try {
      const key = mtimeKey(dir);
      const c = infoCache.get(dir);
      if (c && c.key === key) {
        out.push(c.info);
        continue;
      }
      const { first, last } = readRange(path.join(dir, "telemetry.csv"));
      const info: DatasetInfo = { id, label: makeLabel(id, dir, first, last), startUnix: first, nowUnix: last };
      infoCache.set(dir, { info, key });
      out.push(info);
    } catch {
      // unreadable folder: skip
    }
  }
  // full weeks first, then snapshots by time, then mock/test
  const rank = (d: DatasetInfo) => {
    const l = d.id.toLowerCase();
    if (l.startsWith("test")) return 0;
    if (l.startsWith("mock")) return 3;
    if (l.startsWith("snapshot")) return 2;
    return 1;
  };
  out.sort((a, b) => rank(a) - rank(b) || a.nowUnix - b.nowUnix || a.id.localeCompare(b.id));
  return out;
}

export function datasetDir(id: string): string {
  const dir = discover().get(id);
  if (!dir) throw new Error(`Unknown dataset: ${id}`);
  return dir;
}

// ---------- fast CSV parse into typed arrays ----------
const cache = new Map<string, LoadedDataset>();

function parseTelemetry(
  buf: Buffer,
  first: number,
  last: number,
  dt: number
): { n: number; series: Map<string, Float64Array>; quality: Map<string, Uint8Array> } {
  const n = Math.round((last - first) / dt) + 1;
  const series = new Map<string, Float64Array>();
  const quality = new Map<string, Uint8Array>();
  const len = buf.length;
  let i = buf.indexOf(10) + 1; // skip header
  let lastKey = "";
  let lastArr: Float64Array | null = null;
  let lastQ: Uint8Array | null = null;
  while (i < len) {
    // field 0: timestamp (skip)
    while (i < len && buf[i] !== 44) i++;
    i++;
    // field 1: ts_unix
    let ts = 0;
    while (i < len && buf[i] !== 44) {
      ts = ts * 10 + (buf[i] - 48);
      i++;
    }
    i++;
    // field 2+3: asset,metric as one key
    const ks = i;
    while (i < len && buf[i] !== 44) i++;
    i++;
    while (i < len && buf[i] !== 44) i++;
    const key = buf.toString("latin1", ks, i).replace(",", "|");
    i++;
    // field 4: value (manual float parse)
    let neg = false;
    let v = 0;
    let frac = 0;
    let scale = 1;
    let sawDot = false;
    let other = false;
    let sawDigit = false;
    const vs = i;
    while (i < len && buf[i] !== 10 && buf[i] !== 13) {
      const c = buf[i];
      if (c === 45) neg = true;
      else if (c === 46) sawDot = true;
      else if (c >= 48 && c <= 57) {
        sawDigit = true;
        if (sawDot) {
          frac = frac * 10 + (c - 48);
          scale *= 10;
        } else v = v * 10 + (c - 48);
      } else other = true;
      i++;
    }
    let value = v + frac / scale;
    if (neg) value = -value;
    // A field with no digit at all (blank, "-", ".", "nan", spaces) is missing, never 0.
    if (!sawDigit) value = NaN;
    else if (other) value = Number(buf.toString("latin1", vs, i)); // e.g. exponent
    if (!Number.isFinite(value)) value = NaN;
    while (i < len && (buf[i] === 10 || buf[i] === 13)) i++;
    let arr: Float64Array;
    let q: Uint8Array;
    if (key === lastKey && lastArr && lastQ) {
      arr = lastArr;
      q = lastQ;
    } else {
      let a = series.get(key);
      let qa = quality.get(key);
      if (!a || !qa) {
        a = new Float64Array(n).fill(NaN);
        qa = new Uint8Array(n).fill(Q_DROPPED);
        series.set(key, a);
        quality.set(key, qa);
      }
      arr = a;
      q = qa;
      lastKey = key;
      lastArr = a;
      lastQ = qa;
    }
    const step = Math.round((ts - first) / dt);
    if (step >= 0 && step < n) {
      arr[step] = value;
      q[step] = Number.isNaN(value) ? Q_INVALID : Q_VALID;
    }
  }
  return { n, series, quality };
}

export function loadDataset(id: string): LoadedDataset {
  const dir = datasetDir(id);
  const key = mtimeKey(dir);
  const hit = cache.get(id);
  if (hit && hit.mtimeKey === key && hit.dir === dir) return hit;
  const network = JSON.parse(fs.readFileSync(path.join(dir, "network.json"), "utf8")) as Network;
  const ops = JSON.parse(fs.readFileSync(path.join(dir, "ops.json"), "utf8")) as Ops;
  const csvPath = path.join(dir, "telemetry.csv");
  const { first, last } = readRange(csvPath);
  const buf = fs.readFileSync(csvPath);
  // infer step from the first two distinct timestamps
  let dt = 300;
  {
    const head = buf.subarray(0, Math.min(buf.length, 1 << 20)).toString("latin1").split("\n");
    for (let k = 2; k < head.length; k++) {
      const t = Number(head[k].split(",")[1]);
      if (Number.isFinite(t) && t > first) {
        dt = t - first;
        break;
      }
    }
  }
  const { n, series, quality } = parseTelemetry(buf, first, last, dt);
  // Forward-fill short gaps (at most HOLD_STEPS) and mark them HELD. Longer gaps stay NaN and keep
  // their INVALID / DROPPED mark, so stale data is never passed off as a live reading.
  const lastObs = new Map<string, Int32Array>();
  for (const [k, arr] of series) {
    const q = quality.get(k)!;
    const lo = new Int32Array(n);
    let prev = NaN;
    let lastK = -1;
    for (let s = 0; s < n; s++) {
      if (q[s] === Q_VALID) {
        prev = arr[s];
        lastK = s;
      } else if (lastK >= 0 && s - lastK <= HOLD_STEPS) {
        arr[s] = prev;
        q[s] = Q_HELD;
      } else arr[s] = NaN;
      lo[s] = lastK;
    }
    lastObs.set(k, lo);
  }
  const ds: LoadedDataset = {
    id,
    dir,
    label: makeLabel(id, dir, first, last),
    network,
    ops,
    t0: first,
    dt,
    n,
    series,
    quality,
    lastObs,
    mtimeKey: key,
  };
  cache.set(id, ds);
  return ds;
}

// Absent series: every step is missing (NaN, DROPPED, never observed), never an empty array or zeros.
const absent = new WeakMap<LoadedDataset, { v: Float64Array; q: Uint8Array; lo: Int32Array }>();
function absentOf(ds: LoadedDataset) {
  let a = absent.get(ds);
  if (!a) {
    a = { v: new Float64Array(ds.n).fill(NaN), q: new Uint8Array(ds.n).fill(Q_DROPPED), lo: new Int32Array(ds.n).fill(-1) };
    absent.set(ds, a);
  }
  return a;
}

export function getSeries(ds: LoadedDataset, asset: string, metric: string): Float64Array {
  return ds.series.get(`${asset}|${metric}`) ?? absentOf(ds).v;
}

/** Quality mask and last-real-reading index for a series (all DROPPED / -1 when the series is absent). */
export function getQuality(ds: LoadedDataset, asset: string, metric: string): { q: Uint8Array; lastObs: Int32Array } {
  const k = `${asset}|${metric}`;
  const q = ds.quality.get(k);
  const lo = ds.lastObs.get(k);
  if (q && lo) return { q, lastObs: lo };
  const a = absentOf(ds);
  return { q: a.q, lastObs: a.lo };
}

export function datasetInfo(ds: LoadedDataset): DatasetInfo {
  return { id: ds.id, label: ds.label, startUnix: ds.t0, nowUnix: ds.t0 + (ds.n - 1) * ds.dt };
}
