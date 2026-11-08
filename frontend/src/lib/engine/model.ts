// Facility context + network-wide calibration, all derived from the loaded files.
import { getQuality, getSeries, type LoadedDataset, type NetFacility, type NetSystem, type NetWell } from "./datasets";

export interface WellCtx {
  w: NetWell;
  water: Float64Array;
  status: Float64Array;
  revenuePerHour: number; // lost revenue per hour if shut in
}

export interface FacilityCtx {
  sys: NetSystem;
  fac: NetFacility;
  letter: string;
  level: Float64Array;
  inflow: Float64Array;
  pumpStatus: Float64Array;
  flow: Float64Array;
  dischargePsi: Float64Array;
  recv: Float64Array;
  pipePsi: Float64Array;
  wells: WellCtx[];
  revenuePerHour: number;
  disposalPsi: number;
  // per-step quality of the key channels (see datasets.ts Q_*)
  quality: {
    level: { q: Uint8Array; lastObs: Int32Array };
    pumpStatus: { q: Uint8Array; lastObs: Int32Array };
    flow: { q: Uint8Array; lastObs: Int32Array };
    inflow: { q: Uint8Array; lastObs: Int32Array };
  };
}

export interface Calibration {
  pipeOffRun: number; // pipeline psi - disposal psi while running (healthy)
  disOffRun: number; // discharge psi - disposal psi while running (healthy)
  flowRatio: number; // flow / max_flow while running (healthy)
  lossFrac: number; // (flow - receive)/flow while running (healthy)
  sPipe: number;
  sDis: number;
  sRatio: number;
  sLoss: number;
}

export function wellRevenuePerHour(ds: LoadedDataset, w: NetWell): number {
  const p = ds.ops.prices;
  return (w.oil_bpd * p.oil_per_bbl + w.gas_mcfd * p.gas_per_mcf) / 24;
}

export function facilityContexts(ds: LoadedDataset): FacilityCtx[] {
  const out: FacilityCtx[] = [];
  for (const sys of ds.network.systems) {
    for (const fac of sys.facilities) {
      const wells = fac.wells.map((w) => ({
        w,
        water: getSeries(ds, w.id, "water_bpd"),
        status: getSeries(ds, w.id, "status"),
        revenuePerHour: wellRevenuePerHour(ds, w),
      }));
      const m = /_FACILITY_(.+)$/i.exec(fac.id) ?? /_([A-Za-z0-9]+)$/.exec(fac.id);
      out.push({
        sys,
        fac,
        letter: m ? m[1] : fac.id,
        level: getSeries(ds, fac.tank.id, "level_pct"),
        inflow: getSeries(ds, fac.id, "inflow_bpd"),
        pumpStatus: getSeries(ds, fac.pump.id, "status"),
        flow: getSeries(ds, fac.pump.id, "flow_bpd"),
        dischargePsi: getSeries(ds, fac.pump.id, "discharge_psi"),
        recv: getSeries(ds, fac.pipeline.id, "receive_flow_bpd"),
        pipePsi: getSeries(ds, fac.pipeline.id, "pressure_psi"),
        wells,
        revenuePerHour: wells.reduce((a, w) => a + w.revenuePerHour, 0),
        disposalPsi: sys.disposal_site.pressure_psi,
        quality: {
          level: getQuality(ds, fac.tank.id, "level_pct"),
          pumpStatus: getQuality(ds, fac.pump.id, "status"),
          flow: getQuality(ds, fac.pump.id, "flow_bpd"),
          inflow: getQuality(ds, fac.id, "inflow_bpd"),
        },
      });
    }
  }
  return out;
}

function median(a: number[]): number {
  if (!a.length) return NaN;
  const s = a.slice().sort((x, y) => x - y);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}
function mad(a: number[], m: number): number {
  return 1.4826 * median(a.map((x) => Math.abs(x - m)));
}

/** Healthy running-state baselines and noise, pooled across every facility (robust to the few that are sick). */
export function calibrate(facs: FacilityCtx[], N: number): Calibration {
  const pipe: number[] = [];
  const dis: number[] = [];
  const ratio: number[] = [];
  const loss: number[] = [];
  for (const f of facs) {
    for (let i = 0; i <= N; i++) {
      if (f.pumpStatus[i] !== 1 || !(f.flow[i] > 0)) continue;
      // skip steps with a missing reading (gaps longer than the hold limit are NaN)
      if (!Number.isFinite(f.pipePsi[i]) || !Number.isFinite(f.dischargePsi[i]) || !Number.isFinite(f.recv[i])) continue;
      pipe.push(f.pipePsi[i] - f.disposalPsi);
      dis.push(f.dischargePsi[i] - f.disposalPsi);
      ratio.push(f.flow[i] / f.fac.pump.max_flow_bpd);
      loss.push((f.flow[i] - f.recv[i]) / f.flow[i]);
    }
  }
  const pipeOffRun = median(pipe);
  const disOffRun = median(dis);
  const flowRatio = median(ratio);
  const lossFrac = median(loss);
  const floor = (x: number, f: number) => (Number.isFinite(x) && x > f ? x : f);
  return {
    pipeOffRun: Number.isFinite(pipeOffRun) ? pipeOffRun : 0,
    disOffRun: Number.isFinite(disOffRun) ? disOffRun : 0,
    flowRatio: Number.isFinite(flowRatio) ? flowRatio : 1,
    lossFrac: Number.isFinite(lossFrac) ? lossFrac : 0,
    sPipe: floor(mad(pipe, pipeOffRun), 0.5),
    sDis: floor(mad(dis, disOffRun), 0.5),
    sRatio: floor(mad(ratio, flowRatio), 0.001),
    sLoss: floor(mad(loss, lossFrac), 0.001),
  };
}

export const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function clock(unix: number): string {
  const d = new Date(unix * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
/** "11:05" if same UTC day as ref, else "Thu 11:05" */
export function when(unix: number, refUnix: number): string {
  const a = new Date(unix * 1000);
  const b = new Date(refUnix * 1000);
  const same = a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
  return same ? clock(unix) : `${DAY[a.getUTCDay()]} ${clock(unix)}`;
}
export function fmtDur(min: number): string {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r}m`;
  return `${h}h ${String(r).padStart(2, "0")}m`;
}
/** Last finite value at or before step i (NaN if none). */
export function lastFinite(arr: Float64Array, i: number): number {
  for (let k = Math.min(i, arr.length - 1); k >= 0; k--) if (Number.isFinite(arr[k])) return arr[k];
  return NaN;
}
export function fmtNum(x: number): string {
  return Math.round(x).toLocaleString("en-US");
}
