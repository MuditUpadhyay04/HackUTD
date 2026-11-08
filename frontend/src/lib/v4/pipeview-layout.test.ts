import { describe, expect, test } from "bun:test";
import { ARC_RADIUS, computeLayout, layoutKey, polyLength, roundCorners, type Box, type Pt, type SystemInput } from "./pipeview-layout";
import { labelBoxes, pillTier, shortPill } from "./pipeview-labels";
import { dotSpacing, fitCam, zoomAt } from "./pipeview-camera";

const sys = (id: string, nf: number, nw: number): SystemInput => ({
  id, facilities: Array.from({ length: nf }, (_, i) => ({ id: `${id}_F${i}`, wellIds: Array.from({ length: nw }, (_, j) => `${id}_F${i}_W${j}`) })),
});

const allPaths = (l: ReturnType<typeof computeLayout>): Pt[][] =>
  l.clusters.flatMap((c) => c.lines.flatMap((x) => [x.up, x.pipe, x.down, x.full, ...x.wells.map((w) => w.path)]));

const overlap = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

function cross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(a, b, c), d2 = o(a, b, d), d3 = o(c, d, a), d4 = o(c, d, b);
  return d1 * d2 < 0 && d3 * d4 < 0; // proper crossing only (shared endpoints and collinear touches are fine)
}

describe("computeLayout angles and arcs", () => {
  const heading = (a: Pt, b: Pt) => Math.atan2(b[1] - a[1], b[0] - a[0]);
  test("bends are smooth arcs: no zero-length chord, no heading jump above one arc step, headings stay within 45 degrees of the flow", () => {
    for (const n of [1, 2, 3, 8, 17, 32]) {
      for (const nw of [0, 1, 2, 5, 8]) {
        const l = computeLayout([sys("S1", n, nw), sys("S2", Math.max(1, n - 1), nw)]);
        for (const path of allPaths(l)) {
          for (let i = 1; i < path.length; i++) {
            const dx = path[i][0] - path[i - 1][0], dy = path[i][1] - path[i - 1][1];
            expect(Math.hypot(dx, dy)).toBeGreaterThan(0);
            expect(Math.abs(Math.atan2(dy, dx))).toBeLessThanOrEqual(Math.PI / 4 + 1e-6);
            if (i > 1) {
              let d = heading(path[i - 1], path[i]) - heading(path[i - 2], path[i - 1]);
              d = Math.atan2(Math.sin(d), Math.cos(d));
              expect(Math.abs(d)).toBeLessThanOrEqual(Math.PI / 4 / 3 + 1e-6); // a sampled 45 degree arc turns in at least 3 steps
            }
          }
        }
      }
    }
  });
  test("long straight runs stay exactly horizontal or on a 45 degree diagonal", () => {
    const l = computeLayout([sys("S1", 9, 6)]);
    for (const path of allPaths(l)) for (let i = 1; i < path.length; i++) {
      const dx = Math.abs(path[i][0] - path[i - 1][0]), dy = Math.abs(path[i][1] - path[i - 1][1]);
      if (Math.hypot(dx, dy) > 20) expect(dy < 1e-6 || Math.abs(dx - dy) < 1e-6).toBe(true);
    }
  });
  test("roundCorners keeps endpoints, cuts the corner inside the hull and rounds with about the requested radius", () => {
    const r = roundCorners([[0, 0], [100, 0], [200, 100]], ARC_RADIUS);
    expect(r[0]).toEqual([0, 0]);
    expect(r[r.length - 1]).toEqual([200, 100]);
    expect(r.length).toBeGreaterThan(3);
    for (const p of r) expect(p[1]).toBeGreaterThanOrEqual(Math.max(0, p[0] - 100) - 1e-6); // inside the corner
    expect(polyLength(r)).toBeLessThan(100 + Math.hypot(100, 100));
    expect(roundCorners([[0, 0], [10, 0]])).toEqual([[0, 0], [10, 0]]);
  });
});

