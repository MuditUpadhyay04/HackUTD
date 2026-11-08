// Problem detection from readings only.
//  pump_failure     : pump status 2 (fault). Onset = first fault reading, end = first non-fault reading.
//  pipeline_leak    : while pumping, pipeline pressure at the disposal end sags below the healthy
//                     running offset AND the pipeline receives less than the pump sends.
//  pump_degradation : while pumping, flow drifts below max_flow_bpd AND discharge pressure sags.
// Healthy offsets and noise levels are calibrated from the data itself (pooled over all facilities),
// so nothing about a particular network is hardcoded.
import type { Category } from "./types";
import { calibrate, clock, fmtNum, lastFinite, when, type Calibration, type FacilityCtx } from "./model";
import type { LoadedDataset } from "./datasets";

export interface RawEvent {
  category: Category;
  fc: FacilityCtx;
  assetId: string;
  onsetIdx: number;
  endIdx: number | null; // first index known resolved; null = ongoing at N
  detectIdx: number; // index at which the detector became sure
  confidence: number;
  evidence: string[];
  estLeakBblPerDay?: number;
  capacityLossPct?: number;
  _fit?: { a: number; b: number; gapStart: number }; // internal: onset fit
}

// Tunables (in noise units, so they transfer across networks).
const P = {
  leak: { W: 6, zOn: 7, persist: 3, offN: 3, zOff: 1.5 },
  deg: { W: 24, zOn: 7, persist: 3, offN: 6, zOff: 1.0 },
  lookbackSteps: 48 * 12,
};

interface Sample {
  i: number; // step index
  zLeak: number;
  zDeg: number;
  loss: number; // flow - recv (bbl/day) minus healthy loss
  lossPct: number;
  psiDrop: number; // pipeline psi below healthy running value
  ratio: number; // flow / max_flow
  disDrop: number; // discharge psi below healthy running value
  flow: number;
}

function samplesFor(fc: FacilityCtx, cal: Calibration, N: number): Sample[] {
  const out: Sample[] = [];
  const max = fc.fac.pump.max_flow_bpd;
  for (let i = 0; i <= N; i++) {
    if (fc.pumpStatus[i] !== 1 || !(fc.flow[i] > 0)) continue;
    // a step with any missing reading (gap past the hold limit) is not evidence either way
    if (!Number.isFinite(fc.recv[i]) || !Number.isFinite(fc.pipePsi[i]) || !Number.isFinite(fc.dischargePsi[i])) continue;
    const flow = fc.flow[i];
    const lossFrac = (flow - fc.recv[i]) / flow - cal.lossFrac;
    const psiDrop = cal.pipeOffRun - (fc.pipePsi[i] - fc.disposalPsi);
    const ratio = flow / max;
    const disDrop = cal.disOffRun - (fc.dischargePsi[i] - fc.disposalPsi);
    const zLeak = (psiDrop / cal.sPipe + lossFrac / cal.sLoss) / Math.SQRT2;
    const zDeg = ((cal.flowRatio - ratio) / cal.sRatio + disDrop / cal.sDis) / Math.SQRT2;
    out.push({ i, zLeak, zDeg, loss: lossFrac * flow, lossPct: lossFrac * 100, psiDrop, ratio, disDrop, flow });
  }
  return out;
}

