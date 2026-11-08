import { createHash } from "node:crypto";
import type { Frame, ImportedDataset, Network, NetworkFacility, Operations, TelemetrySample } from "../../../../../packages/contracts/src/index";
import { invalid, MAX_FRAMES, MAX_TELEMETRY_BYTES, MAX_TELEMETRY_RECORDS, MAX_TIMESTEPS } from "./model";

export { MAX_TELEMETRY_BYTES, MAX_TELEMETRY_RECORDS, MAX_TIMESTEPS, MAX_FRAMES } from "./model";

type Obj = Record<string, unknown>;
const unsafe = new Set(Object.getOwnPropertyNames(Object.prototype).concat(["prototype"]));
function obj(v: unknown, file: string, path: string): Obj {
  if (!v || typeof v !== "object" || Array.isArray(v)) return invalid(file, path, "expected object");
  for (const key of Object.keys(v)) if (unsafe.has(key)) invalid(file, `${path}.${key}`, "unsafe key");
  return v as Obj;
}
function arr(v: unknown, file: string, path: string): unknown[] {
  if (!Array.isArray(v) || !v.length) return invalid(file, path, "expected nonempty array");
  return v;
}
function str(v: unknown, file: string, path: string): string {
  if (typeof v !== "string" || !v.trim()) return invalid(file, path, "expected nonempty string");
  return v;
}
function num(v: unknown, file: string, path: string, min = 0, max = Infinity, exclusive = false): number {
  if (typeof v !== "number" || !Number.isFinite(v) || (exclusive ? v <= min : v < min) || v > max) return invalid(file, path, `expected finite number ${exclusive ? ">" : ">="} ${min} and <= ${max}`);
  return v;
}
function coords(v: unknown, path: string): void {
  if (!Array.isArray(v) || v.length !== 2) return invalid("network.json", path, "expected [latitude, longitude]");
  num(v[0], "network.json", `${path}[0]`, -90, 90); num(v[1], "network.json", `${path}[1]`, -180, 180);
}
function parseJson(text: string, file: string): unknown {
  try { return JSON.parse(text); } catch { return invalid(file, "$", "invalid JSON"); }
}