describe("computeLayout structure", () => {
  test("works for 1..32 facilities with 8 wells and keeps every point in its cluster bounds", () => {
    for (let n = 1; n <= 32; n++) {
      const l = computeLayout([sys("S1", n, 8)]);
      const c = l.clusters[0];
      expect(c.lines.length).toBe(n);
      const b = c.bounds;
      for (const line of c.lines) for (const path of [line.full, ...line.wells.map((w) => w.path)]) for (const p of path) {
        expect(p[0]).toBeGreaterThanOrEqual(b.x0); expect(p[0]).toBeLessThanOrEqual(b.x1);
        expect(p[1]).toBeGreaterThanOrEqual(b.y0); expect(p[1]).toBeLessThanOrEqual(b.y1);
      }
      expect(c.terminus.x + c.terminus.r).toBeLessThanOrEqual(b.x1);
      expect(c.terminus.y + c.terminus.r).toBeLessThanOrEqual(b.y1);
    }
  });

  test("lines of one system never cross, including the well fans", () => {
    for (const n of [2, 5, 9, 32]) {
      const c = computeLayout([sys("S1", n, 6)]).clusters[0];
      const segs: { f: number; a: Pt; b: Pt }[] = [];
      c.lines.forEach((line, f) => {
        for (const path of [line.full, ...line.wells.map((w) => w.path)]) for (let i = 1; i < path.length; i++) segs.push({ f, a: path[i - 1], b: path[i] });
      });
      for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
        if (segs[i].f === segs[j].f) continue;
        expect(cross(segs[i].a, segs[i].b, segs[j].a, segs[j].b)).toBe(false);
      }
    }
  });

  test("clusters of different systems never overlap, for many systems of mixed sizes", () => {
    const systems = [sys("S1", 32, 8), sys("S2", 1, 1), sys("S3", 5, 3), sys("S4", 12, 8), sys("S5", 3, 0), sys("S6", 7, 2), sys("S7", 2, 8), sys("S8", 20, 4), sys("S9", 1, 8), sys("S10", 9, 5)];
    const l = computeLayout(systems);
    expect(l.clusters.length).toBe(systems.length);
    for (let i = 0; i < l.clusters.length; i++) for (let j = i + 1; j < l.clusters.length; j++) {
      expect(overlap(l.clusters[i].bounds, l.clusters[j].bounds)).toBe(false);
    }
  });

  test("preserves network order and handles empty input", () => {
    const l = computeLayout([sys("B", 2, 1), sys("A", 3, 1)]);
    expect(l.clusters.map((c) => c.systemId)).toEqual(["B", "A"]);
    expect(l.clusters[1].lines.map((x) => x.index)).toEqual([0, 1, 2]);
    expect(computeLayout([]).clusters).toEqual([]);
    expect(computeLayout([sys("S1", 0, 0)]).clusters[0].lines).toEqual([]);
  });

  test("many systems wrap into a grid rather than one long row", () => {
    const systems = Array.from({ length: 12 }, (_, i) => sys(`S${i}`, 4, 3));
    const l = computeLayout(systems);
    const ys = new Set(l.clusters.map((c) => Math.round(c.origin[1])));
    expect(ys.size).toBeGreaterThan(1);
  });

  test("leak point lies on the pipeline segment", () => {
    const line = computeLayout([sys("S1", 3, 2)]).clusters[0].lines[1];
    expect(line.leakS).toBeGreaterThan(0);
    expect(line.leakS).toBeLessThan(polyLength(line.pipe) + 20);
  });

  test("layoutKey changes with order, ids and well counts", () => {
    expect(layoutKey([sys("S1", 2, 2)])).not.toBe(layoutKey([sys("S1", 2, 3)]));
    expect(layoutKey([sys("S1", 2, 2), sys("S2", 1, 1)])).not.toBe(layoutKey([sys("S2", 1, 1), sys("S1", 2, 2)]));
  });
});