/** Least-squares hinge fit y = [t>=t0]·(a + b(t-t0)), a,b >= 0. Returns best t0 (step index). */
function hingeOnset(ss: Sample[], key: "zLeak" | "zDeg", lo: number, hi: number, allowJump: boolean): { t0: number; a: number; b: number } {
  if (!ss.length || hi <= lo) return { t0: hi, a: 0, b: 0 };
  let best = hi;
  let bestA = 0;
  let bestB = 0;
  let bestSse = Infinity;
  for (let t0 = lo; t0 <= hi; t0++) {
    let pre = 0;
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
    for (const s of ss) {
      const y = s[key];
      if (s.i < t0) {
        pre += y * y;
        continue;
      }
      const x = s.i - t0;
      n++;
      sx += x;
      sy += y;
      sxx += x * x;
      sxy += x * y;
      syy += y * y;
    }
    if (n === 0) continue;
    let a = 0;
    let b = 0;
    if (allowJump) {
      const den = n * sxx - sx * sx;
      if (den > 1e-9) {
        b = (n * sxy - sx * sy) / den;
        a = (sy - b * sx) / n;
      } else {
        a = sy / n;
      }
      if (a < 0) {
        a = 0;
        b = sxx > 0 ? Math.max(0, sxy / sxx) : 0;
      } else if (b < 0) {
        b = 0;
        a = Math.max(0, sy / n);
      }
    } else {
      b = sxx > 0 ? Math.max(0, sxy / sxx) : 0;
    }
    const sse = pre + syy - 2 * a * sy - 2 * b * sxy + a * a * n + 2 * a * b * sx + b * b * sxx;
    // ties (e.g. anywhere inside a pump-off gap) resolve to the LATEST t0
    if (sse <= bestSse + 1e-6 * Math.max(1, Math.abs(bestSse))) {
      if (sse < bestSse) bestSse = sse;
      best = t0;
      bestA = a;
      bestB = b;
    }
  }
  return { t0: best, a: bestA, b: bestB };
}

