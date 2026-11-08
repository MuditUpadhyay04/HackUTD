// Deterministic label lanes for one facility row. Labels are screen-sized (they counter-scale with the camera), so the
// lanes are in screen px relative to the row's line (y = 0, down is positive); only the anchors are world points.
//   id lane   : facility ID, left-aligned above the line start
//   pill lane : status pill on the line, left edge a fixed gap to the right of the pump station
// The tier is picked from the row pitch in screen px so a pill never reaches the next row's id lane.
import type { Box, LineLayout } from "./pipeview-layout";

export type PillTier = "full" | "short" | "mini" | "none";

export const ID_CH = 6.4; // estimated px per character of the 10.5px facility ID
export const PILL_CH = 5.9; // estimated px per character of the 10.5px pill text
export const PILL_PAD = 26; // shape + paddings around the pill text
export const PILL_GAP = 18; // px from the pump center to the pill's left edge
const GAP = 4; // minimum clear px between two label boxes

/** y extents (px, relative to the row line) of each lane per tier. `id` is [top, baseline]. */
export const LANES: Record<Exclude<PillTier, "none">, { pillH: number; id: readonly [number, number] | null }> = {
  full: { pillH: 18, id: [-25, -14] },
  short: { pillH: 14, id: [-21, -10] },
  mini: { pillH: 14, id: null },
};

/** Smallest row pitch (px) at which each tier keeps GAP px between its pill and the next row's id lane. */
export function pillTier(pitchPx: number): PillTier {
  for (const t of ["full", "short", "mini"] as const) {
    const { pillH, id } = LANES[t];
    const top = id ? id[0] : -pillH / 2;
    if (pitchPx + top >= pillH / 2 + GAP) return t;
  }
  return "none";
}

/** Short form of a pill text for tight rows (full text stays in the tooltip / title). */
export function shortPill(text: string): string {
  return text
    .replace(/^Pump down, unknown$/, "Down ?")
    .replace(/^Pump down/, "Down")
    .replace(/^Shut down$/, "Shut")
    .replace(/^Inspect leak$/, "Leak")
    .replace(/^Inspect pump$/, "Worn")
    .replace(/^Inspect /, "Chk ");
}

export const pillWidth = (text: string) => Math.ceil(text.length * PILL_CH) + PILL_PAD;

/** Row pitch (world units) per row: distance to the nearest neighbouring row of the same cluster. */
export function rowPitches(lines: readonly Pick<LineLayout, "rowY">[]): number[] {
  return lines.map((l, i) => Math.min(
    i > 0 ? l.rowY - lines[i - 1].rowY : Infinity,
    i < lines.length - 1 ? lines[i + 1].rowY - l.rowY : Infinity,
  ));
}

/** Screen-px boxes (camera z, camera offset 0) of one row's id label and pill, for the tier picked by `pitchPx`. */
export function labelBoxes(line: LineLayout, z: number, pillText: string, tier: PillTier): { id: Box | null; pill: Box | null } {
  if (tier === "none") return { id: null, pill: null };
  const lane = LANES[tier];
  const text = tier === "full" ? pillText : shortPill(pillText);
  const px = line.anchors.state[0] * z + PILL_GAP, y = line.rowY * z;
  const pill: Box = { x0: px, x1: px + pillWidth(text), y0: y - lane.pillH / 2, y1: y + lane.pillH / 2 };
  const id: Box | null = lane.id
    ? { x0: line.anchors.id[0] * z, x1: line.anchors.id[0] * z + line.facilityId.length * ID_CH, y0: y + lane.id[0], y1: y + lane.id[1] + 3 }
    : null;
  return { id, pill };
}
