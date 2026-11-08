// Packet layer: one canvas over the SVG. Packets are the only infinite motion (linear, continuous).
// Speed and density scale with flow. Reduced motion: static arrowheads at density proportional to flow, no loop.
import { along } from './layout.js';
import { reduced } from './dither.js';

export function createPackets(canvas, cam) {
  const ctx = canvas.getContext('2d');
  const lines = new Map(); // fid -> { geo, st, phaseUp, phaseDn }
  let last = 0, running = false, ready = false, W = 0, H = 0;
  const dpr = () => Math.min(2, devicePixelRatio || 1);

  function resize() {
    const r = canvas.getBoundingClientRect();
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr()); canvas.height = Math.round(H * dpr());
    draw(0);
  }
  function add(fid, geo) { lines.set(fid, { geo, st: null, pu: Math.random() * 100, pd: Math.random() * 100 }); }
  function set(fid, st) { const l = lines.get(fid); if (l) l.st = st; }
  function ratio(v, max) { return Math.max(0, Math.min(1, (v || 0) / (max || 1))); }

  function rail(l, kind, pts, cum, phase, speedMul, spacing, color, t, leakS) {
    const total = cum[cum.length - 1], sp = Math.max(10, spacing);
    for (let k = 0, s = phase % sp; s < total; s += sp, k++) {
      const p = along(pts, cum, s);
      let x = p.x, y = p.y, a = 1;
      if (leakS != null && k % 3 === 0 && s > leakS) {
        const d = Math.min(70, s - leakS);
        x -= Math.sin(p.ang) * d * 0.45; y += Math.cos(p.ang) * d * 0.45; a = 1 - d / 90;
        if (s - leakS > 70) continue;
      }
      const sx = cam.x + x * cam.z, sy = cam.y + y * cam.z;
      if (sx < -8 || sy < -8 || sx > W + 8 || sy > H + 8) continue;
      ctx.globalAlpha = a; ctx.fillStyle = color;
      ctx.fillRect(sx - 1.5, sy - 1.5, 3, 3);
      ctx.globalAlpha = a * 0.35;
      ctx.fillRect(sx - 1.5 - Math.cos(p.ang) * 4, sy - 1.5 - Math.sin(p.ang) * 4, 3, 3);
    }
    ctx.globalAlpha = 1;
  }
  function arrows(pts, cum, spacing, color) {
    const total = cum[cum.length - 1];
    ctx.fillStyle = color;
    for (let s = spacing / 2; s < total; s += spacing) {
      const p = along(pts, cum, s), sx = cam.x + p.x * cam.z, sy = cam.y + p.y * cam.z;
      ctx.save(); ctx.translate(sx, sy); ctx.rotate(p.ang);
      ctx.beginPath(); ctx.moveTo(3, 0); ctx.lineTo(-2.5, -3); ctx.lineTo(-2.5, 3); ctx.fill(); ctx.restore();
    }
  }
  function draw(dt) {
    ctx.setTransform(dpr(), 0, 0, dpr(), 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!ready) return;
    const t = performance.now() / 1000, still = reduced();
    for (const l of lines.values()) {
      const st = l.st, g = l.geo;
      if (!st || st.kind === 'nodata') continue;
      const rDn = ratio(st.flow, st.maxFlow), rUp = ratio(st.inflow, st.maxFlow);
      let mulDn = 1;
      if (st.kind === 'worn') mulDn = 0.55 + 0.25 * Math.sin(t * 6.5) * Math.sin(t * 2.3);
      const spDn = 46 - 30 * rDn, spUp = 44 - 14 * rUp;
      const upOn = st.kind !== 'shutin' && st.inflow > 0, dnOn = st.flow > 50 && st.kind !== 'down' && st.kind !== 'shutin';
      if (!still) {
        l.pd += dt * (18 + 62 * rDn) * mulDn; l.pu += dt * (12 + 34 * rUp);
        if (upOn) rail(l, st.kind, g.up, g.upCum, l.pu, 1, spUp, g.color, t, null);
        if (dnOn) rail(l, st.kind, g.dn, g.dnCum, l.pd, mulDn, spDn, g.color, t, st.kind === 'leak' ? g.leakS : null);
      } else {
        if (upOn) arrows(g.up, g.upCum, spUp * 1.6, g.color);
        if (dnOn) arrows(g.dn, g.dnCum, spDn * 1.6, g.color);
      }
    }
  }
  function frame(now) {
    if (!running) return;
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (!document.hidden) draw(dt); // pause all infinite motion when hidden
    requestAnimationFrame(frame);
  }
  function start() {
    ready = true;
    if (reduced()) { draw(0); return; }
    if (running) return;
    running = true; last = performance.now(); requestAnimationFrame(frame);
  }
  new ResizeObserver(resize).observe(canvas);
  document.addEventListener('visibilitychange', () => { last = performance.now(); });
  return { add, set, start, redraw: () => draw(0), resize };
}
