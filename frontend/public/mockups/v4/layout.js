// Metro layout computed from the data only (hard rule 2): facility count, well count and order come from the Snapshot.
// All segments are horizontal, vertical, or 45 degrees. Units are world units; labels counter-scale on screen.
export const X = { well: 0, bend: 36, tank: 150, pump: 225, pipe0: 247, pipe1: 380 };
const LANE = 11, GAP = 140, WRAP = 2600;

const len = (pts) => pts.reduce((a, p, i) => (i ? a + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);
export function cumulative(pts) {
  const c = [0];
  for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return c;
}
/** Point and heading at distance s along a polyline. */
export function along(pts, cum, s) {
  s = Math.max(0, Math.min(cum[cum.length - 1], s));
  let i = 1;
  while (i < cum.length - 1 && cum[i] < s) i++;
  const f = (s - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1), a = pts[i - 1], b = pts[i];
  return { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, ang: Math.atan2(b[1] - a[1], b[0] - a[0]) };
}

function layoutCluster(sys, colorOf, ox, oy) {
  const n = sys.facilities.length;
  const hs = sys.facilities.map((f) => Math.max(72, f.wells.length * 18 + 26));
  const H = hs.reduce((a, b) => a + b, 0), trunkY = H / 2;
  let acc = 0;
  const facs = sys.facilities.map((fac, i) => {
    const y = acc + hs[i] / 2; acc += hs[i];
    const nw = fac.wells.length, maxdy = ((nw - 1) / 2) * 18, xs = X.bend + maxdy + 16;
    const wells = fac.wells.map((w, j) => {
      const wy = y + (j - (nw - 1) / 2) * 18, dy = y - wy;
      const pts = [[X.well, wy], [X.bend, wy]];
      if (dy !== 0) pts.push([X.bend + Math.abs(dy), y]);
      pts.push([xs, y]);
      return { id: w.id, x: X.well, y: wy, pts };
    });
    return { fac, color: colorOf(fac), rowY: y, xs, wells, h: hs[i], idx: i };
  });
  const spread = (n - 1) * LANE, R = Math.max(24, spread / 2 + 10);
  const maxdy = Math.max(...facs.map((f) => Math.abs(trunkY + (f.idx - (n - 1) / 2) * LANE - f.rowY)));
  const termX = X.pipe1 + maxdy + 100 + R;
  for (const f of facs) {
    const lane = trunkY + (f.idx - (n - 1) / 2) * LANE, dy = lane - f.rowY, ady = Math.abs(dy);
    const endx = termX - Math.sqrt(Math.max(0, R * R - (lane - trunkY) ** 2)) + 2;
    f.lane = lane;
    f.up = [[f.xs, f.rowY], [X.tank, f.rowY], [X.pump, f.rowY]];
    f.pipe = [[X.pump + 16, f.rowY], [X.pipe1, f.rowY]];
    f.dn = [[X.pump, f.rowY], [X.pipe1, f.rowY]];
    if (ady > 0) f.dn.push([X.pipe1 + ady, lane]);
    f.dn.push([endx, lane]);
    f.dnCum = cumulative(f.dn); f.upCum = cumulative(f.up);
    f.tank = { x: X.tank, y: f.rowY }; f.pumpAt = { x: X.pump, y: f.rowY };
    f.mid = { x: (X.pump + X.pipe1) / 2 + 8, y: f.rowY };
    // shift everything into world space
    const sh = (pts) => pts.forEach((p) => { p[0] += ox; p[1] += oy; });
    sh(f.up); sh(f.pipe); sh(f.dn); f.wells.forEach((w) => { sh(w.pts); w.x += ox; w.y += oy; });
    for (const k of ['tank', 'pumpAt', 'mid']) { f[k].x += ox; f[k].y += oy; }
    f.lane += oy; f.rowY += oy; f.xs += ox;
  }
  return { sys, ox, oy, w: termX + R + 30, h: H, trunkY: trunkY + oy, term: { x: ox + termX, y: oy + trunkY, r: R }, facs };
}

export function computeLayout(systems, colorOf) {
  const clusters = [];
  let x = 0, y = 0, rowH = 0;
  for (const sys of systems) {
    const probe = layoutCluster(sys, colorOf, 0, 0);
    if (x > 0 && x + probe.w > WRAP) { x = 0; y += rowH + 140; rowH = 0; }
    clusters.push(layoutCluster(sys, colorOf, x, y));
    x += probe.w + GAP; rowH = Math.max(rowH, probe.h);
  }
  const b = { x0: -20, y0: -50, x1: Math.max(...clusters.map((c) => c.ox + c.w)), y1: Math.max(...clusters.map((c) => c.oy + c.h)) + 30 };
  return { clusters, bounds: b };
}
