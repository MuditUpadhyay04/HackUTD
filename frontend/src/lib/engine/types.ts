// Shared contract between the engine (server) and the UI.
// Everything here is derived from network.json, ops.json and telemetry.csv only.
// answer_key.json is NEVER read by the app.

export type Category = "pump_failure" | "pipeline_leak" | "pump_degradation" | "facility_shut_in";

export type FacilityHealth =
  | "ok"
  | "failure" // pump failed, tank filling
  | "shut_in" // tank hit shutdown, wells shut in
  | "leak"
  | "degradation"
  | "no_data" // key sensors missing or stale at "now": never shown as healthy (team plan hard rule 9)
  | "unknown";

/** Per-reading quality, as in the team plan: VALID measured, HELD forward-filled <= 2 steps,
 *  INVALID present but unparseable, DROPPED missing or older than the hold limit. */
export type Quality = "VALID" | "HELD" | "INVALID" | "DROPPED";

export interface DataQuality {
  quality: Quality; // worst of the key channels at "now"
  reasons: string[]; // plain English, e.g. "Tank level not reported for 35 min"
}

export interface DatasetInfo {
  id: string; // folder name, e.g. "snapshot_2026-10-08T1200"
  label: string; // human label, e.g. "Snapshot · Thu Oct 8, 12:00"
  startUnix: number;
  nowUnix: number; // last ts_unix in telemetry.csv
}

export interface Series {
  t: number[]; // unix seconds, downsampled
  v: (number | null)[];
}

export interface WellState {
  id: string;
  producing: boolean;
  waterBpd: number;
  baselineWaterBpd: number;
  oilBpd: number;
  gasMcfd: number;
  revenuePerHour: number; // lost revenue per hour if shut in
  costPerBblAvoided: number; // $ per bbl of water avoided
}

export interface FacilityState {
  id: string; // S1_FACILITY_A
  systemId: string; // S1
  letter: string; // "A"
  lat: number;
  lon: number;
  tank: { id: string; capacityBbl: number; levelPct: number | null };
  pump: { id: string; status: 0 | 1 | 2 | null; flowBpd: number | null; maxFlowBpd: number; dischargePsi: number | null; startLevelPct: number; stopLevelPct: number };
  pipeline: { id: string; receiveFlowBpd: number | null; pressurePsi: number | null };
  inflowBpd: number | null;
  wells: WellState[];
  fillPctPerHour: number | null; // signed, current trend
  revenuePerHour: number; // all wells
  health: FacilityHealth;
  dataQuality: DataQuality;
  incidentIds: string[]; // ongoing incidents at this facility
  series: {
    level: Series; // last ~48h
    inflow: Series;
    pumpFlow: Series;
    receiveFlow: Series;
  };
}

export interface SystemState {
  id: string; // S1
  center: [number, number];
  truckYard: [number, number];
  disposal: { id: string; lat: number; lon: number; pressurePsi: number };
  fleetSize: number;
  facilities: FacilityState[];
}

export interface PlanOption {
  kind: "do_nothing" | "shut_in" | "trucks" | "mixed";
  label: string; // plain English, e.g. "Send 1 truck now"
  cost: number; // USD over the horizon
  trucks: number;
  tripsPerTruck: number;
  truckArrivalsMin: number[]; // minutes from plan start
  shutIns: { wellId: string; startAfterMin: number }[];
  tankTrips: boolean; // reaches shutdown under this plan
  tripAtMin: number | null; // minutes from plan start
  levelCurve: { min: number; pct: number }[]; // projected tank level
}

export interface Incident {
  id: string; // stable id, e.g. "S2_PUMP_B@1791460800"
  category: Category;
  status: "ongoing" | "resolved";
  systemId: string;
  facilityId: string;
  assetId: string;
  onsetUnix: number;
  endUnix: number | null;
  confidence: number | null; // 0..1
  evidence: string[]; // plain-English reasons
  dataQuality?: DataQuality; // quality of the facility's key readings at "now"
  // pump_failure only
  levelPct?: number;
  hoursToLimit?: { p10: number; p50: number; p90: number } | null;
  repairEndsUnix?: number;
  lostRevenuePerHour?: number;
  plan?: PlanOption; // recommended (cheapest)
  options?: PlanOption[]; // all considered, cheapest first
  // leak / degradation
  estLeakBblPerDay?: number;
  capacityLossPct?: number;
}

export interface TruckAssignment {
  truck: number; // 1..fleetSize
  incidentId: string;
  facilityId: string;
  fromUnix: number; // call time
  toUnix: number; // free again
  tripsArrivalUnix: number[];
}

export interface FleetState {
  systemId: string;
  size: number;
  assignments: TruckAssignment[];
}

export interface Snapshot {
  runId: string;
  dataset: DatasetInfo;
  limits: { warningPct: number; shutdownPct: number }; // from network.json defaults.tank_limits_pct
  board?: BoardStatus | null; // undefined = local mode (no board configured); null = configured but unreachable
  nowUnix: number; // may be < dataset.nowUnix when time-travelling
  systems: SystemState[];
  alerts: Incident[]; // ongoing, sorted per SPEC alerts view
  history: Incident[]; // resolved, newest first
  fleets: FleetState[];
  totals: {
    facilities: number;
    atRisk: number;
    revenueAtRiskPerHour: number;
    planCost: number;
  };
}

// ---------------------------------------------------------------------------
// Live board data (FPGA RESULT / ALERT / STATS via Jason's server; contract in docs/live-api.md).
// All optional: absent in local mode, so the UI shows nothing extra and never invents model output.

export type BoardAlarm = "none" | "night_shift" | "e_stop";
export type AlarmState = "raised" | "cleared" | "acknowledged";

export interface BoardScores {
  /** Calibrated probabilities 0..1, model head order from the plan. */
  pipeline_leak: number;
  pump_degradation: number;
  pump_failure: number;
  facility_shut_in: number;
}

export interface BoardFacility {
  facilityId: string;
  updatedUnix: number;
  scores: BoardScores | null; // null until the board has a model loaded
  overThreshold: Category[] | string[]; // heads above their threshold
  source: "rule" | "model" | "both" | "none"; // what raised the current state
  sinceReset: number; // records of history behind the scores (saturates at 255)
  alarm: BoardAlarm;
  alarmState: AlarmState | null;
  alarmSinceUnix: number | null;
  replayed: boolean; // delivered from the board's buffer after the server came back
  degradationTrend: Series | null | undefined; // pump_degradation score over recent hours (0..1)
}

export interface BoardStatus {
  source: "live" | "simulated"; // "simulated" = mock feed for development, always labelled in the UI
  /** Who produced the results, as in Jason's fpga-sim runtime: the board, the server's software stand-in, or nothing. */
  provenance: "fpga" | "software" | "unavailable";
  online: boolean; // server has heard from the board recently
  mode: "NORMAL" | "AUTONOMOUS"; // AUTONOMOUS = board lost the server heartbeat and is buffering
  lastSeenUnix: number | null;
  weightsVersion: number | null;
  autonomousSinceUnix: number | null;
  replayedAlerts: number; // alerts delivered from the buffer since reconnect
  facilities: BoardFacility[];
}
