// Deterministic label lanes for one facility row. Labels are screen-sized (they counter-scale with the camera), so the
// lanes are in screen px relative to the row's line (y = 0, down is positive); only the anchors are world points.
//   name lane : friendly facility name ("Facility B"), left-aligned above the line start
//   pill lane : status pill on the row line, from just right of the pump station to just before the pipeline end
// Two independent guarantees:
//   vertical   : the row tier is picked from the row pitch in screen px, so a pill never reaches the next row's name lane;
//   horizontal : a pill never extends past the pipeline end (where the line bends into the merging trunk), so it cannot
//                touch the trunk or a neighbouring row's merge segment. When the text does not fit, it degrades through
//                shorter variants (full, short, tiny, dot) instead of overflowing.
import { facilityName } from "./format";
import type { Box, LineLayout } from "./pipeview-layout";

export type RowTier = "full" | "short" | "mini" | "none";
export type PillVariant = "full" | "short" | "tiny" | "dot";

export const ID_CH = 6.2; // estimated px per character of the 10.5px facility name
export const PILL_CH = 6.5; // estimated px per character of the 10.5px pill text
export const PILL_PAD = 23; // shape + paddings around the pill text
export const DOT_W = 22; // shape-only pill
const GAP = 4; // minimum clear px between two label boxes
/** World units kept clear before the pipeline end (the merge arc starts a few units before it), plus a screen margin. */
export const TRUNK_CLEAR = 8;
export const TRUNK_MARGIN = 3;
/** Screen radius of the pump ring at zoom z is PUMP_RING * min(1, 2z) (glyphs cap their growth and shrink when far out). */
const PUMP_RING = 10.5;

/** y extents (px, relative to the row line) of each lane per tier. `id` is [top, baseline]. */
export const LANES: Record<Exclude<RowTier, "none">, { pillH: number; id: readonly [number, number] | null }> = {
  full: { pillH: 18, id: [-27, -16] },
  short: { pillH: 14, id: [-22, -12] },
  mini: { pillH: 14, id: null },
};

/** Row tier from the row pitch in px: the richest tier whose pill keeps GAP px from the next row's name lane. */
export function rowTier(pitchPx: number): RowTier {
  for (const t of ["full", "short", "mini"] as const) {
    const { pillH, id } = LANES[t];
    const top = id ? id[0] : -pillH / 2;
    if (pitchPx + top >= pillH / 2 + GAP) return t;
  }
  return "none";
}

/** Friendly short name for the map: "S5_FACILITY_B" -> "Facility B". Unknown id shapes pass through unchanged. */
export function facilityLabel(id: string): string {
  const n = facilityName(id);
  const i = n.indexOf(" ");
  const rest = i > 0 ? n.slice(i + 1).replace(/_/g, " ").trim() : "";
  if (!rest) return id;
  const nice = rest.length > 1 ? rest.toLowerCase().replace(/(^|\s)(\S)/g, (_, a: string, b: string) => a + b.toUpperCase()) : rest.toUpperCase();
  const s = `Facility ${nice}`;
  return s.length > 22 ? `${s.slice(0, 19)}...` : s;
}

/** Short form of a pill text for tight rows (full text stays in the tooltip / title). */
export function shortPill(text: string): string {
  return text
    .replace(/^Pump down, unknown$/, "Down ?")
    .replace(/^Pump down/, "Down")
    .replace(/^Shut down$/, "Shut")
    .replace(/^Inspect (\d+ bbl\/d)$/, "Leak $1")
    .replace(/^Inspect (\d+% loss)$/, "Worn $1")
    .replace(/^Inspect leak$/, "Leak")
    .replace(/^Inspect pump$/, "Worn")
    .replace(/^Inspect /, "Chk ");
}

