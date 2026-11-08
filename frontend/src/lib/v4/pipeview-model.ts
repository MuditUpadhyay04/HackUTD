// View model for one Pipe View line at playhead time t. Pure: every value comes from derive.ts (facilityAt,
// countdownAt) and the Snapshot. Missing data stays null and is never rendered as healthy (hard rule 9).
import type { FacilityState, Quality, Series, Snapshot } from "@/lib/engine/types";
import { countdownAt, facilityAt, type Approved, type FacilityStatus } from "./derive";
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
  /** True when this facility needs attention (pump down, inspect, no data, shut in, board alarm): only these show a status pill at fit zoom. */
  problem: boolean;
  /** Short sentence-case text of the status pill (empty when there is no pill). */
  pillText: string;
  /** Pump flow label ("1,230 bpd"), shown on hover or at near zoom; empty when not flowing. */
  flowText: string;
  /** Full state text for the tooltip. */
  stateText: string;
  tankText: string;
  reasonText: string | null;
  etaText: string | null;
  alarm: AlarmVM | null;
  /**
   * The leak and wear classifier is unavailable (health "unknown") while the readings themselves are fine. The line
   * still draws as normal measured flow (facilityAt decides no-data only from dataQuality and missing samples); this
   * only adds a tooltip note. It never implies "healthy" (hard rule 9).
   */
  checksUnavailable: boolean;
  key: string;
}

export const PILL_MAX = 24;
const clip = (s: string, n = PILL_MAX) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);
/** Sentence case: first letter up, the rest as written. Never ALL CAPS. */
const sentence = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const clean = (s: string) => sentence(s.replace(/[·•—–]/g, ",").replace(/\s+/g, " ").trim());
/** Countdown as h:mm; "unknown" (never a number) when there is no estimate. */
const cd = (h: number | null | undefined) => (h == null || !Number.isFinite(h) ? "unknown" : countdownText(h));
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

export function lineViewAt(snapshot: Snapshot, fac: FacilityState, t: number, approved: Approved = []): LineVM {
  const a = facilityAt(snapshot, fac, t, approved);
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
  let pillText = "";
  let tone: Tone = "none";
  let etaText: string | null = null;
  if (down && failInc) {
    const c = countdownAt(failInc, snapshot, t, approved);
    tone = "down";
    if (c.kind === "counting") {
      stateText = `Pump down, shutdown in ${cd(c.remainingHours?.p50)}`;
      pillText = `Pump down ${cd(c.remainingHours?.p50)}`;
      etaText = `p10 ${cd(c.remainingHours?.p10)} to p90 ${cd(c.remainingHours?.p90)}`;
    } else if (c.kind === "shut") { stateText = "Shutdown at limit"; pillText = "Shut down"; }
    else if (c.kind === "not_filling") { stateText = "Pump down, not filling"; pillText = "Pump down"; }
    else if (c.kind === "averted") { stateText = "Pump down, shutdown averted"; pillText = "Pump down"; }
    else { stateText = "Pump down, shutdown time unknown"; pillText = "Pump down, unknown"; }
  } else if (shut) { stateText = "Shut in"; pillText = "Shut in"; tone = redOn ? "down" : "none"; }
  else if (a.status === "leak") {
    tone = "inspect";
    stateText = leakInc?.estLeakBblPerDay != null ? `Inspect, leak about ${Math.round(leakInc.estLeakBblPerDay)} bbl/d` : "Inspect leak";
    pillText = leakInc?.estLeakBblPerDay != null ? `Inspect ${Math.round(leakInc.estLeakBblPerDay)} bbl/d` : "Inspect leak";
  } else if (a.status === "worn") {
    tone = "inspect";
    stateText = wornInc?.capacityLossPct != null ? `Inspect, ${Math.round(wornInc.capacityLossPct)}% capacity loss` : "Inspect worn pump";
    pillText = wornInc?.capacityLossPct != null ? `Inspect ${Math.round(wornInc.capacityLossPct)}% loss` : "Inspect pump";
  } else if (a.status === "idle") stateText = "Idle";

  // Data quality overrides the plain look: the line is grain, never healthy.
  // Projected time holds the last reading: staleness is measured at nowUnix, not at the projected t.
  const tr = a.projected ? snapshot.nowUnix : t;
  const stale = Math.max(staleMinutes(fac.series.level, tr) ?? 0, staleMinutes(fac.series.pumpFlow, tr) ?? 0);
  const nearNow = a.projected || Math.abs(t - snapshot.nowUnix) <= STEP;
  let reasonText: string | null = null;
  if (bad) {
    if (nearNow && fac.dataQuality.reasons.length > 0) reasonText = clean(fac.dataQuality.reasons[0]);
    else reasonText = stale > 0 ? `No readings for ${stale} min` : "No readings";
    if (a.status === "nodata" || stateText === "") {
      if (q === 1) stateText = `Held ${Math.max(stale, 5)} min`;
      else if (q === 2) stateText = "Invalid";
      else stateText = "No data";
      pillText = stateText;
      tone = "nodata";
    }
  }

  const flowBpd = round(a.pumpFlowBpd, 10);
  const flowText = !bad && a.status === "flowing" && flowBpd != null ? `${flowBpd.toLocaleString("en-US")} bpd` : "";

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
      ? { kind: "e_stop", text: "E-stop (board, display only)" }
      : { kind: "night_shift", text: "Night shift (board, display only)" };
  }

  const levelPct = a.levelPct == null ? null : Math.round(a.levelPct);
  const vm: Omit<LineVM, "key"> = {
    status: a.status, quality: a.quality, q, levelPct, flowBpd,
    inflowBpd: round(a.inflowBpd, 10), receiveBpd: round(a.receiveFlowBpd, 10),
    flowRatio: ratio(a.pumpFlowBpd), inflowRatio: ratio(a.inflowBpd),
    motion, redOn, wellsGrey: shut, hatchPipe: a.status === "leak" && !bad, hatchPump: a.status === "worn" && !bad,
    tone, problem: tone !== "none" || shut || bad || alarm != null, pillText: clip(pillText), flowText,
    stateText: stateText || (a.status === "flowing" ? "Flowing" : ""),
    tankText: levelPct == null ? "Unknown" : `${levelPct}%`, reasonText, etaText, alarm,
    checksUnavailable: fac.health === "unknown" && !bad,
  };
  return { ...vm, key: JSON.stringify(vm) };
}

/**
 * A usePlayhead() selector for one line. Evaluated once per minute of data time and returns the previous object
 * while nothing visible changed, so 60 fps playhead updates do not re-render the line.
 */
export function makeLineSelector(snapshot: Snapshot, fac: FacilityState): (s: PlayheadState) => LineVM {
  let lastMinute = Number.NaN;
  let lastApproved: PlayheadState["approved"] | null = null;
  let last: LineVM | null = null;
  return (s) => {
    const minute = Math.floor(s.t / 60);
    if (last && minute === lastMinute && s.approved === lastApproved) return last;
    lastMinute = minute;
    lastApproved = s.approved;
    const next = lineViewAt(snapshot, fac, minute * 60, s.approved);
    if (!last || last.key !== next.key) last = next;
    return last;
  };
}