type Asset = { facility: NetworkFacility; kind: "facility" | "well" | "tank" | "pump" | "pipeline"; wellIndex?: number };
function validate(networkValue: unknown, opsValue: unknown): { network: Network; ops: Operations; assets: Map<string, Asset>; facilities: NetworkFacility[] } {
  const file = "network.json", root = obj(networkValue, file, "$"), defaults = obj(root.defaults, file, "defaults"), limits = obj(defaults.tank_limits_pct, file, "defaults.tank_limits_pct");
  const warning = num(limits.warning, file, "warning", 0, 100), shutdown = num(limits.shutdown, file, "shutdown", 0, 100, true);
  if (warning >= shutdown) invalid(file, "defaults.tank_limits_pct", "warning must be below shutdown");
  if (root.meta !== undefined) {
    const meta = obj(root.meta, file, "meta");
    if (meta.timezone !== undefined) str(meta.timezone, file, "meta.timezone");
    if (meta.units !== undefined) {
      const units = obj(meta.units, file, "meta.units");
      for (const [key, value] of Object.entries(units)) str(value, file, `meta.units.${key}`);
      for (const [key, value] of Object.entries({ volume: "bbl", rate: "bpd", gas_rate: "mcfd", pressure: "psi" }))
        if (units[key] !== undefined && units[key] !== value) invalid(file, `meta.units.${key}`, `expected ${value}`);
    }
  }
  const ids = new Set<string>(), assets = new Map<string, Asset>(), facilities: NetworkFacility[] = [];
  const id = (v: unknown, path: string) => { const s = str(v, file, path); if (unsafe.has(s) || ids.has(s)) invalid(file, path, "unsafe or duplicate ID"); ids.add(s); return s; };
  const systems = arr(root.systems, file, "systems");
  for (const [si, sv] of systems.entries()) {
    const p = `systems[${si}]`, system = obj(sv, file, p); id(system.id, `${p}.id`); coords(system.center, `${p}.center`); coords(system.truck_yard, `${p}.truck_yard`);
    const d = obj(system.disposal_site, file, `${p}.disposal_site`); id(d.id, `${p}.disposal_site.id`);
    num(d.lat, file, `${p}.disposal_site.lat`, -90, 90); num(d.lon, file, `${p}.disposal_site.lon`, -180, 180); num(d.pressure_psi, file, `${p}.disposal_site.pressure_psi`);
    for (const [fi, fv] of arr(system.facilities, file, `${p}.facilities`).entries()) {
      const q = `${p}.facilities[${fi}]`, f = obj(fv, file, q), fid = id(f.id, `${q}.id`);
      num(f.lat, file, `${q}.lat`, -90, 90); num(f.lon, file, `${q}.lon`, -180, 180);
      const facility = f as unknown as NetworkFacility; facilities.push(facility); assets.set(fid, { facility, kind: "facility" });
      for (const [wi, wv] of arr(f.wells, file, `${q}.wells`).entries()) {
        const w = obj(wv, file, `${q}.wells[${wi}]`), wid = id(w.id, `${q}.wells[${wi}].id`);
        for (const key of ["baseline_water_bpd", "oil_bpd", "gas_mcfd"]) num(w[key], file, `${q}.wells[${wi}].${key}`);
        assets.set(wid, { facility, kind: "well", wellIndex: wi });
      }
      for (const kind of ["tank", "pump", "pipeline"] as const) {
        const part = obj(f[kind], file, `${q}.${kind}`), partId = id(part.id, `${q}.${kind}.id`); assets.set(partId, { facility, kind });
        if (kind === "tank") num(part.capacity_bbl, file, `${q}.tank.capacity_bbl`, 0, Infinity, true);
        if (kind === "pump") {
          num(part.max_flow_bpd, file, `${q}.pump.max_flow_bpd`, 0, Infinity, true);
          const start = num(part.start_level_pct, file, `${q}.pump.start_level_pct`, 0, 100), stop = num(part.stop_level_pct, file, `${q}.pump.stop_level_pct`, 0, 100);
          if (stop >= start) invalid(file, `${q}.pump`, "stop level must be below start level");
        }
        if (kind === "pipeline") for (const key of ["max_bpd", "max_pressure_psi"]) if (part[key] !== undefined) num(part[key], file, `${q}.pipeline.${key}`, 0, Infinity, true);
      }
    }
  }
  const of = "ops.json", o = obj(opsValue, of, "$"), prices = obj(o.prices, of, "prices"), repair = obj(o.expected_repair_hours, of, "expected_repair_hours"), truck = obj(o.emergency_trucking, of, "emergency_trucking"), os = obj(o.systems, of, "systems");
  if (o.dataset_id !== undefined) str(o.dataset_id, of, "dataset_id");
  for (const k of ["oil_per_bbl", "gas_per_mcf"]) num(prices[k], of, `prices.${k}`);
  num(repair.pump_failure, of, "expected_repair_hours.pump_failure", 0, Infinity, true);
  num(truck.truck_capacity_bbl, of, "emergency_trucking.truck_capacity_bbl", 0, Infinity, true); num(truck.cost_per_trip, of, "emergency_trucking.cost_per_trip");
  const expectedSystems = new Set<string>();
  for (const sv of systems) {
    const s = sv as Obj, sid = s.id as string; expectedSystems.add(sid);
    if (!Object.hasOwn(os, sid)) invalid(of, `systems.${sid}`, "missing system");
    const so = obj(os[sid], of, `systems.${sid}`), fleet = num(so.emergency_fleet_size, of, `systems.${sid}.emergency_fleet_size`);
    if (!Number.isSafeInteger(fleet)) invalid(of, `systems.${sid}.emergency_fleet_size`, "expected integer");
    const fs = obj(so.facilities, of, `systems.${sid}.facilities`), expected = new Set<string>();
    for (const fv of s.facilities as Obj[]) {
      const fid = fv.id as string; expected.add(fid);
      if (!Object.hasOwn(fs, fid)) invalid(of, `systems.${sid}.facilities.${fid}`, "missing facility");
      const fo = obj(fs[fid], of, `systems.${sid}.facilities.${fid}`);
      num(fo.response_min, of, `systems.${sid}.facilities.${fid}.response_min`); num(fo.cycle_min, of, `systems.${sid}.facilities.${fid}.cycle_min`, 0, Infinity, true);
    }
    for (const key of Object.keys(fs)) if (!expected.has(key)) invalid(of, `systems.${sid}.facilities.${key}`, "unknown facility");
  }
  for (const key of Object.keys(os)) if (!expectedSystems.has(key)) invalid(of, `systems.${key}`, "unknown system");
  return { network: root as unknown as Network, ops: o as unknown as Operations, assets, facilities };
}