/** Smallest readable form: the countdown alone for a pump down ("03:28"), else one word. */
export function tinyPill(text: string): string {
  const down = /^Pump down (\d.*)$/.exec(text);
  if (down) return down[1];
  if (/^Pump down, unknown$/.test(text)) return "Down ?";
  if (/^Pump down/.test(text)) return "Down";
  if (/^Shut/.test(text)) return "Shut";
  if (/^Inspect (leak|\d+ bbl\/d)$/.test(text)) return "Leak";
  if (/^Inspect (pump|\d+% loss)$/.test(text)) return "Worn";
  if (/^No data/.test(text)) return "No data";
  if (/^Held/.test(text)) return "Held";
  const w = text.split(" ")[0] ?? text;
  return w.length > 8 ? `${w.slice(0, 7)}.` : w;
}

export const pillWidth = (text: string) => Math.ceil(text.length * PILL_CH) + PILL_PAD;

const VARIANT_ORDER: readonly PillVariant[] = ["full", "short", "tiny", "dot"];

export interface PillPlan {
  row: RowTier;
  /** Null when no variant fits (the tooltip, line color and tank ring still carry the state). */
  variant: PillVariant | null;
  text: string;
  /** Width and height of the pill in px, and its left edge as an offset (px) from the pump anchor. */
  w: number;
  h: number;
  x: number;
  /** Whether the friendly name above the line is shown at this row pitch. */
  name: boolean;
}

/** Offset (px) from the pump center to the pill's left edge: clears the pump ring at this zoom. */
export const pillGap = (z: number) => Math.ceil(4 + PUMP_RING * Math.min(1, 2 * z));

/** Horizontal room (px) for a pill on a row at zoom z: pump ring to just before the pipeline end. */
export function pillSpan(line: Pick<LineLayout, "pump" | "pipe">, z: number): number {
  const end = line.pipe[line.pipe.length - 1][0];
  return (end - TRUNK_CLEAR - line.pump[0]) * z - TRUNK_MARGIN - pillGap(z);
}

/** Which pill variant to draw for this text at zoom z and row pitch (px). Pure; shared by the view and the tests. */
export function planPill(line: Pick<LineLayout, "pump" | "pipe">, z: number, text: string, pitchPx: number): PillPlan {
  const row = rowTier(pitchPx);
  const none: PillPlan = { row, variant: null, text, w: 0, h: 0, x: pillGap(z), name: row === "full" || row === "short" };
  if (row === "none" || !text) return none;
  const span = pillSpan(line, z);
  for (const v of VARIANT_ORDER) {
    if (v === "full" && row !== "full") continue;
    const t = v === "full" ? text : v === "short" ? shortPill(text) : v === "tiny" ? tinyPill(text) : "";
    const w = v === "dot" ? DOT_W : pillWidth(t);
    if (w <= span) return { ...none, variant: v, text: t, w, h: v === "full" ? LANES.full.pillH : LANES.short.pillH };
  }
  return none;
}

/** Row pitch (world units) per row: distance to the nearest neighbouring row of the same cluster. */
export function rowPitches(lines: readonly Pick<LineLayout, "rowY">[]): number[] {
  return lines.map((l, i) => Math.min(
    i > 0 ? l.rowY - lines[i - 1].rowY : Infinity,
    i < lines.length - 1 ? lines[i + 1].rowY - l.rowY : Infinity,
  ));
}

/** Screen-px boxes (camera z, camera offset 0) of one row's name label and pill, for the plan at `pitchPx`. */
export function labelBoxes(line: LineLayout, z: number, pillText: string, pitchPx: number): { id: Box | null; pill: Box | null } {
  const plan = planPill(line, z, pillText, pitchPx);
  const y = line.rowY * z;
  const lane = plan.row === "none" ? null : LANES[plan.row];
  const px = line.anchors.state[0] * z + plan.x;
  const pill: Box | null = plan.variant ? { x0: px, x1: px + plan.w, y0: y - plan.h / 2, y1: y + plan.h / 2 } : null;
  const id: Box | null = plan.name && lane?.id
    ? { x0: line.anchors.id[0] * z, x1: line.anchors.id[0] * z + facilityLabel(line.facilityId).length * ID_CH, y0: y + lane.id[0], y1: y + lane.id[1] + 3 }
    : null;
  return { id, pill };
}
