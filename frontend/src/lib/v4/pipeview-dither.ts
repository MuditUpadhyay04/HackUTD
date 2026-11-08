// 4x4 Bayer ordered dither helpers (Pipe View). Pure.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** Cells (x, y in 0..3) that are lit for a lit fraction 0..1. */
export function bayerCells(lit: number): [number, number][] {
  const n = Math.round(Math.max(0, Math.min(1, lit)) * 16);
  const out: [number, number][] = [];
  for (let i = 0; i < 16; i++) if (BAYER[i] < n) out.push([i % 4, (i / 4) | 0]);
  return out;
}

/** Ink fraction for a data-quality severity: HELD 25% grain, INVALID 50%, DROPPED or missing 75% (ink = 1 - grain). */
export const GRAIN_BY_Q = { 1: 0.25, 2: 0.5, 3: 0.75 } as const;
