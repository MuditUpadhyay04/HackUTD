// View model for one Pipe View line at playhead time t. Pure: every value comes from derive.ts (facilityAt,
// countdownAt) and the Snapshot. Missing data stays null and is never rendered as healthy (hard rule 9).
import type { FacilityState, Quality, Series, Snapshot } from "@/lib/engine/types";
import { countdownAt, facilityAt, type FacilityStatus } from "./derive";
import { countdownText } from "./format";
import type { PlayheadState } from "./store";

export type QLevel = 0 | 1 | 2 | 3;
export type Tone = "none" | "down" | "inspect" | "nodata";
export type Motion = "none" | "flow" | "worn" | "leak";

export interface AlarmVM { kind: "e_stop" | "night_shift"; text: string }

export interface LineVM {
  status: FacilityStatus;
  quality: Quality;
  /** 0 VALID, 1 HELD, 2 INVALID, 3 DROPPED or missing: drives the dither density of the line. */
  q: QLevel;
  levelPct: number | null;
  flowBpd: number | null;
  inflowBpd: number | null;
  receiveBpd: number | null;
  /** 0..1 pump flow relative to the pump's maxFlowBpd, in 0.05 steps. */
  flowRatio: number;
  inflowRatio: number;
  motion: Motion;
  redOn: boolean;
  wellsGrey: boolean;
  hatchPipe: boolean;
  hatchPump: boolean;
  tone: Tone;
  /** The single on-canvas label slot of the row (flow, or the state), already clipped. */
  slot: string;
  /** Full state text for the tooltip. */
  stateText: string;
  tankText: string;
  reasonText: string | null;
  etaText: string | null;
  alarm: AlarmVM | null;
  key: string;
}

export const SLOT_MAX = 20;
const clip = (s: string, n = SLOT_MAX) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);
const clean = (s: string) => s.replace(/[·•—–]/g, ",").replace(/\s+/g, " ").trim().toUpperCase();
const round = (n: number | null, step: number): number | null => (n == null ? null : Math.round(n / step) * step);
const Q_LEVEL: Record<Quality, QLevel> = { VALID: 0, HELD: 1, INVALID: 2, DROPPED: 3 };
const STEP = 300;

/** Minutes since the last non-null sample at or before t (null when there is none). */
export function staleMinutes(series: Series, t: number): number | null {
  let lo = 0, hi = series.t.length - 1, i = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series.t[mid] <= t) { i = mid; lo = mid + 1; } else hi = mid - 1;
  }
  while (i >= 0 && (series.v[i] == null || !Number.isFinite(series.v[i] as number))) i--;
  return i < 0 ? null : Math.max(0, Math.round((t - series.t[i]) / 60));
}