// RFC 4180-style fields, including quoted commas, quotes, and newlines.
function* csv(text: string): Generator<string[]> {
  let row: string[] = [], field = "", quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } } else field += c; continue; }
    if (c === '"') { if (field || closed) invalid("telemetry.csv", "row", "unexpected quote"); quoted = true; }
    else if (c === ",") { row.push(field); field = ""; closed = false; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(field); yield row; row = []; field = ""; closed = false; }
    else { if (closed) invalid("telemetry.csv", "row", "characters after closing quote"); field += c; }
  }
  if (quoted) invalid("telemetry.csv", "row", "unterminated quote");
  if (field || row.length || closed) { row.push(field); yield row; }
}

const metrics: Record<Asset["kind"], string[]> = { facility: ["inflow_bpd"], well: ["water_bpd", "status"], tank: ["level_pct"], pump: ["status", "flow_bpd", "discharge_psi"], pipeline: ["receive_flow_bpd", "pressure_psi"] };
const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
export async function importDataset(files: { network: string; ops: string; telemetry: string }, label?: string): Promise<ImportedDataset> {
  if (!files || typeof files.network !== "string" || typeof files.ops !== "string" || typeof files.telemetry !== "string") invalid("upload", "$", "network, ops and telemetry contents required");
  if (Object.keys(files).some(key => !["network", "ops", "telemetry"].includes(key))) invalid("upload", "$", "only network, ops and telemetry are allowed");
  if (Buffer.byteLength(files.telemetry, "utf8") > MAX_TELEMETRY_BYTES) invalid("telemetry.csv", "$", "file exceeds size limit");
  const { network, ops, assets, facilities } = validate(parseJson(files.network, "network.json"), parseJson(files.ops, "ops.json"));
  const warnings: string[] = []; let invalidValues = 0, duplicates = 0, count = 0, min = Infinity, max = -Infinity;
  const samples: TelemetrySample[] = [], seen = new Map<string, TelemetrySample>();
  let header = true;
  for (const row of csv(files.telemetry.replace(/^\uFEFF/, ""))) {
    if (header) { header = false; if (row.join(",") !== "timestamp,ts_unix,asset_id,metric,value") invalid("telemetry.csv", "header", "expected timestamp,ts_unix,asset_id,metric,value"); continue; }
    if (++count > MAX_TELEMETRY_RECORDS) invalid("telemetry.csv", "$", "record limit exceeded");
    const path = `row ${count + 1}`;
    if (row.length !== 5) invalid("telemetry.csv", path, "expected five columns");
    const [timestamp, ts, assetId, metric, raw] = row as [string, string, string, string, string];
    if (!/^\d+$/.test(ts) || !Number.isSafeInteger(Number(ts))) invalid("telemetry.csv", path, "invalid ts_unix");
    const time = Number(ts), millis = Date.parse(timestamp);
    if (!Number.isFinite(millis) || millis !== time * 1000 || !/(?:Z|[+-]\d\d:\d\d)$/i.test(timestamp)) invalid("telemetry.csv", path, "timestamp must match ts_unix and include timezone");
    const asset = assets.get(assetId); if (!asset || !metrics[asset.kind].includes(metric)) invalid("telemetry.csv", path, "unknown asset or metric for asset");
    const text = raw.trim();
    if (text && !numeric.test(text) && !/^[+-]?(?:infinity|nan)$/i.test(text)) invalid("telemetry.csv", path, "invalid numeric value");
    let value: number | null = numeric.test(text) ? Number(text) : null;
    if (value !== null && !Number.isFinite(value)) value = null;
    if (metric === "status" && value !== null && !(asset.kind === "well" ? [0, 1] : [0, 1, 2]).includes(value)) value = null;
    if (value === null) invalidValues++;
    const key = JSON.stringify([time, assetId, metric]), old = seen.get(key);
    if (old) { if (old.value !== value || (value === null && (old as TelemetrySample & { raw?: string }).raw !== raw)) invalid("telemetry.csv", path, "conflicting duplicate observation"); duplicates++; continue; }
    const sample: TelemetrySample = { tsUnix: time, assetId, metric, value };
    // Keep invalid raw values only for duplicate comparison; samples retain the normalized contract.
    if (value === null) Object.defineProperty(sample, "raw", { value: raw, enumerable: false });
    seen.set(key, sample); samples.push(sample); min = Math.min(min, time); max = Math.max(max, time);
  }
  if (!samples.length) invalid("telemetry.csv", "$", "no observations");
  for (const sample of samples) if ((sample.tsUnix - min) % 300 !== 0) invalid("telemetry.csv", "ts_unix", "timestamps must lie on one 300-second grid");
  const steps = (max - min) / 300 + 1;
  if (steps > MAX_TIMESTEPS || steps * facilities.length > MAX_FRAMES) invalid("telemetry.csv", "$", "timeline or frame limit exceeded");
  samples.sort ( (a, b) => a.tsUnix - b.tsUnix );
  const frames: Frame[] = [];
  for (let time = min; time <= max; time += 300) for (const f of facilities) {
    const get = (id: string, metric: string) => seen.get(JSON.stringify([time, id, metric]))?.value ?? null;
    frames.push({ facilityId: f.id, tsUnix: time, inflowBpd: get(f.id, "inflow_bpd"), levelPct: get(f.tank.id, "level_pct"), pumpStatus: get(f.pump.id, "status"), pumpFlowBpd: get(f.pump.id, "flow_bpd"), receiveFlowBpd: get(f.pipeline.id, "receive_flow_bpd"), dischargePsi: get(f.pump.id, "discharge_psi"), pipelinePsi: get(f.pipeline.id, "pressure_psi"), wellStatus: f.wells.map(w => get(w.id, "status")), wellWaterBpd: f.wells.map(w => get(w.id, "water_bpd")) });
  }
  if (invalidValues) warnings.push(`${invalidValues} invalid or missing observation values converted to null`);
  if (duplicates) warnings.push(`${duplicates} duplicate observations deduplicated`);
  const expectedPerStep = facilities.reduce((n, f) => n + 7 + 2 * f.wells.length, 0);
  const missing = steps * expectedPerStep - samples.length;
  if (missing > 0) warnings.push(`${missing} observations missing from the time grid`);
  const hardwareReasons: string[] = [];
  if (facilities.length > 32) hardwareReasons.push("More than 32 facilities");
  if (facilities.some(f => f.wells.length > 8)) hardwareReasons.push("More than 8 wells in a facility");
  const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
  const fileHashes = { "network.json": hash(files.network), "ops.json": hash(files.ops), "telemetry.csv": hash(files.telemetry) };
  const id = hash(JSON.stringify(fileHashes));
  return { info: { id, label: label?.trim() || ops.dataset_id || id.slice(0, 12), startUnix: min, nowUnix: max, status: "ready", createdAt: new Date().toISOString(), fileHashes, warnings, hardwareEligible: hardwareReasons.length === 0, hardwareReasons }, network, ops, samples, frames };
}
