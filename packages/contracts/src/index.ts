/** Application contracts. Browser-safe: no server code or SDK dependencies. */
export type Category = "pump_failure" | "pipeline_leak" | "pump_degradation" | "facility_shut_in";
export type Quality = "VALID" | "HELD" | "INVALID" | "DROPPED";
export type RuntimeMode = "auto" | "software" | "fpga";
export interface NetworkWell { id: string; baseline_water_bpd: number; oil_bpd: number; gas_mcfd: number }
export interface NetworkFacility {
  id: string; lat: number; lon: number; wells: NetworkWell[];
  tank: { id: string; capacity_bbl: number };
  pump: { id: string; max_flow_bpd: number; start_level_pct: number; stop_level_pct: number };
  pipeline: { id: string; max_bpd?: number; max_pressure_psi?: number };
}
export interface NetworkSystem {
  id: string; center: [number, number]; truck_yard: [number, number];
  disposal_site: { id: string; lat: number; lon: number; pressure_psi: number };
  facilities: NetworkFacility[];
}
export interface Network {
  meta?: { timezone?: string; units?: Record<string, string> };
  defaults: { tank_limits_pct: { warning: number; shutdown: number } };
  systems: NetworkSystem[];
}
export interface Operations {
  dataset_id?: string;
  prices: { oil_per_bbl: number; gas_per_mcf: number };
  expected_repair_hours: { pump_failure: number };
  emergency_trucking: { truck_capacity_bbl: number; cost_per_trip: number };
  systems: Record<string, { emergency_fleet_size: number; facilities: Record<string, { response_min: number; cycle_min: number }> }>;
}
export interface TelemetrySample { tsUnix: number; assetId: string; metric: string; value: number | null }
export interface InferenceObservation { facilityId: string; tsUnix: number; resultNo: number; provenance: string; status: number; body: unknown }
export interface Frame {
  facilityId: string; tsUnix: number;
  inflowBpd: number | null; levelPct: number | null; pumpStatus: number | null;
  pumpFlowBpd: number | null; receiveFlowBpd: number | null; dischargePsi: number | null; pipelinePsi: number | null;
  wellStatus: (number | null)[]; wellWaterBpd: (number | null)[];
}
export interface DatasetInfo { id: string; label: string; startUnix: number; nowUnix: number; status: "ready"; createdAt: string; fileHashes: Record<string, string>; warnings: string[]; hardwareEligible: boolean; hardwareReasons: string[] }
export interface ImportedDataset { info: DatasetInfo; network: Network; ops: Operations; samples: TelemetrySample[]; frames: Frame[]; sourceFiles?: { network: string; ops: string; telemetry: string } }
export interface DataQuality { quality: Quality; reasons: string[] }
export interface Series { t: number[]; v: (number | null)[] }
export interface BoardScores { pipeline_leak: number; pump_degradation: number; pump_failure: number; facility_shut_in: number }
export interface BoardFacility { facilityId: string; updatedUnix: number; scores: BoardScores | null; overThreshold: string[]; source: "rule" | "model" | "both" | "none"; sinceReset: number; alarm: "night_shift" | "e_stop" | "none"; alarmState: "raised" | "cleared" | "acknowledged" | null; alarmSinceUnix: number | null; replayed: boolean; degradationTrend: Series | null | undefined }
export interface BoardStatus { source: "live" | "simulated"; online: boolean; mode: "AUTONOMOUS" | "NORMAL"; lastSeenUnix: number | null; weightsVersion: number | null; autonomousSinceUnix: number | null; replayedAlerts: number; facilities: BoardFacility[] }
export type FacilityHealth = "ok" | "failure" | "shut_in" | "leak" | "degradation" | "no_data" | "unknown";
export interface WellState { id: string; producing: boolean; waterBpd: number; baselineWaterBpd: number; oilBpd: number; gasMcfd: number; revenuePerHour: number; costPerBblAvoided: number }
export interface FacilityState {
  id: string; systemId: string; letter: string; lat: number; lon: number;
  tank: { id: string; capacityBbl: number; levelPct: number | null };
  pump: { id: string; status: 0 | 1 | 2 | null; flowBpd: number | null; maxFlowBpd: number; dischargePsi: number | null; startLevelPct: number; stopLevelPct: number };
  pipeline: { id: string; receiveFlowBpd: number | null; pressurePsi: number | null };
  inflowBpd: number | null; wells: WellState[]; fillPctPerHour: number | null; revenuePerHour: number;
  health: FacilityHealth; dataQuality: DataQuality; incidentIds: string[]; observedShutIn: boolean | null;
  series: { level: Series; inflow: Series; pumpFlow: Series; receiveFlow: Series };
}
export interface SystemState { id: string; center: [number, number]; truckYard: [number, number]; disposal: { id: string; lat: number; lon: number; pressurePsi: number }; fleetSize: number; facilities: FacilityState[] }
export interface PlanOption {
  id: string; systemPlanId: string; inputRevision: number;
  kind: "do_nothing" | "shut_in" | "trucks" | "mixed"; label: string; cost: number;
  trucks: number; tripsPerTruck: number; truckArrivalsMin: number[];
  shutIns: { wellId: string; startAfterMin: number }[];
  tankTrips: boolean; tripAtMin: number | null; levelCurve: { min: number; pct: number }[];
  feasibility: "validated"; searchStatus: "best_feasible_found" | "baseline";
}
export interface CountdownState {
  status: "available" | "not_filling" | "beyond_range" | "unavailable" | "at_limit" | "not_applicable";
  hours: { p10: number; p50: number; p90: number } | null;
  source: "software" | "fpga" | "host"; method: string; quality: Quality;
}
export interface Incident {
  id: string; category: Category; status: "ongoing" | "resolved";
  systemId: string; facilityId: string; assetId: string; onsetUnix: number; endUnix: number | null;
  confidence: number | null; evidence: string[]; dataQuality?: DataQuality;
  levelPct?: number; hoursToLimit?: { p10: number; p50: number; p90: number } | null;
  countdown?: CountdownState; repairEndsUnix?: number; lostRevenuePerHour?: number;
  plan?: PlanOption; options?: PlanOption[]; estLeakBblPerDay?: number; capacityLossPct?: number;
  provenance: "software" | "fpga"; modelVersion: string | null; planningStatus?: "ready" | "uncertain_horizon" | "insufficient_data";
}
export interface TruckAssignment { truck: number; incidentId: string; facilityId: string; fromUnix: number; toUnix: number; tripsArrivalUnix: number[] }
export interface FleetState { systemId: string; size: number; assignments: TruckAssignment[]; basis: "proposed" }
export interface Snapshot {
  runId: string; revision: number; cursor: number; parentRunId: string | null;
  dataset: DatasetInfo; nowUnix: number;
  board: BoardStatus | null;
  runtime: { requested: RuntimeMode; effective: "software" | "fpga"; state: "ready" | "degraded" | "rebuilding"; reasons: string[]; scoresAvailable: boolean; modelVersion: string | null };
  coverage: { expected: number; received: number; complete: boolean };
  recommendation: { state: "ready" | "stale" | "pending" | "unavailable"; inputRevision: number; currentRevision: number };
  limits: { warningPct: number; shutdownPct: number }; systems: SystemState[]; alerts: Incident[]; history: Incident[]; fleets: FleetState[];
  totals: { facilities: number; atRisk: number; revenueAtRiskPerHour: number; planCost: number };
}
export interface RunInput { datasetId: string; at?: number; runtime: RuntimeMode; parentRunId?: string; idempotencyKey?: string }
export interface RunRecord { id: string; datasetId: string; at: number; requested: RuntimeMode; parentRunId: string | null; modelFingerprint?: string | null; status: "pending" | "running" | "ready" | "failed" | "cancelled"; error: string | null; createdAt: string; snapshot: Snapshot | null }
export interface PlanningWell { id: string; waterBpd: number; revenuePerHour: number }
export interface PlanningJob { incidentId: string; facilityId: string; systemId: string; levelPct: number; capacityBbl: number; shutdownPct: number; horizonMin: number; responseMin: number; cycleMin: number; wells: PlanningWell[]; alreadyTripped: boolean }
export interface SystemPlanningInput { systemId: string; asOfUnix: number; inputRevision: number; fleetSize: number; truckCapacityBbl: number; costPerTrip: number; jobs: PlanningJob[]; maxCandidates?: number }
export interface SystemPlanResult { id: string; systemId: string; inputRevision: number; totalCost: number; optionsByIncident: Record<string, PlanOption[]>; recommendedByIncident: Record<string, PlanOption>; assignments: TruckAssignment[]; searchStatus: "best_feasible_found"; policy: string; timedOut: boolean }
export interface AgentStep { agent: string; model: string; text: string }
export interface AnalysisRecord { id: string; runId: string; inputRevision: number; state: "pending" | "running" | "completed" | "failed" | "cancelled"; source: "nemotron" | "ai-sdk" | "draft"; model?: string; fxSessionId?: string; messageId?: string; steps: AgentStep[]; handoff: string; evidenceIds: string[]; planIds: string[]; error: string | null; createdAt: string }
export interface OperatorAction { id: string; runId: string; incidentId: string; planId?: string; revision: number; kind: "acknowledge_advice" | "inspection_ticket"; createdAt: string }
export interface ScenarioRecord { id: string; runId: string; inputRevision: number; systemId: string; label: string; actions: unknown[]; result: SystemPlanResult | null; createdAt: string }
export interface LiveEvent { runId: string; cursor: number; revision: number; type: "snapshot" | "analysis" | "operator_action" | "scenario" | "run"; data: unknown; createdAt: string }
export interface ValidationIssue { file: string; path: string; message: string }
export class DomainError extends Error { constructor(public code: string, message: string, public status = 400, public issues?: ValidationIssue[]) { super(message); this.name = "DomainError" } }
