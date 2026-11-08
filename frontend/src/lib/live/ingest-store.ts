// In-memory board state fed by Mudit's `hutd_ml.listen --post <console>/api/ingest` (ml/INTEGRATION.md §3).
// Display only: the console keeps computing events, countdowns and plans from the dataset itself.
// Enabled with BOARD_INGEST=1. Lost on restart, which is fine: listen.py re-sends every step.

import type { BoardAlarm, AlarmState, BoardFacility, BoardScores, BoardStatus } from "@/lib/engine/types";

type Probability = Partial<Record<keyof BoardScores, number>>;

interface FacState {
  facility: string;
  system: string;
  tsUnix: number;
  status: string;
  reasons: string[];
  sinceReset: number;
  probability: Probability | null;
  aboveThreshold: string[];
  rules: string[];
  weightsVer: number;
  alarm: BoardAlarm;
  alarmState: AlarmState | null;
  alarmSinceUnix: number | null;
  replayed: boolean;
  trend: { t: number[]; v: number[] }; // pump_degradation probability over time
}

interface Store {
  facilities: Map<string, FacState>;
  latestTs: number | null;
  lastSeenWall: number | null; // ms, when anything (not just []) last arrived
  lastPostWall: number | null; // ms, when any POST (including []) last arrived
  mode: "NORMAL" | "AUTONOMOUS";
  weightsVersion: number | null;
  autonomousSinceUnix: number | null;
  replayedAlerts: number;
  resultNo: number;
}

const g = globalThis as unknown as { __btsIngest?: Store };
export const store: Store = (g.__btsIngest ??= {
  facilities: new Map(),
  latestTs: null,
  lastSeenWall: null,
  lastPostWall: null,
  mode: "NORMAL",
  weightsVersion: null,
  autonomousSinceUnix: null,
  replayedAlerts: 0,
  resultNo: 0,
});

const TREND_MAX = 200;
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const strs = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : []);

function fac(o: Record<string, unknown>): FacState | null {
  const id = typeof o.facility === "string" ? o.facility : null;
  if (!id) return null;
  let f = store.facilities.get(id);
  if (!f) {
    f = {
      facility: id,
      system: typeof o.system === "string" ? o.system : "",
      tsUnix: 0,
      status: "VALID",
      reasons: [],
      sinceReset: 0,
      probability: null,
      aboveThreshold: [],
      rules: [],
      weightsVer: 0,
      alarm: "none",
      alarmState: null,
      alarmSinceUnix: null,
      replayed: false,
      trend: { t: [], v: [] },
    };
    store.facilities.set(id, f);
  }
  return f;
}

