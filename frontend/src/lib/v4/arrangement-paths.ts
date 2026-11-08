// Pure SVG path building for automation lanes. Missing samples (null) are gaps: the path is broken there and the
// span is reported as a gap so the UI can draw it as dither. A gap is never interpolated across and never read as 0.
import type { Series } from "@/lib/engine/types";

export interface Gap { t0: number; t1: number }
export interface SeriesPath {
  /** SVG path data. x = seconds since `base`, y in 0..100 with 0 at the top. Empty string when nothing is drawable. */
  d: string;
  gaps: Gap[];
}

const fin = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Longest hold we trust between two samples: 2.5x the median spacing, at least 15 minutes (matches derive.ts). */
export function maxGapOf(series: Series): number {
  const d: number[] = [];
  for (let i = 1; i < series.t.length; i++) d.push(series.t[i] - series.t[i - 1]);
  d.sort((a, b) => a - b);
  const med = d.length ? d[Math.floor(d.length / 2)] : 300;
  return Math.max(900, med * 2.5);
}

/** Spans of [window.start, window.end] where the series has no usable value. */
export function seriesGaps(series: Series, window: { start: number; end: number }, maxGap = maxGapOf(series)): Gap[] {
  const gaps: Gap[] = [];
  let prev: number | null = null; // time of the previous valid sample
  let prevIdx = -1;
  for (let i = 0; i < series.t.length; i++) {
    if (!fin(series.v[i])) continue;
    const t = series.t[i];
    if (prev == null) { if (t - window.start > maxGap) gaps.push({ t0: window.start, t1: t }); }
    else if (t - prev > maxGap || i - prevIdx > 1) gaps.push({ t0: prev, t1: t }); // long hold or null samples between
    prev = t;
    prevIdx = i;
  }
  if (prev == null) { if (window.end > window.start) gaps.push({ t0: window.start, t1: window.end }); }
  else if (window.end - prev > maxGap) gaps.push({ t0: prev, t1: window.end });
  return gaps;
}

/**
 * Path for a series. Values map y = 100 - (v - min) / (max - min) * 100, clamped to the lane.
 * A new sub-path ("M") starts after every null or over-long hold, so gaps are never bridged.
 */
export function seriesPath(series: Series, o: { base: number; min?: number; max: number; window: { start: number; end: number }; maxGap?: number }): SeriesPath {
  const min = o.min ?? 0;
  const range = o.max - min > 0 ? o.max - min : 1;
  const maxGap = o.maxGap ?? maxGapOf(series);
  let d = "";
  let pen = false;
  let prevT = -Infinity;
  let last: { x: number; y: number } | null = null;
  let segLen = 0;
  const closeSeg = () => {
    // A lone sample would draw nothing: give it 1 second of length so a round cap shows a dot.
    if (segLen === 1 && last) d += `L${r2(last.x + 1)} ${last.y}`;
    segLen = 0;
  };
  for (let i = 0; i < series.t.length; i++) {
    const v = series.v[i];
    const t = series.t[i];
    if (!fin(v)) { closeSeg(); pen = false; continue; }
    const x = r2(t - o.base);
    const y = r2(100 - Math.min(1, Math.max(0, (v - min) / range)) * 100);
    if (pen && t - prevT > maxGap) { closeSeg(); pen = false; }
    d += `${pen ? "L" : "M"}${x} ${y}`;
    pen = true;
    segLen += 1;
    prevT = t;
    last = { x, y };
  }
  closeSeg();
  return { d, gaps: seriesGaps(series, o.window, maxGap) };
}

/** Largest finite value, or 0. */
export function seriesMax(series: Series): number {
  let m = 0;
  for (const v of series.v) if (fin(v) && v > m) m = v;
  return m;
}

/** Projected plan curve (minutes from plan start) in the same x/y space as seriesPath. Non-finite points break it. */
export function curvePath(curve: { min: number; pct: number }[], planStartUnix: number, base: number): string {
  let d = "";
  let pen = false;
  for (const p of curve) {
    if (!Number.isFinite(p.min) || !Number.isFinite(p.pct)) { pen = false; continue; }
    const x = r2(planStartUnix + p.min * 60 - base);
    const y = r2(100 - Math.min(100, Math.max(0, p.pct)));
    d += `${pen ? "L" : "M"}${x} ${y}`;
    pen = true;
  }
  return d;
}
