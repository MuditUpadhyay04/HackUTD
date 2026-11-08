/**
 * Rule flags computed from RESULT inputs (per the FPGA RESULT record `rules` byte):
 *   bit 0 pump_fault (status 2)
 *   bit 1 shut_in (all configured wells status 0 and water 0)
 *   bit 2 level >= shutdown
 *   bit 3 level >= warning
 *   bit 4 not filling (net inflow <= 0)
 *
 * Rule flags fire whenever their own inputs are valid; bad input does not suppress
 * a rule whose own inputs are valid (per the FPGA bad-data policy).
 */

import type { FacilityConfig } from "./types.ts";

export interface RuleInputs {
  pumpStatus: number | null;
  wellStatus: (number | null)[];
  wellWaterBpd: (number | null)[];
  levelPct: number | null;
  shutdownLvl: number; // 0.01 %
  warningLvl: number; // 0.01 %
  netInflowBpd: number | null;
  nWells: number;
}

export function computeRules(inputs: RuleInputs): {
  pumpFault: boolean;
  shutIn: boolean;
  levelAtShutdown: boolean;
  levelAtWarning: boolean;
  notFilling: boolean;
} {
  const pumpFault = inputs.pumpStatus === 2;

  // shut_in: all configured wells status 0 and water 0.
  let shutIn = true;
  for (let i = 0; i < inputs.nWells; i++) {
    const ws = inputs.wellStatus[i];
    const ww = inputs.wellWaterBpd[i];
    if (ws == null || ww == null) {
      // Cannot determine; treat as not shut-in until known (never healthy-by-default).
      shutIn = false;
      break;
    }
    if (ws !== 0 || ww !== 0) {
      shutIn = false;
      break;
    }
  }

  let levelAtShutdown = false;
  let levelAtWarning = false;
  if (inputs.levelPct !== null) {
    levelAtShutdown = inputs.levelPct >= inputs.shutdownLvl / 100;
    levelAtWarning = inputs.levelPct >= inputs.warningLvl / 100;
  }

  const notFilling = inputs.netInflowBpd !== null && inputs.netInflowBpd <= 0;

  return { pumpFault, shutIn, levelAtShutdown, levelAtWarning, notFilling };
}
