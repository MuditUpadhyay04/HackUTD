// Pipe View metro layout. Pure and typed: computed only from the order and counts it is given (hard rule 2), so it
// works for any number of systems, up to 32 facilities per system and 8 wells per facility. Units are world units.
//
// The corner skeleton is horizontal, vertical or 45 degrees (transit map); every bend is then rounded into a smooth
// arc (ARC_RADIUS map units, sampled into short chords) so lines read soft, not mechanical. Per facility:
//   wells -> (45 degree fan) -> row -> tank station -> pump station -> pipeline -> (45 degrees) -> lane -> terminus
// Facility rows stack top to bottom in network order; lanes are a parallel bundle centered on the system trunk.
// Row order and lane order are the same, so no two lines of a system ever cross.

import { FIT_PAD } from "./pipeview-camera";

export type Pt = readonly [number, number];

export interface Box { x0: number; y0: number; x1: number; y1: number }

export interface SystemInput { id: string; facilities: { id: string; wellIds: readonly string[] }[] }

/** Column x positions inside a cluster (cluster-local; the layout shifts them into world space). */
export const COL = { well: 0, bend: 36, tank: 200, pump: 285, pipeEnd: 440 } as const;
export const WELL_PITCH = 18;
export const LANE_PITCH = 11;
export const ROW_MIN = 72;
export const ROW_PAD = 26;
/** Default width/height the grid of clusters is shaped for (the Pipe View pane is wide and short). */
export const TARGET_ASPECT = 2.6;
export const CLUSTER_GAP = 160;
/** Fillet radius of every bend, in map units (soften pass: 14 to 18). */
export const ARC_RADIUS = 16;
/** Chords per arc; a 45 degree bend turns at most 45/ARC_STEPS degrees per chord. */
const ARC_STEPS = 6;
const PAD = { left: 70, top: 62, right: 46, bottom: 24 };

export interface WellLayout { id: string; at: Pt; path: Pt[] }

export interface LineLayout {
  facilityId: string;
  systemId: string;
  /** Index within the system (drives the neon color). */
  index: number;
  wells: WellLayout[];
  /** Wells merge, then tank, then pump (inflow side). */
  up: Pt[];
  /** Pump to the pipeline end (the pipeline segment a leak hatches). */
  pipe: Pt[];
  /** Pump, pipeline, merge into the trunk lane, to the terminus (the flow-out side). */
  down: Pt[];
  /** up followed by down (one continuous line, wells excluded). */
  full: Pt[];
  rowY: number;
  laneY: number;
  tank: Pt;
  pump: Pt;
  /** Distance along `down` of the pipeline midpoint (where a leak hatches and packets drift off). */
  leakS: number;
  anchors: { id: Pt; flow: Pt; state: Pt; tank: Pt; alarm: Pt };
  box: Box;
}

export interface ClusterLayout {
  systemId: string;
  index: number;
  origin: Pt;
  bounds: Box;
  trunkY: number;
  terminus: { x: number; y: number; r: number };
  titleAt: Pt;
  lines: LineLayout[];
}

export interface PipeLayout { clusters: ClusterLayout[]; bounds: Box; /** Row pitch (world units) of the tightest pair of rows in any cluster; Infinity with fewer than two rows. */ minRowPitch: number }

const shift = (p: Pt, dx: number, dy: number): Pt => [p[0] + dx, p[1] + dy];

/** Drops consecutive duplicate points so no segment has zero length. */
function clean(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || q[0] !== p[0] || q[1] !== p[1]) out.push(p);
  }
  return out;
}

/**
 * Rounds every interior corner of a polyline into a circular-looking arc of the given radius (quadratic curve with the
 * fillet tangent length, sampled into ARC_STEPS chords). The tangent length is clamped to 45% of the adjacent
 * segments so neighbouring bends never collide. Endpoints are kept exactly. Collinear points pass through.
 */
export function roundCorners(pts: readonly Pt[], radius = ARC_RADIUS): Pt[] {
  if (pts.length < 3) return pts.map((p) => [p[0], p[1]] as Pt);
  const out: Pt[] = [[pts[0][0], pts[0][1]]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]), l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const u1: Pt = [(b[0] - a[0]) / l1, (b[1] - a[1]) / l1], u2: Pt = [(c[0] - b[0]) / l2, (c[1] - b[1]) / l2];
    const cosT = Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1]));
    const turn = Math.acos(cosT); // heading change at this corner
    if (turn < 1e-3) { out.push([b[0], b[1]]); continue; }
    const t = Math.min(radius * Math.tan(turn / 2), l1 * 0.45, l2 * 0.45);
    const p0: Pt = [b[0] - u1[0] * t, b[1] - u1[1] * t];
    const p1: Pt = [b[0] + u2[0] * t, b[1] + u2[1] * t];
    for (let k = 0; k <= ARC_STEPS; k++) {
      const f = k / ARC_STEPS, g = 1 - f;
      out.push([g * g * p0[0] + 2 * g * f * b[0] + f * f * p1[0], g * g * p0[1] + 2 * g * f * b[1] + f * f * p1[1]]);
    }
  }
  const last = pts[pts.length - 1];
  out.push([last[0], last[1]]);
  return out;
}

