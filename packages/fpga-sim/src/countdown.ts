/**
 * Tank shutdown countdown.
 *
 * Plan method (Sat 19:50): per facility, net inflow per step. Keep the last N =
 * 2^cdLog2 values. p50 = rolling mean, p10 = rolling max (soonest), p90 = rolling
 * min (latest). hours = 24 * C * max(shutdown - level, 0) / (100 * net_inflow).
 * Net inflow <= 0 => "not filling" sentinel (0xFFFF).
 *
 * Open O7 (review R1/R2): the plan's net-inflow ring (inflow - pump flow) reports
 * "not filling" at every pump-failure onset because the ring is full of negative
 * values from before onset. The host correction: while pump_fault is set, treat the
 * failed pump as moving 0 bpd (net = inflow). Also: check already-at-limit first
 * (level >= shutdown => countdown 0 for all three values), then the not-filling
 * check. This is a HOST correction, not a claimed FPGA fix. We preserve method,
 * source and version differences explicitly.
 */

import type { Countdown, FacilityConfig, GlobalConfig } from "./types.ts";

export const COUNTDOWN_NOT_FILLING = 0xffff;
const MAX_REPRESENTABLE_MINUTES = 0xffff; // ~45.5 days

function ringSize(cdLog2: number): number {
  return 1 << cdLog2;
}

export interface CountdownState {
  ring: number[];
  pos: number;
  filled: boolean;
}

export function initCountdownState(cdLog2: number): CountdownState {
  return { ring: new Array(ringSize(cdLog2)).fill(0), pos: 0, filled: false };
}

export function resetCountdownState(state: CountdownState, cdLog2: number): void {
  state.ring = new Array(ringSize(cdLog2)).fill(0);
  state.pos = 0;
  state.filled = false;
}

/** Add a net-inflow value to the ring. */
export function addNetInflow(state: CountdownState, value: number): void {
  state.ring[state.pos] = value;
  state.pos = (state.pos + 1) % state.ring.length;
  if (state.pos === 0) state.filled = true;
}

function ringValues(state: CountdownState): number[] {
  const n = state.ring.length;
  if (!state.filled && state.pos === 0) return [];
  const out: number[] = [];
  // Read from oldest to newest.
  let i = state.filled ? state.pos : 0;
  const count = state.filled ? n : state.pos;
  for (let k = 0; k < count; k++) {
    out.push(state.ring[i]);
    i = (i + 1) % n;
  }
  return out;
}

function mean(vals: number[]): number {
  if (vals.length === 0) return 0;
  let s = 0;
  for (const v of vals) s += v;
  return s / vals.length;
}

function maxVal(vals: number[]): number {
  let m = -Infinity;
  for (const v of vals) if (v > m) m = v;
  return m;
}

function minVal(vals: number[]): number {
  let m = Infinity;
  for (const v of vals) if (v < m) m = v;
  return m;
}

function hoursToLimit(
  cfg: FacilityConfig,
  levelPct: number,
  remainingBbl: number,
  netBpd: number,
): number {
  // Already at limit: countdown 0 (O7 already-at-limit check, before not-filling).
  if (levelPct >= cfg.shutdownLvl / 100) return 0;
  if (netBpd <= 0) return Infinity; // not filling
  return (24 * remainingBbl) / netBpd;
}

function minutesFromHours(h: number): number {
  if (!Number.isFinite(h) || h <= 0) return COUNTDOWN_NOT_FILLING;
  const m = Math.round(h * 60);
  if (m > MAX_REPRESENTABLE_MINUTES) return MAX_REPRESENTABLE_MINUTES;
  return m;
}

/**
 * Compute countdown for one record.
 *
 * pumpFault: whether the pump_fault rule bit is set for this record. When true,
 * the host correction uses pump flow = 0 (net = inflow).
 * levelPct: current tank level fraction (0..1).
 */
export function computeCountdown(
  cfg: FacilityConfig,
  global: GlobalConfig,
  state: CountdownState,
  inflowBpd: number,
  pumpFlowBpd: number,
  levelPct: number,
  pumpFault: boolean,
): Countdown {
  const N = ringSize(global.cdLog2);
  const C = cfg.C;
  const shutdownLvl = cfg.shutdownLvl / 100;

  // Already at limit => 0 for all three (O7 R2), before not-filling.
  if (levelPct >= shutdownLvl) {
    return { p10: 0, p50: 0, p90: 0, notFilling: false };
  }

  // Net inflow: O7 host correction - failed pump moves 0 bpd.
  const netBpd = pumpFault ? inflowBpd : inflowBpd - pumpFlowBpd;

  // Only add to the ring when we have a real (non-not-filling) observation to avoid
  // polluting the envelope with sentinel history. Not-filling steps still count as
  // memory depth via the feature pipeline; here we record the raw net value so the
  // ring reflects actual inflow behaviour. A not-filling value (<=0) is still a
  // legitimate ring entry for the min/max/mean envelope.
  addNetInflow(state, netBpd);

  const vals = ringValues(state);
  const remainingBbl = C * Math.max(shutdownLvl - levelPct, 0) / 100;

  const p50h = hoursToLimit(cfg, levelPct, remainingBbl, mean(vals));
  const p10h = hoursToLimit(cfg, levelPct, remainingBbl, maxVal(vals)); // soonest = max inflow
  const p90h = hoursToLimit(cfg, levelPct, remainingBbl, minVal(vals)); // latest = min inflow

  const p10 = minutesFromHours(p10h);
  const p50 = minutesFromHours(p50h);
  const p90 = minutesFromHours(p90h);

  const notFilling = p10 === COUNTDOWN_NOT_FILLING && p50 === COUNTDOWN_NOT_FILLING && p90 === COUNTDOWN_NOT_FILLING;

  return { p10, p50, p90, notFilling };
}