/** Apply one POSTed batch. Unknown shapes are ignored; nothing here can throw on bad input. */
export function ingest(batch: unknown): number {
  store.lastPostWall = Date.now();
  if (!Array.isArray(batch)) return 0;
  let n = 0;
  for (const raw of batch) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const ts = num(o.ts_unix);
    if (ts != null && (store.latestTs == null || ts > store.latestTs)) store.latestTs = ts;

    if (o.type === "result") {
      const f = fac(o);
      if (!f || ts == null || ts < f.tsUnix) continue;
      f.tsUnix = ts;
      f.status = typeof o.status === "string" ? o.status : "VALID";
      f.reasons = strs(o.reason);
      f.sinceReset = Math.max(0, Math.min(255, num(o.since_reset) ?? 0));
      f.weightsVer = num(o.weights_ver) ?? 0;
      const p = o.probability && typeof o.probability === "object" ? (o.probability as Record<string, unknown>) : null;
      // INVALID / DROPPED results carry no usable scores (ml/INTEGRATION.md §3); weights_ver 0 = no model.
      f.probability =
        p && f.weightsVer !== 0 && f.status !== "INVALID" && f.status !== "DROPPED"
          ? {
              pipeline_leak: num(p.pipeline_leak) ?? undefined,
              pump_degradation: num(p.pump_degradation) ?? undefined,
              pump_failure: num(p.pump_failure) ?? undefined,
              facility_shut_in: num(p.facility_shut_in) ?? undefined,
            }
          : null;
      f.aboveThreshold = strs(o.above_threshold);
      f.rules = strs(o.rules);
      const deg = f.probability?.pump_degradation;
      if (deg != null) {
        f.trend.t.push(ts);
        f.trend.v.push(deg);
        if (f.trend.t.length > TREND_MAX) {
          f.trend.t.shift();
          f.trend.v.shift();
        }
      }
      store.resultNo = Math.max(store.resultNo, num(o.result_no) ?? 0);
      store.weightsVersion = f.weightsVer;
      store.lastSeenWall = Date.now();
      n++;
    } else if (o.type === "alert") {
      const f = fac(o);
      if (!f) continue;
      const kind = o.kind;
      const source = strs(o.source);
      if (kind === "night_shift_raised" || kind === "estop_raised") {
        // E-STOP outranks Night Shift while both are active.
        const next: BoardAlarm = kind === "estop_raised" ? "e_stop" : "night_shift";
        if (!(f.alarm === "e_stop" && f.alarmState === "raised" && next === "night_shift")) {
          f.alarm = next;
          f.alarmState = "raised";
          f.alarmSinceUnix = ts;
        }
      } else if (kind === "cleared") {
        if (f.alarm !== "none") f.alarmState = "cleared";
      } else if (kind === "acknowledged") {
        if (f.alarm !== "none") f.alarmState = "acknowledged";
      }
      f.replayed = source.includes("replayed_from_buffer");
      if (f.replayed) store.replayedAlerts++;
      if (source.includes("raised_while_autonomous") && store.autonomousSinceUnix == null) store.autonomousSinceUnix = ts;
      store.lastSeenWall = Date.now();
      n++;
    } else if (o.type === "stats") {
      const mode = o.mode === "AUTONOMOUS" || o.mode === 1 ? "AUTONOMOUS" : "NORMAL";
      if (mode === "AUTONOMOUS" && store.mode !== "AUTONOMOUS") store.autonomousSinceUnix = store.latestTs;
      if (mode === "NORMAL") store.autonomousSinceUnix = null;
      store.mode = mode;
      const wv = num(o.weights_version);
      if (wv != null) store.weightsVersion = wv;
      store.lastSeenWall = Date.now();
      n++;
    }
  }
  return n;
}

function sourceOf(f: FacState): BoardFacility["source"] {
  const ruleHit = f.rules.some((r) => r === "pump_fault" || r === "shut_in");
  const modelHit = f.aboveThreshold.length > 0;
  return ruleHit && modelHit ? "both" : ruleHit ? "rule" : modelHit ? "model" : "none";
}

/** Board state as of `atUnix` (the console's "now"); undefined when nothing has ever been received. */
export function boardFromStore(provenance: BoardStatus["provenance"]): Omit<BoardStatus, "source"> | null {
  if (store.lastPostWall == null && store.lastSeenWall == null) return null;
  const online = store.lastSeenWall != null && Date.now() - store.lastSeenWall < 10_000;
  const facilities: BoardFacility[] = [...store.facilities.values()].map((f) => {
    const p = f.probability;
    const complete =
      p && [p.pipeline_leak, p.pump_degradation, p.pump_failure, p.facility_shut_in].every((v) => typeof v === "number");
    return {
      facilityId: f.facility,
      updatedUnix: f.tsUnix,
      scores: complete
        ? {
            pipeline_leak: p!.pipeline_leak!,
            pump_degradation: p!.pump_degradation!,
            pump_failure: p!.pump_failure!,
            facility_shut_in: p!.facility_shut_in!,
          }
        : null,
      overThreshold: f.aboveThreshold,
      source: sourceOf(f),
      sinceReset: f.sinceReset,
      alarm: f.alarm,
      alarmState: f.alarm === "none" ? null : f.alarmState,
      alarmSinceUnix: f.alarmSinceUnix,
      replayed: f.replayed,
      degradationTrend: f.trend.t.length >= 2 ? { t: [...f.trend.t], v: [...f.trend.v] } : undefined,
    };
  });
  return {
    provenance,
    online,
    mode: store.mode,
    lastSeenUnix: store.latestTs,
    weightsVersion: store.weightsVersion,
    autonomousSinceUnix: store.autonomousSinceUnix,
    replayedAlerts: store.replayedAlerts,
    facilities,
  };
}
