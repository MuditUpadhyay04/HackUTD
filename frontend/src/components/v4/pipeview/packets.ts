// Packet layer: ONE canvas above the SVG. Packets are the only infinite motion (linear, continuous). Speed and
// density scale with pump flow. Independent of React renders: LineView pushes state with setState(), the loop reads it.
// Reduced motion: no loop, static arrowheads at density proportional to flow. Paused while the tab is hidden.
import { along, cumulative, type Pt } from "@/lib/v4/pipeview-layout";
import type { Cam } from "@/lib/v4/pipeview-camera";
import type { Motion } from "@/lib/v4/pipeview-model";

export interface PacketLine {
  id: string;
  color: string;
  up: Pt[];
  down: Pt[];
  leakS: number;
}
export interface PacketState { motion: Motion; flowRatio: number; inflowRatio: number; inflowOn: boolean }

interface Rail { id: string; color: string; up: Pt[]; upCum: number[]; down: Pt[]; downCum: number[]; leakS: number; pu: number; pd: number }

export const MAX_PACKETS = 1400;

export class PacketEngine {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private rails: Rail[] = [];
  private states = new Map<string, PacketState>();
  private raf = 0;
  private last = 0;
  private w = 0;
  private h = 0;
  private ready = false;
  private reduced = false;
  private getCam: () => Cam = () => ({ x: 0, y: 0, z: 1 });
  private onVis = () => { if (document.hidden) this.halt(); else this.kick(); };

  attach(canvas: HTMLCanvasElement, getCam: () => Cam, reduced: boolean) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.getCam = getCam;
    this.reduced = reduced;
    document.addEventListener("visibilitychange", this.onVis);
  }
  detach() {
    this.halt();
    document.removeEventListener("visibilitychange", this.onVis);
    this.canvas = null; this.ctx = null; this.ready = false;
  }
  setReduced(reduced: boolean) { this.reduced = reduced; if (this.ready) this.kick(); }
  setLines(lines: PacketLine[]) {
    const prev = new Map(this.rails.map((r) => [r.id, r]));
    this.rails = lines.map((l) => ({
      id: l.id, color: l.color, up: l.up, upCum: cumulative(l.up), down: l.down, downCum: cumulative(l.down), leakS: l.leakS,
      pu: prev.get(l.id)?.pu ?? Math.random() * 100, pd: prev.get(l.id)?.pd ?? Math.random() * 100,
    }));
  }
  setState(id: string, st: PacketState) { this.states.set(id, st); if (this.reduced || !this.raf) this.draw(0); }
  resize(w: number, h: number, dpr: number) {
    if (!this.canvas) return;
    this.w = w; this.h = h;
    this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    this.dpr = dpr;
    this.draw(0);
  }
  private dpr = 1;
  /** Packets begin (after the first-load draw-in). */
  start() { this.ready = true; this.kick(); }
  redraw() { if (!this.raf) this.draw(0); }

  private kick() {
    if (!this.ready) return;
    if (this.reduced) { this.halt(); this.draw(0); return; }
    if (this.raf || document.hidden) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }
  private halt() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; }
  private frame = (now: number) => {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.draw(dt);
    this.raf = requestAnimationFrame(this.frame);
  };

  /** Spacing multiplier that keeps the total packet count under MAX_PACKETS. */
  private budget(): number {
    let est = 0;
    for (const r of this.rails) {
      const st = this.states.get(r.id);
      if (!st || st.motion === "none") continue;
      est += r.downCum[r.downCum.length - 1] / this.spacing(st.flowRatio);
      if (st.inflowOn) est += r.upCum[r.upCum.length - 1] / this.spacingUp(st.inflowRatio);
    }
    return est > MAX_PACKETS ? est / MAX_PACKETS : 1;
  }
  private spacing(r: number) { return 46 - 30 * r; }
  private spacingUp(r: number) { return 44 - 14 * r; }

  private draw(dt: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    if (!this.ready) return;
    const cam = this.getCam();
    const time = performance.now() / 1000;
    const mul = this.budget();
    for (const r of this.rails) {
      const st = this.states.get(r.id);
      if (!st || st.motion === "none") continue;
      const worn = st.motion === "worn" ? 0.55 + 0.25 * Math.sin(time * 6.5) * Math.sin(time * 2.3) : 1;
      const spDn = this.spacing(st.flowRatio) * mul, spUp = this.spacingUp(st.inflowRatio) * mul;
      if (this.reduced) {
        this.arrows(ctx, cam, r.down, r.downCum, spDn * 1.6, r.color);
        if (st.inflowOn) this.arrows(ctx, cam, r.up, r.upCum, spUp * 1.6, r.color);
        continue;
      }
      r.pd += dt * (18 + 62 * st.flowRatio) * worn;
      r.pu += dt * (12 + 34 * st.inflowRatio);
      this.rail(ctx, cam, r.down, r.downCum, r.pd, spDn, r.color, st.motion === "leak" ? r.leakS : null);
      if (st.inflowOn) this.rail(ctx, cam, r.up, r.upCum, r.pu, spUp, r.color, null);
    }
  }

  private rail(ctx: CanvasRenderingContext2D, cam: Cam, pts: Pt[], cum: number[], phase: number, spacing: number, color: string, leakS: number | null) {
    const total = cum[cum.length - 1];
    const sp = Math.max(10, spacing);
    for (let k = 0, s = phase % sp; s < total; s += sp, k++) {
      const p = along(pts, cum, s);
      let x = p.x, y = p.y, a = 1;
      if (leakS != null && k % 3 === 0 && s > leakS) {
        const d = s - leakS;
        if (d > 70) continue; // a few packets drift off the line at the leak point and fade
        x -= Math.sin(p.ang) * d * 0.45; y += Math.cos(p.ang) * d * 0.45; a = 1 - d / 90;
      }
      const sx = cam.x + x * cam.z, sy = cam.y + y * cam.z;
      if (sx < -8 || sy < -8 || sx > this.w + 8 || sy > this.h + 8) continue;
      ctx.globalAlpha = a * 0.6;
      ctx.fillStyle = color;
      ctx.fillRect(sx - 2 - Math.cos(p.ang) * 5, sy - 2 - Math.sin(p.ang) * 5, 4, 4);
      ctx.globalAlpha = a;
      ctx.fillStyle = "#F3EEE7"; // warm white head so packets read on top of their own neon line
      ctx.fillRect(sx - 1.5, sy - 1.5, 3, 3);
    }
    ctx.globalAlpha = 1;
  }

  private arrows(ctx: CanvasRenderingContext2D, cam: Cam, pts: Pt[], cum: number[], spacing: number, color: string) {
    const total = cum[cum.length - 1];
    const sp = Math.max(14, spacing);
    ctx.fillStyle = color;
    for (let s = sp / 2; s < total; s += sp) {
      const p = along(pts, cum, s);
      const sx = cam.x + p.x * cam.z, sy = cam.y + p.y * cam.z;
      if (sx < -8 || sy < -8 || sx > this.w + 8 || sy > this.h + 8) continue;
      ctx.save();
      ctx.translate(sx, sy); ctx.rotate(p.ang);
      ctx.beginPath(); ctx.moveTo(3, 0); ctx.lineTo(-2.5, -3); ctx.lineTo(-2.5, 3); ctx.fill();
      ctx.restore();
    }
  }
}
