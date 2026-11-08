import { DomainError, type CountdownState, type DataQuality, type FacilityState, type Frame, type ImportedDataset, type Incident, type InferenceObservation, type PlanningJob, type Quality, type RuntimeMode, type Snapshot, type SystemPlanningInput, type SystemState } from "@hackutd/contracts";
import { SoftwareRuntime, buildDatasetConfig, STATUS, type TelemetryRecord } from "../../../../../packages/fpga-sim/src/index.ts";
import { parseRegisteredModel, type RegisteredModel } from "./model";
import { boardKey, type BoardIndex } from "./board";
export { boardIndex, readBoardIndex, type BoardIndex, type BoardResult, type BoardSource } from "./board";
export { parseRegisteredModel, readRegisteredModel, type RegisteredModel } from "./model";
import { solveSystemPlan } from "../planning/solver";
import { validateSystemPlan } from "../planning/validator";

const STEP = 300;
const HEAD_NAMES = ["pipeline_leak", "pump_degradation", "pump_failure"] as const;
/** Board mode: a head resolves after this many usable board records without it in `active` (ml/INTEGRATION.md §4). */
const BOARD_RESOLVE_AFTER = 3;
const METHOD = "host-inflow-only-rolling16-v1";
const validNumber = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
const value = (v: number | null | undefined): number | null => validNumber(v) ? v : null;
const abort = (signal?: AbortSignal) => { if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError"); };

function record(frame: Frame, wells: number): TelemetryRecord {
  const ws = Array.from({ length: wells }, (_, i) => value(frame.wellStatus[i]));
  const ww = Array.from({ length: wells }, (_, i) => value(frame.wellWaterBpd[i]));
  const r = { ...frame, inflowBpd: value(frame.inflowBpd), levelPct: value(frame.levelPct), pumpStatus: value(frame.pumpStatus), pumpFlowBpd: value(frame.pumpFlowBpd), receiveFlowBpd: value(frame.receiveFlowBpd), dischargePsi: value(frame.dischargePsi), pipelinePsi: value(frame.pipelinePsi), wellStatus: ws, wellWaterBpd: ww };
  return { ...r, present: { inflow: r.inflowBpd !== null, level: r.levelPct !== null, pumpStatus: r.pumpStatus !== null, pumpFlow: r.pumpFlowBpd !== null, receiveFlow: r.receiveFlowBpd !== null, discharge: r.dischargePsi !== null, pipeline: r.pipelinePsi !== null, wellStatus: ws.map(v => v !== null), wellWater: ww.map(v => v !== null) } };
}

function quality(frame: TelemetryRecord, result: ReturnType<SoftwareRuntime["ingest"]>): DataQuality {
  const missing: string[] = [];
  for (const [k, v] of Object.entries(frame.present)) {
    if (Array.isArray(v)) v.forEach((p, i) => { if (!p) missing.push(`missing ${k}[${i}]`); });
    else if (!v) missing.push(`missing ${k}`);
  }
  const reasons = [...missing, ...Object.entries(result.reason).filter(([, v]) => v).map(([k]) => k)];
  const q: Quality = result.status === STATUS.DROPPED ? "DROPPED" : result.status === STATUS.INVALID ? "INVALID" : result.status === STATUS.HELD || reasons.length ? "HELD" : "VALID";
  return { quality: q, reasons };
}

function countdown(level: number | null, inflows: number[], capacity: number, limit: number, q: Quality): CountdownState {
  const base = { source: "host" as const, method: METHOD, quality: q };
  if (level === null || level < 0 || level > 100) return { ...base, status: "unavailable", hours: null };
  if (level >= limit) return { ...base, status: "at_limit", hours: { p10: 0, p50: 0, p90: 0 } };
  if (!inflows.length) return { ...base, status: "unavailable", hours: null };
  if (inflows.every(x => x <= 0)) return { ...base, status: "not_filling", hours: null };
  // An unbounded upper estimate cannot be represented in the contract's finite band.
  if (inflows.some(x => x <= 0)) return { ...base, status: "unavailable", hours: null };
  const remaining = capacity * (limit - level) / 100 * 24;
  const mean = inflows.reduce((a, b) => a + b, 0) / inflows.length;
  return { ...base, status: "available", hours: { p10: remaining / Math.max(...inflows), p50: remaining / mean, p90: remaining / Math.min(...inflows) } };
}

interface Head { active: boolean; positive: number; negative: number; firstPositive: number; confidence: number | null; incident: Incident | null }
interface Acc { frames: Frame[]; quality: DataQuality; observed: boolean; complete: boolean; active: Incident | null; incidents: Incident[]; leftCensored: Set<string>; inflows: number[]; shutIn: boolean | null; lastPumpTs: number | null; heads: Head[] }

function planningInput(dataset: ImportedDataset, systems: SystemState[], alerts: Incident[], asOfUnix: number, revision: number, systemId: string): SystemPlanningInput {
  const system = systems.find(s => s.id === systemId);
  const ops = dataset.ops.systems[systemId];
  if (!system || !ops) throw new DomainError("unknown_system", `Unknown system ${systemId}`, 404);
  const incidents = alerts.filter(i => i.systemId === systemId && i.category === "pump_failure" && i.status === "ongoing");
  if (incidents.some(i => i.planningStatus !== "ready")) throw new DomainError("planning_unavailable", "A concurrent failure has an uncertain horizon or insufficient data", 409);
  const jobs: PlanningJob[] = incidents.map(incident => {
    const f = system.facilities.find(x => x.id === incident.facilityId);
    const fo = ops.facilities[incident.facilityId];
    const horizonMin = ((incident.repairEndsUnix ?? asOfUnix) - asOfUnix) / 60;
    if (!f || !fo || f.tank.levelPct === null || f.inflowBpd === null || horizonMin <= 0) throw new DomainError("planning_unavailable", "Missing current planning data", 409);
    const alreadyTripped = f.tank.levelPct >= dataset.network.defaults.tank_limits_pct.shutdown;
    return { incidentId: incident.id, facilityId: f.id, systemId, levelPct: f.tank.levelPct, capacityBbl: f.tank.capacityBbl, shutdownPct: dataset.network.defaults.tank_limits_pct.shutdown, horizonMin, responseMin: fo.response_min, cycleMin: fo.cycle_min, wells: f.wells.filter(w => alreadyTripped || w.producing).map(w => ({ id: w.id, waterBpd: w.waterBpd, revenuePerHour: w.revenuePerHour })), alreadyTripped };
  });
  return { systemId, asOfUnix, inputRevision: revision, fleetSize: system.fleetSize, truckCapacityBbl: dataset.ops.emergency_trucking.truck_capacity_bbl, costPerTrip: dataset.ops.emergency_trucking.cost_per_trip, jobs };
}

/** Recreate exactly the current shared-fleet planning input, or reject incomplete systems. */
export function planningInputForSnapshot(dataset: ImportedDataset, snapshot: Snapshot, systemId: string): SystemPlanningInput {
  return planningInput(dataset, snapshot.systems, snapshot.alerts, snapshot.nowUnix, snapshot.revision, systemId);
}

/** Reconstructs a run strictly from records at or before its replay cutoff. */
export async function buildRunSnapshot(dataset: ImportedDataset, input: { runId: string; at: number; runtime: RuntimeMode; parentRunId?: string; revision?: number }, options?: { signal?: AbortSignal; model?: RegisteredModel; board?: BoardIndex; onResults?: (results: InferenceObservation[]) => Promise<void> }): Promise<Snapshot> {
  abort(options?.signal);
  const model = options?.model ? parseRegisteredModel(options.model) : null;
  const revision = input.revision ?? 1;
  if (!Number.isFinite(input.at)) throw new DomainError("invalid_cutoff", "Replay cutoff must be finite", 400);
  const cutoff = Math.min(input.at, dataset.info.nowUnix);
  const at = dataset.frames.reduce((latest, frame) => frame.tsUnix <= cutoff ? Math.max(latest, frame.tsUnix) : latest, -Infinity);
  if (!Number.isFinite(at)) throw new DomainError("invalid_cutoff", "No telemetry exists at or before the cutoff", 400);
  const hardwareReasons = [...dataset.info.hardwareReasons];
  if (!dataset.info.hardwareEligible && !hardwareReasons.length) hardwareReasons.push("Dataset exceeds hardware eligibility constraints");
  hardwareReasons.push("FPGA bridge is not configured");
  if (input.runtime === "fpga") throw new DomainError("fpga_unavailable", hardwareReasons.join("; "), 503);
  const runtime = new SoftwareRuntime(input.runId);
  const facilityMap = new Map(dataset.network.systems.flatMap(s => s.facilities.map(f => [f.id, { system: s, facility: f }] as const)));
  const acc = new Map<string, Acc>();
  for (const id of facilityMap.keys()) acc.set(id, { frames: [], quality: { quality: "DROPPED", reasons: ["no telemetry"] }, observed: false, complete: false, active: null, incidents: [], leftCensored: new Set(), inflows: [], shutIn: null, lastPumpTs: null, heads: Array.from({ length: 3 }, () => ({ active: false, positive: 0, negative: 0, firstPositive: 0, confidence: null, incident: null })) });
  const frames = dataset.frames.filter(f => f.tsUnix <= at && facilityMap.has(f.facilityId)).slice().sort((a, b) => a.tsUnix - b.tsUnix || a.facilityId.localeCompare(b.facilityId));
  // Board mode (hard rule 11): detections come from board results (the FPGA or the bit-exact software board), used only
  // when they cover this dataset's records up to the cutoff; otherwise they are ignored and the reasons say so.
  const boardAll = options?.board;
  const covered = boardAll?.size ? frames.filter(f => boardAll.has(boardKey(f.facilityId, f.tsUnix))) : [];
  const board = covered.length ? boardAll : undefined;
  const boardLast = covered.length ? boardAll!.get(boardKey(covered.at(-1)!.facilityId, covered.at(-1)!.tsUnix))! : null;
  const boardLabel = boardLast ? `board results (${boardLast.source}${boardLast.weightsVer != null ? `, weights v${boardLast.weightsVer}` : ""})` : "";
  const boardProvenance = boardLast?.source === "fpga" ? "fpga" as const : "software" as const;
  const boardVersion = boardLast?.weightsVer != null ? `weights v${boardLast.weightsVer}` : "board";
  let pending: InferenceObservation[] = [];
  const flush = async () => {
    if (!pending.length || !options?.onResults) return;
    abort(options.signal);
    const batch = pending; pending = [];
    await options.onResults(batch);
    abort(options.signal);
  };
  try {
  const config = buildDatasetConfig(dataset.network, dataset.ops, dataset.info.startUnix, at);
  if (model) config.model = { weightsVer: model.weightsVer, weights: new Int16Array(model.weights), biases: new Int32Array(model.biases), outputShift: model.outputShift, source: model.id, loaded: true };
  runtime.configure(config);
  for (let i = 0; i < frames.length; i++) {
    if (i % 1000 === 0) { abort(options?.signal); await new Promise<void>(resolve => setTimeout(resolve, 0)); }
    const f = frames[i]; const meta = facilityMap.get(f.facilityId)!; const a = acc.get(f.facilityId)!;
    const r = record(f, meta.facility.wells.length); const result = runtime.ingest(r); const q = quality(r, result);
    if (options?.onResults) {
      pending.push({ facilityId: result.facilityId, tsUnix: result.tsUnix, resultNo: result.resultNo, provenance: result.provenance, status: result.status, body: { ...result, channels: result.channels ? Array.from(result.channels) : null, memoryFeatures: result.memoryFeatures ? Array.from(result.memoryFeatures) : null, logits: result.logits ? Array.from(result.logits) : null, logitThresholds: result.logitThresholds ? Array.from(result.logitThresholds) : null } });
      if (pending.length >= 500) await flush();
    }
    a.frames.push(f); a.quality = q;
    const fields = Object.values(r.present).flatMap(v => Array.isArray(v) ? v : [v]);
    const usable = result.status === STATUS.VALID || result.status === STATUS.HELD;
    a.observed = usable && fields.some(Boolean);
    a.complete = usable && fields.every(Boolean) && !result.reason.outOfRange && !result.reason.illegalEnum;
    if (result.status === STATUS.DROPPED || result.status === STATUS.INVALID) { a.shutIn = null; continue; }
    const br = board?.get(boardKey(f.facilityId, f.tsUnix));
    if (board) {
      // Board mode: `active` already includes the trained per-class K. A missing, INVALID or DROPPED board record
      // freezes every streak, like missing observations in the software path.
      if (br && (br.status === "VALID" || br.status === "HELD")) {
        for (let head = 0; head < 3; head++) {
          const h = a.heads[head]; const name = HEAD_NAMES[head];
          h.confidence = typeof br.probability?.[name] === "number" ? br.probability[name]! : null;
          if (br.above.includes(name)) { if (!h.positive) h.firstPositive = f.tsUnix; h.positive++; } else h.positive = 0;
          if (br.active.includes(name)) { h.active = true; h.negative = 0; } else if (++h.negative >= BOARD_RESOLVE_AFTER) h.active = false;
          if (head < 2) {
            if (h.active && !h.incident) {
              const category = head === 0 ? "pipeline_leak" : "pump_degradation";
              const onset = h.firstPositive || f.tsUnix;
              h.incident = { id: `${input.runId}:${category}:${f.facilityId}:${onset}`, category, status: "ongoing", systemId: meta.system.id, facilityId: f.facilityId, assetId: head === 0 ? meta.facility.pipeline.id : meta.facility.pump.id, onsetUnix: onset, endUnix: null, confidence: h.confidence, evidence: [`${boardLabel}: ${name} active (over the trained threshold for K consecutive records on the board).`], dataQuality: q, provenance: boardProvenance, modelVersion: boardVersion };
              a.incidents.push(h.incident);
            } else if (!h.active && h.incident) {
              h.incident.status = "resolved"; h.incident.endUnix = f.tsUnix; h.incident = null;
            } else if (h.incident) { h.incident.confidence = h.confidence; h.incident.dataQuality = q; }
          }
        }
      }
    } else if (model && result.logits && a.complete) {
      for (let head = 0; head < 3; head++) {
        // Leak and wear signatures are meaningful only while the pump runs.
        // Missing/inapplicable observations freeze both positive and negative streaks.
        if (head < 2 && r.pumpStatus !== 1) continue;
        const h = a.heads[head];
        const score = 1 / (1 + Math.exp(-result.logits[head] * model.logitScale));
        h.confidence = score;
        if (score >= model.thresholds[head]) {
          if (!h.positive) h.firstPositive = f.tsUnix;
          h.positive++; h.negative = 0;
          if (h.positive >= model.persistK) h.active = true;
        } else {
          h.negative++; h.positive = 0;
          if (h.negative >= model.persistK) h.active = false;
        }
        if (head < 2) {
          if (h.active && !h.incident) {
            const category = head === 0 ? "pipeline_leak" : "pump_degradation";
            h.incident = { id: `${input.runId}:${category}:${f.facilityId}:${h.firstPositive}`, category, status: "ongoing", systemId: meta.system.id, facilityId: f.facilityId, assetId: head === 0 ? meta.facility.pipeline.id : meta.facility.pump.id, onsetUnix: h.firstPositive, endUnix: null, confidence: score, evidence: [`Registered model ${model.id}: sigmoid(raw logit × ${model.logitScale}) ≥ ${model.thresholds[head]} for ${model.persistK} usable observations; software inference.`], dataQuality: q, provenance: "software", modelVersion: model.id };
            a.incidents.push(h.incident);
          } else if (!h.active && h.incident) {
            h.incident.status = "resolved"; h.incident.endUnix = f.tsUnix; h.incident = null;
          } else if (h.incident) { h.incident.confidence = score; h.incident.dataQuality = q; }
        }
      }
    }
    // Only explicit legal statuses can open or resolve a fault; missing status never resolves it.
    if (r.pumpStatus === 0 || r.pumpStatus === 1 || r.pumpStatus === 2) {
      if ((r.pumpStatus === 2 || a.heads[2].active) && !a.active) {
        const id = `${input.runId}:pump_failure:${f.facilityId}:${f.tsUnix}`;
        const inferred = r.pumpStatus !== 2;
        a.active = { id, category: "pump_failure", status: "ongoing", systemId: meta.system.id, facilityId: f.facilityId, assetId: meta.facility.pump.id, onsetUnix: f.tsUnix, endUnix: null, confidence: inferred ? a.heads[2].confidence : null, evidence: [inferred ? (board ? `${boardLabel}: pump_failure active on the board.` : `Registered model ${model!.id} pump-failure head exceeded threshold for ${model!.persistK} usable observations; software inference.`) : "Pump status reports fault (2)."], provenance: inferred && board ? boardProvenance : "software", modelVersion: inferred ? (board ? boardVersion : model!.id) : null, dataQuality: q };
        if (a.lastPumpTs === null || f.tsUnix - a.lastPumpTs > STEP) a.leftCensored.add(id);
        a.incidents.push(a.active); a.inflows = [];
      } else if (r.pumpStatus !== 2 && !a.heads[2].active && a.active) {
        a.active.status = "resolved"; a.active.endUnix = f.tsUnix; a.active = null; a.inflows = [];
      }
      a.lastPumpTs = f.tsUnix;
    }
    if (a.active && r.inflowBpd !== null && r.inflowBpd >= 0) { a.inflows.push(r.inflowBpd); if (a.inflows.length > 16) a.inflows.shift(); }
    if (r.wellStatus.every(v => v === 0 || v === 1) && r.wellWaterBpd.every(v => v !== null && v >= 0)) a.shutIn = r.wellStatus.every(v => v === 0) && r.wellWaterBpd.every(v => v === 0);
    else a.shutIn = null;
  }
  await flush();
  } finally { runtime.dispose(); }
  abort(options?.signal);
  const systems: SystemState[] = []; const alerts: Incident[] = []; const history: Incident[] = []; const fleets: Snapshot["fleets"] = [];
  let planCost = 0; let planningIncomplete = false;
  for (const system of dataset.network.systems) {
    const ops = dataset.ops.systems[system.id];
    const facilities: FacilityState[] = [];
    for (const f of system.facilities) {
      const a = acc.get(f.id)!; const latest = a.frames.at(-1); const fresh = !!latest && latest.tsUnix === at;
      const q: DataQuality = fresh ? a.quality : { quality: "DROPPED", reasons: [latest ? "no telemetry at replay cutoff" : "no telemetry"] };
      const wells = f.wells.map((w, i) => { const revenuePerHour = (w.oil_bpd * dataset.ops.prices.oil_per_bbl + w.gas_mcfd * dataset.ops.prices.gas_per_mcf) / 24; return { id: w.id, producing: fresh && latest?.wellStatus[i] === 1, waterBpd: fresh ? value(latest?.wellWaterBpd[i]) ?? 0 : 0, baselineWaterBpd: w.baseline_water_bpd, oilBpd: w.oil_bpd, gasMcfd: w.gas_mcfd, revenuePerHour, costPerBblAvoided: w.baseline_water_bpd > 0 ? revenuePerHour * 24 / w.baseline_water_bpd : 0 }; });
      const revenue = wells.reduce((sum, w) => sum + w.revenuePerHour, 0);
      const level = fresh ? value(latest?.levelPct) : null; const inflow = fresh ? value(latest?.inflowBpd) : null;
      const status = fresh && (latest?.pumpStatus === 0 || latest?.pumpStatus === 1 || latest?.pumpStatus === 2) ? latest.pumpStatus : null;
      const recent = a.frames.filter(x => x.tsUnix >= at - 48 * 3600);
      const stride = Math.max(1, Math.ceil(recent.length / 300));
      const buckets: Frame[][] = [];
      for (let i = 0; i < recent.length; i += stride) buckets.push(recent.slice(i, i + stride));
      // A bucket containing a gap remains null rather than visually bridging it.
      const series = (get: (f: Frame) => number | null) => ({ t: buckets.map(b => b[b.length - 1].tsUnix), v: buckets.map(b => b.some(x => value(get(x)) === null) ? null : value(get(b[b.length - 1]))) });
      const ongoing = a.incidents.filter(x => x.status === "ongoing");
      const incidentIds = ongoing.map(x => x.id);
      const state: FacilityState = { id: f.id, systemId: system.id, letter: f.id, lat: f.lat, lon: f.lon, tank: { id: f.tank.id, capacityBbl: f.tank.capacity_bbl, levelPct: level }, pump: { id: f.pump.id, status, flowBpd: fresh ? value(latest?.pumpFlowBpd) : null, maxFlowBpd: f.pump.max_flow_bpd, dischargePsi: fresh ? value(latest?.dischargePsi) : null, startLevelPct: f.pump.start_level_pct, stopLevelPct: f.pump.stop_level_pct }, pipeline: { id: f.pipeline.id, receiveFlowBpd: fresh ? value(latest?.receiveFlowBpd) : null, pressurePsi: fresh ? value(latest?.pipelinePsi) : null }, inflowBpd: inflow, wells, fillPctPerHour: inflow !== null && fresh && validNumber(latest?.pumpFlowBpd) ? (inflow - latest.pumpFlowBpd) / 24 / f.tank.capacity_bbl * 100 : null, revenuePerHour: revenue, observedShutIn: fresh && a.observed ? a.shutIn : null, health: a.active ? "failure" : !fresh || !a.observed ? "no_data" : a.shutIn ? "shut_in" : a.heads[0].incident ? "leak" : a.heads[1].incident ? "degradation" : (board ? board.has(boardKey(f.id, at)) : !!model) ? "ok" : "unknown", dataQuality: q, incidentIds, series: { level: series(x => x.levelPct), inflow: series(x => x.inflowBpd), pumpFlow: series(x => x.pumpFlowBpd), receiveFlow: series(x => x.receiveFlowBpd) } };
      facilities.push(state);
      history.push(...a.incidents.filter(x => x.status === "resolved"));
      for (const incident of ongoing) if (incident.category !== "pump_failure") { incident.dataQuality = q; alerts.push(incident); }
      if (!a.active) continue;
      const incident = a.active; incident.dataQuality = q; incident.lostRevenuePerHour = revenue;
      if (level !== null) incident.levelPct = level;
      // Do not use a stale inflow history when the current inflow is missing.
      incident.countdown = countdown(level, inflow !== null && inflow >= 0 ? a.inflows : [], f.tank.capacity_bbl, dataset.network.defaults.tank_limits_pct.shutdown, q.quality);
      incident.hoursToLimit = incident.countdown.hours;
      incident.repairEndsUnix = incident.onsetUnix + dataset.ops.expected_repair_hours.pump_failure * 3600;
      const horizonMin = (incident.repairEndsUnix - at) / 60;
      const fo = ops?.facilities[f.id];
      if (a.leftCensored.has(incident.id) || horizonMin <= 0) { incident.planningStatus = "uncertain_horizon"; planningIncomplete = true; }
      else if (!fresh || !a.observed || level === null || inflow === null || !fo || f.wells.some((_, i) => (latest!.wellStatus[i] !== 0 && latest!.wellStatus[i] !== 1) || !validNumber(latest!.wellWaterBpd[i]) || latest!.wellWaterBpd[i]! < 0)) { incident.planningStatus = "insufficient_data"; planningIncomplete = true; }
      else incident.planningStatus = "ready";
      alerts.push(incident);
    }
    systems.push({ id: system.id, center: system.center, truckYard: system.truck_yard, disposal: { id: system.disposal_site.id, lat: system.disposal_site.lat, lon: system.disposal_site.lon, pressurePsi: system.disposal_site.pressure_psi }, fleetSize: ops?.emergency_fleet_size ?? 0, facilities });
    const fleet: Snapshot["fleets"][number] = { systemId: system.id, size: ops?.emergency_fleet_size ?? 0, assignments: [], basis: "proposed" }; fleets.push(fleet);
    const systemAlerts = alerts.filter(x => x.systemId === system.id && x.category === "pump_failure");
    const uncertainSharedFleet = systemAlerts.some(x => x.planningStatus !== "ready");
    if (uncertainSharedFleet) for (const incident of systemAlerts) if (incident.planningStatus === "ready") incident.planningStatus = "insufficient_data";
    if (systemAlerts.length && !uncertainSharedFleet) {
      const planning = planningInput(dataset, systems, alerts, at, revision, system.id);
      const jobs = planning.jobs;
      const plan = await solveSystemPlan(planning);
      const validation = validateSystemPlan(planning, plan);
      if (validation.valid) { fleet.assignments = plan.assignments; planCost += plan.totalCost; for (const job of jobs) { const incident = alerts.find(x => x.id === job.incidentId)!; incident.plan = plan.recommendedByIncident[job.incidentId]; incident.options = plan.optionsByIncident[job.incidentId]; } }
      else { planningIncomplete = true; for (const job of jobs) alerts.find(x => x.id === job.incidentId)!.planningStatus = "insufficient_data"; }
    }
  }
  alerts.sort((a, b) => Number(a.category !== "pump_failure") - Number(b.category !== "pump_failure") || (a.hoursToLimit?.p50 ?? Infinity) - (b.hoursToLimit?.p50 ?? Infinity) || (b.lostRevenuePerHour ?? 0) - (a.lostRevenuePerHour ?? 0) || a.id.localeCompare(b.id));
  const expected = facilityMap.size; const received = [...acc.values()].filter(a => a.frames.at(-1)?.tsUnix === at && a.observed).length;
  const complete = [...acc.values()].every(a => a.frames.at(-1)?.tsUnix === at && a.complete);
  const reasons = [...(input.runtime === "auto" ? hardwareReasons.map(x => `Software fallback: ${x}`) : []), ...(board ? [`Detections from ${boardLabel}; latest board result ${Math.round((at - boardLast!.tsUnix) / 60)} min before the cutoff`] : options?.board?.size ? ["Board results do not cover this dataset or cutoff; they were not used"] : []), ...(board || model ? [] : ["Classifier unavailable: no registered model with validated scale and thresholds; leak and degradation detection unavailable"]), board ? "Countdown and plans: host, inflow only" : "Software inference is not FPGA bit-exact; host countdown uses inflow only"];
  return { runId: input.runId, revision, cursor: 0, parentRunId: input.parentRunId ?? null, dataset: dataset.info, nowUnix: at, board: null, runtime: { requested: input.runtime, effective: "software", state: "degraded", reasons, scoresAvailable: !!board || !!model, modelVersion: board ? boardVersion : model?.id ?? null }, coverage: { expected, received, complete }, recommendation: { state: planningIncomplete ? "unavailable" : "ready", inputRevision: revision, currentRevision: revision }, limits: { warningPct: dataset.network.defaults.tank_limits_pct.warning, shutdownPct: dataset.network.defaults.tank_limits_pct.shutdown }, systems, alerts, history, fleets, totals: { facilities: expected, atRisk: new Set(alerts.map(x => x.facilityId)).size, revenueAtRiskPerHour: alerts.reduce((sum, x) => sum + (x.lostRevenuePerHour ?? 0), 0), planCost } };
}
