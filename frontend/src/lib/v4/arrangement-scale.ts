// Pure time <-> x scale, zoom/pan and gridline helpers for the Arrangement (no React, no DOM).
import { stamp } from "./format";

/** Visible time range in unix seconds. */
export interface View { t0: number; t1: number }
/** Whole range the arrangement can show (dataset start to the end of the projected zone). */
export interface Bounds { start: number; end: number }

export const MIN_SPAN_SECONDS = 15 * 60;

export const viewSpan = (v: View) => v.t1 - v.t0;

export function timeToX(view: View, width: number, t: number): number {
  const span = viewSpan(view);
  return span > 0 ? ((t - view.t0) / span) * width : 0;
}

export function xToTime(view: View, width: number, x: number): number {
  return width > 0 ? view.t0 + (x / width) * viewSpan(view) : view.t0;
}

/** Keeps the span (when it fits) and slides the view inside the bounds. */
export function clampView(view: View, bounds: Bounds, minSpan = MIN_SPAN_SECONDS): View {
  const total = Math.max(minSpan, bounds.end - bounds.start);
  const span = Math.min(total, Math.max(minSpan, viewSpan(view)));
  let t0 = view.t0;
  if (t0 < bounds.start) t0 = bounds.start;
  if (t0 + span > bounds.start + total) t0 = bounds.start + total - span;
  return { t0, t1: t0 + span };
}

/** Zoom by `factor` (> 1 zooms in) keeping `anchorT` at the same screen position. */
export function zoomView(view: View, bounds: Bounds, anchorT: number, factor: number, minSpan = MIN_SPAN_SECONDS): View {
  if (!Number.isFinite(factor) || factor <= 0) return view;
  const span = viewSpan(view);
  const total = Math.max(minSpan, bounds.end - bounds.start);
  const nextSpan = Math.min(total, Math.max(minSpan, span / factor));
  const ratio = span > 0 ? (anchorT - view.t0) / span : 0.5;
  const t0 = anchorT - ratio * nextSpan;
  return clampView({ t0, t1: t0 + nextSpan }, bounds, minSpan);
}

/** Slide the view by dt seconds (positive moves later). */
export function panView(view: View, bounds: Bounds, dt: number): View {
  return clampView({ t0: view.t0 + dt, t1: view.t1 + dt }, bounds);
}

export type TickKind = "hour" | "six" | "day";
export interface Tick { t: number; kind: TickKind; label: string | null }

const HOUR = 3600;
const LABEL_STEPS_H = [1, 2, 3, 6, 12, 24];
const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Gridlines and ruler labels for a view. Hourly lines only when they are at least 5px apart, 6h lines when at
 * least 8px apart, otherwise only day lines. Labels never closer than 34px. Times are UTC like every clock here.
 */
export function gridTicks(view: View, widthPx: number): Tick[] {
  const span = viewSpan(view);
  if (!(span > 0) || !(widthPx > 0)) return [];
  const pxPerHour = (widthPx / span) * HOUR;
  const step = pxPerHour >= 5 ? 1 : pxPerHour * 6 >= 8 ? 6 : 24;
  const labelStep = LABEL_STEPS_H.find((h) => h * pxPerHour >= 34) ?? 24;
  const out: Tick[] = [];
  const first = Math.ceil(view.t0 / (step * HOUR)) * step * HOUR;
  for (let t = first; t <= view.t1; t += step * HOUR) {
    const hour = new Date(t * 1000).getUTCHours();
    const kind: TickKind = hour === 0 ? "day" : hour % 6 === 0 ? "six" : "hour";
    let label: string | null = null;
    if (kind === "day") label = stamp(t).slice(0, 6);
    else if (hour % labelStep === 0) label = pad2(hour);
    out.push({ t, kind, label });
  }
  return out;
}