function conf(z: number): number {
  return Math.max(0.05, Math.min(0.99, 1 - Math.exp(-Math.max(0, z) / 5)));
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export interface DetectResult {
  events: RawEvent[];
  cal: Calibration;
}

export function detect(ds: LoadedDataset, facs: FacilityCtx[], N: number): DetectResult {
  const cal = calibrate(facs, N);
  const t = (i: number) => ds.t0 + i * ds.dt;
  const nowU = t(N);
  const events: RawEvent[] = [];

  for (const fc of facs) {
    // ---------- pump failures ----------
    const failures: { on: number; off: number | null }[] = [];
    // Read the status array once into a local. Node 26.13's optimizing JIT intermittently
    // mis-ran the original form of this loop (~1 in 3 cold runs ended a fault early); the
    // local + i+1 start was 0 failures in 30 runs. See breaktest/jit-repro.
    // A fault lasts until a non-fault status is actually read: missing status (NaN, past the hold
    // limit) after a fault keeps the fault open instead of ending it because the data stopped.
    const ps = fc.pumpStatus;
    for (let i = 0; i <= N; i++) {
      if (ps[i] === 2 && (i === 0 || ps[i - 1] !== 2)) {
        let j = i + 1;
        while (j <= N && (ps[j] === 2 || Number.isNaN(ps[j]))) j++;
        failures.push({ on: i, off: j <= N ? j : null });
        i = j;
      }
    }
    for (const f of failures) {
      const endI = f.off ?? N + 1;
      let flowSum = 0;
      let cnt = 0;
      for (let i = f.on; i < Math.min(endI, N + 1); i++) {
        if (!Number.isFinite(fc.flow[i])) continue;
        flowSum += fc.flow[i];
        cnt++;
      }
      const zeroFlow = cnt > 0 && flowSum / cnt < 0.02 * fc.fac.pump.max_flow_bpd;
      const lvlStart = lastFinite(fc.level, f.on);
      const lvlEnd = lastFinite(fc.level, Math.min(endI - 1, N));
      const lvlKnown = Number.isFinite(lvlStart) && Number.isFinite(lvlEnd);
      const ev: string[] = [];
      ev.push(
        f.off === null
          ? `Pump ${fc.fac.pump.id} reporting fault since ${when(t(f.on), nowU)}`
          : `Pump ${fc.fac.pump.id} reported a fault from ${when(t(f.on), nowU)} to ${when(t(f.off), nowU)}`
      );
      if (zeroFlow)
        ev.push(
          !lvlKnown
            ? "Pump flow at 0 bpd"
            : `Pump flow at 0 bpd while the tank ${lvlEnd > lvlStart + 0.5 ? `rose from ${lvlStart.toFixed(0)}% to ${lvlEnd.toFixed(0)}%` : "holds water"}`
        );
      events.push({
        category: "pump_failure",
        fc,
        assetId: fc.fac.pump.id,
        onsetIdx: f.on,
        endIdx: f.off,
        detectIdx: f.on,
        confidence: zeroFlow ? 0.99 : 0.8,
        evidence: ev,
      });
    }

    // ---------- leak & degradation over running samples ----------
    const ss = samplesFor(fc, cal, N);
    const failOnsets = new Set(failures.map((f) => f.on));
    const failEnds = failures.map((f) => f.off).filter((x): x is number => x !== null);

    for (const kind of ["leak", "deg"] as const) {
      const prm = P[kind];
      const key = kind === "leak" ? "zLeak" : "zDeg";
      let resetP = 0; // window only uses samples from here
      let resetIdx = 0; // step index boundary for onset search
      let on = false;
      let streak = 0;
      let detectP = -1;
      let maxZ = 0;
      let lastFailCheck = 0;

      const close = (endIdx: number | null, endP: number) => {
        const lo = Math.max(resetIdx, ss[detectP].i - P.lookbackSteps);
        const hi = ss[detectP].i;
        const fitSet = ss.slice(0, endP).filter((s) => s.i >= lo);
        const fit = hingeOnset(fitSet, key, lo, hi, kind === "leak");
        const onset = fit.t0;
        const firstAt = fitSet.findIndex((x) => x.i >= fit.t0);
        const prevRun = firstAt > 0 ? fitSet[firstAt - 1].i : lo - 1;
        // recent stats for evidence
        const recent = ss.slice(Math.max(resetP, endP - Math.max(prm.W, 12)), endP);
        const ongoing = endIdx === null;
        const zNow = mean(recent.map((s) => s[key])) * Math.sqrt(recent.length);
        // evidence ages while the pump sits idle: an ongoing call gets less certain the longer we can't see it
        const idleH = ongoing ? Math.max(0, (N - (recent.length ? recent[recent.length - 1].i : hi)) * ds.dt) / 3600 : 0;
        const confidence = conf(ongoing ? zNow : maxZ) * (1 - Math.min(0.4, idleH / 24));
        const lastRun = recent.length ? recent[recent.length - 1].i : hi;
        const ev: string[] = [];
        let estLeak: number | undefined;
        let capLoss: number | undefined;
        if (kind === "leak") {
          const lossPct = mean(recent.map((s) => s.lossPct));
          const psi = mean(recent.map((s) => s.psiDrop));
          estLeak = Math.max(0, mean(recent.map((s) => s.loss)));
          ev.push(
            `Pipeline ${fc.fac.pipeline.id} ${ongoing ? "delivering" : "delivered"} ${Math.max(0, lossPct).toFixed(lossPct < 10 ? 1 : 0)}% less water than the pump sends (~${fmtNum(estLeak)} bpd lost)`
          );
          if (psi > 2 * cal.sPipe) ev.push(`Pressure at the disposal end ${psi.toFixed(0)} psi below normal while pumping`);
        } else {
          const ratio = mean(recent.map((s) => s.ratio));
          const dis = mean(recent.map((s) => s.disDrop));
          capLoss = Math.max(0, ((cal.flowRatio - ratio) / cal.flowRatio) * 100);
          ev.push(
            `Pump ${fc.fac.pump.id} ${ongoing ? "moving" : "moved"} ${capLoss.toFixed(1)}% less water than its rated ${fmtNum(fc.fac.pump.max_flow_bpd)} bpd`
          );
          if (dis > 2 * cal.sDis) ev.push(`Discharge pressure ${dis.toFixed(0)} psi below normal`);
          // drift rate (% of rated per hour) over the event so far
          const evs = ss.slice(0, endP).filter((s) => s.i >= onset);
          if (evs.length >= 6) {
            let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
            for (const s of evs) {
              const x = ((s.i - onset) * ds.dt) / 3600;
              const y = (cal.flowRatio - s.ratio) * 100;
              n++; sx += x; sy += y; sxx += x * x; sxy += x * y;
            }
            const den = n * sxx - sx * sx;
            const slope = den > 0 ? (n * sxy - sx * sy) / den : 0;
            if (slope > 0.02) ev.push(`Flow falling about ${slope.toFixed(2)}% per hour since ${when(t(onset), nowU)}`);
          }
        }
        if (ongoing && lastRun < N - 1)
          ev.push(
            Number.isNaN(fc.pumpStatus[N]) || Number.isNaN(fc.flow[N])
              ? `No pump readings since ${when(t(lastRun), nowU)}; last pumping readings still showed the problem`
              : `Pump idle since ${when(t(lastRun + 1), nowU)}; last pumping readings still showed the problem`
          );
        events.push({
          category: kind === "leak" ? "pipeline_leak" : "pump_degradation",
          fc,
          assetId: kind === "leak" ? fc.fac.pipeline.id : fc.fac.pump.id,
          onsetIdx: onset,
          endIdx,
          detectIdx: hi,
          confidence,
          evidence: ev,
          estLeakBblPerDay: estLeak,
          capacityLossPct: capLoss,
          _fit: { a: fit.a, b: fit.b, gapStart: Math.max(lo, prevRun + 1) },
        });
      };

      for (let p = 0; p < ss.length; p++) {
        const s = ss[p];
        // pump failure between previous sample and this one
        if (kind === "deg") {
          let failAt = -1;
          for (let i = lastFailCheck; i <= s.i; i++) if (failOnsets.has(i)) failAt = i;
          lastFailCheck = s.i + 1;
          if (failAt >= 0) {
            if (on) close(failAt, p);
            on = false;
            streak = 0;
            resetP = p;
            const endF = failEnds.find((e) => e > failAt) ?? s.i;
            resetIdx = Math.min(endF, s.i);
          }
        }
        const from = Math.max(resetP, p - prm.W + 1);
        const win = ss.slice(from, p + 1);
        const zw = mean(win.map((x) => x[key])) * Math.sqrt(win.length);
        if (!on) {
          if (zw > prm.zOn && win.length >= Math.min(prm.W, 3)) {
            streak++;
            if (streak >= prm.persist) {
              on = true;
              detectP = p - prm.persist + 1;
              maxZ = zw;
            }
          } else streak = 0;
        } else {
          maxZ = Math.max(maxZ, zw);
          const sFrom = Math.max(resetP, p - prm.offN + 1);
          const shortWin = ss.slice(sFrom, p + 1);
          if (shortWin.length >= prm.offN && mean(shortWin.map((x) => x[key])) < prm.zOff) {
            close(ss[sFrom].i, sFrom);
            on = false;
            streak = 0;
            resetP = sFrom;
            resetIdx = ss[sFrom].i;
          }
        }
      }
      if (on) {
        // degradation also ends when the pump fails after the last running sample
        let failAt = -1;
        if (kind === "deg") for (let i = lastFailCheck; i <= N; i++) if (failOnsets.has(i)) failAt = i;
        close(failAt >= 0 ? failAt : null, ss.length);
      }
    }
  }
  // Leaks that began while the pump was idle are first seen when it restarts. Back-date them using
  // the typical initial leak size learned from leaks in this same dataset that were seen at onset.
  const seen = events.filter((e) => e.category === "pipeline_leak" && e._fit && e._fit.gapStart >= e.onsetIdx);
  const aRef = seen.length ? seen.map((e) => e._fit!.a).sort((x, y) => x - y)[seen.length >> 1] : NaN;
  if (Number.isFinite(aRef)) {
    for (const e of events) {
      if (e.category !== "pipeline_leak" || !e._fit || e._fit.gapStart >= e.onsetIdx || e._fit.b <= 0) continue;
      const shift = Math.round((e._fit.a - aRef) / e._fit.b);
      e.onsetIdx -= Math.max(0, Math.min(e.onsetIdx - e._fit.gapStart, shift));
    }
  }
  for (const e of events) delete e._fit;
  events.sort((a, b) => a.onsetIdx - b.onsetIdx);
  return { events, cal };
}

export { clock };