describe("camera", () => {
  test("zoomAt keeps the point under the cursor fixed", () => {
    const c = { x: 40, y: -20, z: 1 };
    const n = zoomAt(c, 2, 300, 200);
    expect((300 - c.x) / c.z).toBeCloseTo((300 - n.x) / n.z);
    expect((200 - c.y) / c.z).toBeCloseTo((200 - n.y) / n.z);
  });
  test("fitCam centers the content with padding", () => {
    const box = { x0: 0, y0: 0, x1: 1000, y1: 400 };
    const c = fitCam(box, 1000, 500, 32);
    expect(c.z).toBeCloseTo((1000 - 64) / 1000);
    expect(c.x + box.x0 * c.z).toBeCloseTo(32);
    expect(c.y + 200 * c.z).toBeCloseTo(250);
  });
  test("dot spacing stays between 22 and 44 px on screen", () => {
    for (const z of [0.04, 0.1, 0.33, 1, 2.5, 6]) {
      const px = dotSpacing(z) * z;
      expect(px).toBeGreaterThanOrEqual(22 - 1e-9);
      expect(px).toBeLessThan(44 + 1e-9);
    }
  });
});

describe("label lanes", () => {
  const five = computeLayout([sys("S5", 5, 2)]);
  const lines = five.clusters[0].lines;
  const texts = ["Pump down 03:28", "Pump down 02:03", "Inspect 120 bbl/d", "Pump down, unknown", "Inspect pump"];
  test("for a 5-facility system, pills and id labels never intersect each other at any zoom (tier picked from the pitch)", () => {
    for (const z of [0.15, 0.2, 0.3, 0.4, 0.5, 0.7, 1, 1.6]) {
      const tier = pillTier(five.minRowPitch * z);
      const boxes = lines.map((l, i) => labelBoxes(l, z, texts[i], tier));
      const all = boxes.flatMap((b, i) => [b.id && { k: `id${i}`, b: b.id }, b.pill && { k: `pill${i}`, b: b.pill }]).filter((x): x is { k: string; b: Box } => !!x);
      for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
        expect(overlap(all[i].b, all[j].b)).toBe(false);
      }
    }
  });
  test("each pill sits to the right of its own pump station, on its own row", () => {
    const z = 0.6;
    lines.forEach((l, i) => {
      const { pill } = labelBoxes(l, z, texts[i], "full");
      expect(pill!.x0).toBeGreaterThan(l.pump[0] * z);
      expect((pill!.y0 + pill!.y1) / 2).toBeCloseTo(l.rowY * z);
    });
  });
  test("tiers shrink as rows get tighter and the short form keeps the state word", () => {
    expect(pillTier(72)).toBe("full");
    expect(pillTier(34)).toBe("short");
    expect(pillTier(22)).toBe("mini");
    expect(pillTier(10)).toBe("none");
    expect(shortPill("Pump down 03:28")).toBe("Down 03:28");
    expect(shortPill("Inspect 120 bbl/d").length).toBeLessThan("Inspect 120 bbl/d".length);
  });
  test("the grid wrap maximizes the padded fit scale for the measured pane", () => {
    const systems = Array.from({ length: 5 }, (_, i) => sys(`S${i + 1}`, 3, 2));
    const scaleOf = (l: ReturnType<typeof computeLayout>, w: number, h: number) =>
      Math.min((w - 64) / (l.bounds.x1 - l.bounds.x0), (h - 64) / (l.bounds.y1 - l.bounds.y0));
    for (const [w, h] of [[1350, 380], [900, 700], [400, 800]] as const) {
      const best = scaleOf(computeLayout(systems, { w, h }), w, h);
      for (const other of [[1350, 380], [900, 700], [400, 800], [3000, 200]] as const) {
        expect(best).toBeGreaterThanOrEqual(scaleOf(computeLayout(systems, { w: other[0], h: other[1] }), w, h) - 1e-9);
      }
    }
  });
});
