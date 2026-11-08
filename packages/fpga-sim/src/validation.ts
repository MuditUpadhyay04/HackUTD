import type { FacilityConfig, GlobalConfig, ReasonBits, ResultStatus, TelemetryRecord, FacilityRunState } from './types.ts';

export function emptyReason(): ReasonBits {
  return { fieldHeld:false, stepGapHeld:false, historyReset:false, outOfRange:false, illegalEnum:false, featureSaturated:false, pumpFlowInconsistent:false, wellInconsistent:false, duplicate:false, outOfOrder:false, unknownFacility:false };
}

type Values = FacilityRunState['lastValid'];
export function validateRecord(record: TelemetryRecord, cfg: FacilityConfig, global: GlobalConfig, prevTs: number | null, last: Values, ages: Record<string, number> = {}, step = 300) {
  const reason = emptyReason();
  const delta = prevTs === null ? step : record.tsUnix - prevTs;
  const skipped = Math.max(0, Math.ceil(delta / step) - 1);
  const reset = skipped > global.holdMax || (delta > 0 && delta % step !== 0);
  reason.historyReset = reset;
  reason.stepGapHeld = skipped > 0 && !reset;
  let missing = false, unavailable = false;
  const nextAges: Record<string, number> = {};
  function field(key: string, value: number | null | undefined, present: boolean | undefined, prior: number | null | undefined, lo: number, hi: number, enumField = false): number | null {
    let ok = present === true && typeof value === 'number' && Number.isFinite(value);
    if (ok && (value! < lo || value! > hi || (enumField && !Number.isInteger(value)))) {
      if (enumField) reason.illegalEnum = true; else reason.outOfRange = true;
      ok = false;
    }
    if (ok) { nextAges[key] = 0; return value!; }
    missing = true;
    const age = (ages[key] ?? 0) + skipped + 1;
    nextAges[key] = age;
    if (!reset && prior != null && age <= global.holdMax) { reason.fieldHeld = true; return prior; }
    unavailable = true;
    return null;
  }
  const p = record.present;
  const used: Values = {
    inflowBpd: field('inflowBpd',record.inflowBpd,p.inflow,last.inflowBpd,cfg.lo[0],cfg.hi[0]),
    levelPct: field('levelPct',record.levelPct,p.level,last.levelPct,cfg.lo[1],cfg.hi[1]),
    pumpStatus: field('pumpStatus',record.pumpStatus,p.pumpStatus,last.pumpStatus,0,2,true),
    pumpFlowBpd: field('pumpFlowBpd',record.pumpFlowBpd,p.pumpFlow,last.pumpFlowBpd,cfg.lo[3],cfg.hi[3]),
    receiveFlowBpd: field('receiveFlowBpd',record.receiveFlowBpd,p.receiveFlow,last.receiveFlowBpd,cfg.lo[4],cfg.hi[4]),
    dischargePsi: field('dischargePsi',record.dischargePsi,p.discharge,last.dischargePsi,cfg.lo[5],cfg.hi[5]),
    pipelinePsi: field('pipelinePsi',record.pipelinePsi,p.pipeline,last.pipelinePsi,cfg.lo[6],cfg.hi[6]),
    wellStatus: [], wellWaterBpd: [],
  };
  for (let i=0; i<cfg.nWells; i++) {
    used.wellStatus.push(field(`ws${i}`,record.wellStatus[i],p.wellStatus[i],last.wellStatus[i],0,1,true));
    used.wellWaterBpd.push(field(`ww${i}`,record.wellWaterBpd[i],p.wellWater[i],last.wellWaterBpd[i],cfg.wellLo,cfg.wellHi));
    if (used.wellStatus[i] === 0 && (used.wellWaterBpd[i] ?? 0) > 0) reason.wellInconsistent = true;
  }
  if ((used.pumpStatus === 0 || used.pumpStatus === 2) && (used.pumpFlowBpd ?? 0) > 0) reason.pumpFlowInconsistent = true;
  const status: ResultStatus = unavailable ? 3 : (missing || skipped > 0 || reset ? 1 : 0);
  return { status, reason, gapSteps: skipped + 1, hold: missing || skipped > 0, reset, used, nextAges };
}
