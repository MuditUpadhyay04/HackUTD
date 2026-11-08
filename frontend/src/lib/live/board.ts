// Live board data for the web console. Server-side only.
//
// Modes (env):
//   LIVE_API_URL=https://host/api   -> read GET {LIVE_API_URL}/v1/board?dataset=&at= (contract: docs/live-api.md)
//   SIMULATE_BOARD=1 | autonomous | reconnected | offline -> development feed derived from the local engine, always labelled
//   neither                         -> local mode: board is undefined and the UI shows no board elements
//
// The local engine snapshot is always computed first, so the console keeps working if the board or server is down.

import type { BoardFacility, BoardStatus, Category, Series, Snapshot } from "@/lib/engine/types";

const TIMEOUT_MS = 2500;

export async function getBoard(s: Snapshot): Promise<BoardStatus | null | undefined> {
  const url = process.env.LIVE_API_URL;
  if (url) return fetchLive(url, s);
  const sim = process.env.SIMULATE_BOARD;
  if (sim) return simulate(s, sim);
  return undefined;
}

async function fetchLive(base: string, s: Snapshot): Promise<BoardStatus | null> {
  const q = new URLSearchParams({ dataset: s.dataset.id });
  if (s.nowUnix < s.dataset.nowUnix) q.set("at", String(s.nowUnix));
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/v1/board?${q}`, {
      headers: process.env.LIVE_API_KEY ? { authorization: `Bearer ${process.env.LIVE_API_KEY}` } : {},
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`http_${res.status}`);
    const data = parseBoard(await res.json());
    if (!data) throw new Error("bad_shape");
    return { ...data, source: "live" };
  } catch (e) {
    console.error("[board] live board unavailable, showing the local engine only:", e instanceof Error ? e.message : e);
    return null; // configured but unreachable: the UI says "Board offline" and keeps the local results
  }
}

const clamp01 = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const numOr = (x: unknown, d: number | null) => (typeof x === "number" && Number.isFinite(x) ? x : d);

/** Defensive parse: unknown fields are ignored, bad values never reach the UI as numbers. */
export function parseBoard(raw: unknown): Omit<BoardStatus, "source"> | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.facilities)) return null;
  const facilities: BoardFacility[] = [];
  for (const f of r.facilities as Record<string, unknown>[]) {
    if (!f || typeof f.facilityId !== "string") continue;
    const sc = f.scores as Record<string, unknown> | null | undefined;
    const alarm = f.alarm === "night_shift" || f.alarm === "e_stop" ? f.alarm : "none";
    const state = f.alarmState === "raised" || f.alarmState === "cleared" || f.alarmState === "acknowledged" ? f.alarmState : null;
    const source = f.source === "rule" || f.source === "model" || f.source === "both" ? f.source : "none";
    const trend = f.degradationTrend as { t?: unknown; v?: unknown } | undefined;
    facilities.push({
      facilityId: f.facilityId,
      updatedUnix: numOr(f.updatedUnix, 0) as number,
      scores: sc
        ? {
            pipeline_leak: clamp01(sc.pipeline_leak),
            pump_degradation: clamp01(sc.pump_degradation),
            pump_failure: clamp01(sc.pump_failure),
            facility_shut_in: clamp01(sc.facility_shut_in),
          }
        : null,
      overThreshold: Array.isArray(f.overThreshold) ? (f.overThreshold.filter((x) => typeof x === "string") as string[]) : [],
      source,
      sinceReset: Math.max(0, Math.min(255, numOr(f.sinceReset, 0) as number)),
      alarm,
      alarmState: alarm === "none" ? null : state,
      alarmSinceUnix: numOr(f.alarmSinceUnix, null),
      replayed: f.replayed === true,
      degradationTrend:
        trend && Array.isArray(trend.t) && Array.isArray(trend.v) && trend.t.length === trend.v.length
          ? { t: trend.t.map(Number), v: trend.v.map(clamp01) }
          : undefined,
    });
  }
  return {
    online: r.online === true,
    mode: r.mode === "AUTONOMOUS" ? "AUTONOMOUS" : "NORMAL",
    lastSeenUnix: numOr(r.lastSeenUnix, null),
    weightsVersion: numOr(r.weightsVersion, null),
    autonomousSinceUnix: numOr(r.autonomousSinceUnix, null),
    replayedAlerts: Math.max(0, numOr(r.replayedAlerts, 0) as number),
    facilities,
  };
}

/**
 * Development feed shaped like the live contract, derived from the local engine's own incidents.
 * Scores here are NOT model output; the UI labels this mode "Simulated board" everywhere it shows.
 */
function simulate(s: Snapshot, mode: string): BoardStatus | null {
  if (mode === "offline") return null;
  const autonomous = mode === "autonomous"; // board lost the server and is buffering
  const reconnected = mode === "reconnected"; // server is back and the buffered alerts were replayed
  const facilities: BoardFacility[] = s.systems.flatMap((sys) =>
    sys.facilities.map((f) => {
      const inc = s.alerts.filter((a) => a.facilityId === f.id);
      const has = (c: Category) => inc.find((a) => a.category === c);
      const leak = has("pipeline_leak");
      const worn = has("pump_degradation");
      const fail = has("pump_failure");
      const shut = f.health === "shut_in";
      const scores = {
        pipeline_leak: leak ? Math.min(0.98, 0.6 + leak.confidence * 0.35) : 0.03,
        pump_degradation: worn ? Math.min(0.95, 0.55 + worn.confidence * 0.35) : 0.05,
        pump_failure: fail ? 0.98 : 0.02,
        facility_shut_in: shut ? 0.97 : 0.01,
      };
      const over: Category[] = [];
      if (leak) over.push("pipeline_leak");
      if (worn) over.push("pump_degradation");
      if (fail) over.push("pump_failure");
      const alarm = leak ? "e_stop" : fail || worn || shut ? "night_shift" : "none";
      const onset = Math.min(...inc.map((a) => a.onsetUnix), s.nowUnix);
      // Wear trend for the demo: how far running flow sits below the pump's rating, scaled to 0..1.
      let degradationTrend: Series | undefined;
      if (worn) {
        const { t, v } = f.series.pumpFlow;
        const pts = t.map((tt, i) => [tt, v[i]] as const).filter(([, x]) => x > 50);
        degradationTrend = {
          t: pts.map(([tt]) => tt),
          v: pts.map(([, x]) => Math.min(1, Math.max(0, ((1 - x / f.pump.maxFlowBpd) - 0.01) * 8))),
        };
      }
      return {
        facilityId: f.id,
        updatedUnix: s.nowUnix,
        scores: f.health === "no_data" ? null : scores,
        overThreshold: over,
        source: fail ? "both" : leak || worn ? "model" : shut ? "rule" : "none",
        sinceReset: f.health === "no_data" ? 0 : 255,
        alarm,
        alarmState: alarm === "none" ? null : "raised",
        alarmSinceUnix: alarm === "none" ? null : onset,
        replayed: reconnected && alarm !== "none",
        degradationTrend,
      } satisfies BoardFacility;
    }),
  );
  return {
    source: "simulated",
    online: !autonomous,
    mode: autonomous ? "AUTONOMOUS" : "NORMAL",
    lastSeenUnix: s.nowUnix,
    weightsVersion: 1,
    autonomousSinceUnix: autonomous || reconnected ? s.nowUnix - 40 * 60 : null,
    replayedAlerts: reconnected ? facilities.filter((f) => f.replayed).length : 0,
    facilities,
  };
}