export function polyLength(pts: readonly Pt[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return s;
}

export function cumulative(pts: readonly Pt[]): number[] {
  const c = [0];
  for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return c;
}

/** Point and heading (radians) at distance s along a polyline with precomputed cumulative lengths. */
export function along(pts: readonly Pt[], cum: readonly number[], s: number): { x: number; y: number; ang: number } {
  if (pts.length < 2) return { x: pts[0]?.[0] ?? 0, y: pts[0]?.[1] ?? 0, ang: 0 };
  const total = cum[cum.length - 1];
  const d = Math.max(0, Math.min(total, s));
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const span = cum[i] - cum[i - 1] || 1;
  const f = (d - cum[i - 1]) / span;
  const a = pts[i - 1], b = pts[i];
  return { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, ang: Math.atan2(b[1] - a[1], b[0] - a[0]) };
}

function unionBox(boxes: Box[]): Box {
  if (boxes.length === 0) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  return {
    x0: Math.min(...boxes.map((b) => b.x0)), y0: Math.min(...boxes.map((b) => b.y0)),
    x1: Math.max(...boxes.map((b) => b.x1)), y1: Math.max(...boxes.map((b) => b.y1)),
  };
}

function polyBox(pts: readonly Pt[], pad: number): Box {
  return {
    x0: Math.min(...pts.map((p) => p[0])) - pad, y0: Math.min(...pts.map((p) => p[1])) - pad,
    x1: Math.max(...pts.map((p) => p[0])) + pad, y1: Math.max(...pts.map((p) => p[1])) + pad,
  };
}

function buildCluster(sys: SystemInput, index: number, ox: number, oy: number): ClusterLayout {
  const n = sys.facilities.length;
  const heights = sys.facilities.map((f) => Math.max(ROW_MIN, f.wellIds.length * WELL_PITCH + ROW_PAD));
  const H = n === 0 ? ROW_MIN : heights.reduce((a, b) => a + b, 0);
  const trunkY = H / 2;

  // Row centers and lane positions (same order, so lines never cross).
  const rows: number[] = [];
  let acc = 0;
  for (let i = 0; i < n; i++) { rows.push(acc + heights[i] / 2); acc += heights[i]; }
  const laneAt = (i: number) => trunkY + (i - (n - 1) / 2) * LANE_PITCH;
  const spread = Math.max(0, n - 1) * LANE_PITCH;
  const R = Math.max(24, spread / 2 + 10);
  let maxdy = 0;
  for (let i = 0; i < n; i++) maxdy = Math.max(maxdy, Math.abs(laneAt(i) - rows[i]));
  const termX = COL.pipeEnd + maxdy + 100 + R;

  const lines: LineLayout[] = sys.facilities.map((fac, i) => {
    const y = rows[i], lane = laneAt(i), dy = lane - y, ady = Math.abs(dy);
    const nw = fac.wellIds.length;
    const wellDy = ((nw - 1) / 2) * WELL_PITCH;
    const xs = COL.bend + wellDy + 16;
    const wells: WellLayout[] = fac.wellIds.map((id, j) => {
      const wy = y + (j - (nw - 1) / 2) * WELL_PITCH;
      const d = y - wy;
      const raw: Pt[] = [[COL.well, wy], [COL.bend, wy]];
      if (d !== 0) raw.push([COL.bend + Math.abs(d), y]);
      raw.push([xs, y]);
      const path = roundCorners(clean(raw)).map((p) => shift(p, ox, oy));
      return { id, at: [COL.well + ox, wy + oy], path };
    });
    const endx = termX - Math.sqrt(Math.max(0, R * R - (lane - trunkY) ** 2)) + 2;
    const up = clean([[nw > 0 ? xs : COL.bend, y], [COL.tank, y], [COL.pump, y]]).map((p) => shift(p, ox, oy));
    const pipe = clean([[COL.pump + 16, y], [COL.pipeEnd, y]]).map((p) => shift(p, ox, oy));
    const downRaw: Pt[] = [[COL.pump, y], [COL.pipeEnd, y]];
    if (ady > 0) downRaw.push([COL.pipeEnd + ady, lane]);
    downRaw.push([endx, lane]);
    const down = roundCorners(clean(downRaw)).map((p) => shift(p, ox, oy));
    const full = clean([...up, ...down]); // up is straight, so full is up + the rounded down
    const midX = (COL.pump + COL.pipeEnd) / 2 + 8;
    const all = [...up, ...down, ...wells.flatMap((w) => w.path)];
    return {
      facilityId: fac.id, systemId: sys.id, index: i, wells, up, pipe, down, full,
      rowY: y + oy, laneY: lane + oy,
      tank: [COL.tank + ox, y + oy], pump: [COL.pump + ox, y + oy],
      leakS: (COL.pipeEnd - COL.pump) / 2,
      anchors: {
        // World anchors on the row line; pipeview-labels.ts places each label in a fixed screen-px lane around them.
        id: [(nw > 0 ? xs : COL.bend) + ox, y + oy],
        flow: [midX + ox, y + oy],
        state: [COL.pump + ox, y + oy],
        tank: [COL.tank + ox, y + 25 + oy],
        alarm: [COL.tank + ox, y + 35 + oy],
      },
      box: polyBox(all, 20),
    };
  });

  const bounds: Box = {
    x0: ox - PAD.left,
    y0: oy - PAD.top,
    x1: ox + termX + R + PAD.right,
    y1: oy + Math.max(H, trunkY + R + 44) + PAD.bottom,
  };
  return {
    systemId: sys.id, index, origin: [ox, oy], bounds, trunkY: trunkY + oy,
    terminus: { x: ox + termX, y: oy + trunkY, r: R },
    titleAt: [ox, oy - 40],
    lines,
  };
}

function place(systems: readonly SystemInput[], probes: Box[], wrap: number): PipeLayout {
  const clusters: ClusterLayout[] = [];
  let x = 0, y = 0, rowH = 0;
  systems.forEach((sys, i) => {
    const probe = probes[i];
    const bw = probe.x1 - probe.x0, bh = probe.y1 - probe.y0;
    if (x > 0 && x + bw > wrap) { x = 0; y += rowH + CLUSTER_GAP; rowH = 0; }
    clusters.push(buildCluster(sys, i, x - probe.x0, y - probe.y0));
    x += bw + CLUSTER_GAP;
    rowH = Math.max(rowH, bh);
  });
  let minRowPitch = Infinity;
  for (const c of clusters) for (let i = 1; i < c.lines.length; i++) minRowPitch = Math.min(minRowPitch, c.lines[i].rowY - c.lines[i - 1].rowY);
  return { clusters, bounds: unionBox(clusters.map((c) => c.bounds)), minRowPitch };
}

/** What the grid is shaped for: a number is a bare width/height ratio (no padding); a size is the measured pane in px. */
export type LayoutView = number | { w: number; h: number; pad?: number };

/**
 * Lays out every system as a cluster on one canvas, as a wrapping grid. The wrap width is chosen (from the widths
 * a row could reach) to maximize the fit-all scale in the viewport: min((w - 2 pad) / width, (h - 2 pad) / height),
 * i.e. exactly what fitCam will use, so the map fills the pane instead of leaving empty margins.
 */
export function computeLayout(systems: readonly SystemInput[], view: LayoutView = TARGET_ASPECT): PipeLayout {
  const { w, h, pad } = typeof view === "number" ? { w: view, h: 1, pad: 0 } : { pad: FIT_PAD, ...view };
  const aw = Math.max(1, w - pad * 2), ah = Math.max(1, h - pad * 2);
  const probes = systems.map((s, i) => buildCluster(s, i, 0, 0).bounds);
  const widths = probes.map((b) => b.x1 - b.x0);
  const candidates = new Set<number>();
  let run = 0;
  widths.forEach((bw, i) => { run += bw + (i > 0 ? CLUSTER_GAP : 0); candidates.add(run); });
  let best: PipeLayout | null = null;
  let bestScale = -Infinity;
  for (const wrap of candidates) {
    const lay = place(systems, probes, wrap);
    const bw = lay.bounds.x1 - lay.bounds.x0, bh = lay.bounds.y1 - lay.bounds.y0;
    const scale = Math.min(aw / Math.max(1, bw), ah / Math.max(1, bh));
    if (scale > bestScale + 1e-12) { best = lay; bestScale = scale; }
  }
  return best ?? { clusters: [], bounds: { x0: 0, y0: 0, x1: 0, y1: 0 }, minRowPitch: Infinity };
}

/** Stable key of everything the layout depends on, to know when the camera should refit. */
export function layoutKey(systems: readonly SystemInput[]): string {
  return systems.map((s) => `${s.id}:${s.facilities.map((f) => `${f.id}/${f.wellIds.length}`).join(",")}`).join("|");
}