export function lineViewAt(snapshot: Snapshot, fac: FacilityState, t: number): LineVM {
  const a = facilityAt(snapshot, fac, t);
  const has = (c: string) => a.activeIncidents.some((i) => i.category === c);
  let q: QLevel = Q_LEVEL[a.quality];
  if (a.status === "nodata" && q === 0) q = 3;
  const bad = q > 0;

  const down = a.status === "down";
  const shut = a.status === "shut";
  const pumpFailure = has("pump_failure");
  const redOn = down || (shut && pumpFailure);
  const leakInc = a.activeIncidents.find((i) => i.category === "pipeline_leak");
  const wornInc = a.activeIncidents.find((i) => i.category === "pump_degradation");
  const failInc = a.activeIncidents.find((i) => i.category === "pump_failure");

  let stateText = "";
  let tone: Tone = "none";
  let etaText: string | null = null;
  if (down && failInc) {
    const c = countdownAt(failInc, snapshot, t);
    tone = "down";
    if (c.kind === "counting") { stateText = `SHUTDOWN ${countdownText(c.remainingHours?.p50)}`; etaText = `P10 ${countdownText(c.remainingHours?.p10)} TO P90 ${countdownText(c.remainingHours?.p90)}`; }
    else if (c.kind === "shut") stateText = "SHUTDOWN AT LIMIT";
    else if (c.kind === "not_filling") stateText = "PUMP DOWN, NOT FILLING";
    else stateText = "SHUTDOWN UNKNOWN";
  } else if (shut) { stateText = "SHUT IN"; tone = redOn ? "down" : "none"; }
  else if (a.status === "leak") { tone = "inspect"; stateText = leakInc?.estLeakBblPerDay != null ? `INSPECT ${Math.round(leakInc.estLeakBblPerDay)} BBL/D EST` : "INSPECT LEAK"; }
  else if (a.status === "worn") { tone = "inspect"; stateText = wornInc?.capacityLossPct != null ? `INSPECT ${Math.round(wornInc.capacityLossPct)}% CAP LOSS` : "INSPECT WORN PUMP"; }
  else if (a.status === "idle") stateText = "IDLE";

  // Data quality overrides the plain look: the line is grain, never healthy.
  const stale = Math.max(staleMinutes(fac.series.level, t) ?? 0, staleMinutes(fac.series.pumpFlow, t) ?? 0);
  const nearNow = Math.abs(t - snapshot.nowUnix) <= STEP;
  let reasonText: string | null = null;
  if (bad) {
    if (nearNow && fac.dataQuality.reasons.length > 0) reasonText = clean(fac.dataQuality.reasons[0]);
    else reasonText = stale > 0 ? `NO READINGS ${stale} MIN` : "NO READINGS";
    if (a.status === "nodata" || stateText === "") {
      if (q === 1) stateText = `HELD ${Math.max(stale, 5)} MIN`;
      else if (q === 2) stateText = "INVALID";
      else stateText = "NO DATA";
      tone = "nodata";
    }
  }

  const flowBpd = round(a.pumpFlowBpd, 10);
  let slot = stateText;
  if (!bad && a.status === "flowing") slot = flowBpd != null ? `${flowBpd.toLocaleString("en-US")} BPD` : "";
  slot = clip(slot);

  const max = Math.max(1, fac.pump.maxFlowBpd);
  const ratio = (v: number | null) => (v == null ? 0 : Math.round(Math.max(0, Math.min(1, v / max)) * 20) / 20);
  let motion: Motion = "none";
  if (!bad) {
    if (a.status === "flowing") motion = "flow";
    else if (a.status === "worn" && (a.pumpFlowBpd ?? 0) > 0) motion = "worn";
    else if (a.status === "leak" && (a.pumpFlowBpd ?? 0) > 0) motion = "leak";
  }

  let alarm: AlarmVM | null = null;
  const bf = snapshot.board?.facilities.find((f) => f.facilityId === fac.id);
  if (bf && bf.alarm !== "none" && bf.alarmState === "raised" && (bf.alarmSinceUnix == null || t >= bf.alarmSinceUnix)) {
    alarm = bf.alarm === "e_stop"
      ? { kind: "e_stop", text: "E-STOP (BOARD, DISPLAY ONLY)" }
      : { kind: "night_shift", text: "NIGHT SHIFT (BOARD, DISPLAY ONLY)" };
  }

  const levelPct = a.levelPct == null ? null : Math.round(a.levelPct);
  const vm: Omit<LineVM, "key"> = {
    status: a.status, quality: a.quality, q, levelPct, flowBpd,
    inflowBpd: round(a.inflowBpd, 10), receiveBpd: round(a.receiveFlowBpd, 10),
    flowRatio: ratio(a.pumpFlowBpd), inflowRatio: ratio(a.inflowBpd),
    motion, redOn, wellsGrey: shut, hatchPipe: a.status === "leak" && !bad, hatchPump: a.status === "worn" && !bad,
    tone, slot, stateText: stateText || (a.status === "flowing" ? "FLOWING" : ""),
    tankText: levelPct == null ? "UNKNOWN" : `${levelPct}%`, reasonText, etaText, alarm,
  };
  return { ...vm, key: JSON.stringify(vm) };
}

/**
 * A usePlayhead() selector for one line. Evaluated once per minute of data time and returns the previous object
 * while nothing visible changed, so 60 fps playhead updates do not re-render the line.
 */
export function makeLineSelector(snapshot: Snapshot, fac: FacilityState): (s: PlayheadState) => LineVM {
  let lastMinute = Number.NaN;
  let last: LineVM | null = null;
  return (s) => {
    const minute = Math.floor(s.t / 60);
    if (last && minute === lastMinute) return last;
    lastMinute = minute;
    const next = lineViewAt(snapshot, fac, minute * 60);
    if (!last || last.key !== next.key) last = next;
    return last;
  };
}
