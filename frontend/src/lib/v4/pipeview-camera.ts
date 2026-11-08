// Pan/zoom camera math (world to screen: screen = world * z + (x, y)). Pure.
import type { Box } from "./pipeview-layout";

export interface Cam { x: number; y: number; z: number }
export const Z_MIN = 0.04;
export const Z_MAX = 6;
export const FIT_MAX = 1.6;
export const FIT_PAD = 32;

export const clampZ = (z: number) => Math.min(Z_MAX, Math.max(Z_MIN, z));

/** Zoom by factor f keeping the world point under screen (cx, cy) fixed. */
export function zoomAt(cam: Cam, f: number, cx: number, cy: number): Cam {
  const z = clampZ(cam.z * f);
  const k = z / cam.z;
  return { x: cx - (cx - cam.x) * k, y: cy - (cy - cam.y) * k, z };
}

/** Camera that fits the content box in a viewport with `pad` px on every side (content bounds, centered). */
export function fitCam(box: Box, w: number, h: number, pad = FIT_PAD): Cam {
  const bw = Math.max(1, box.x1 - box.x0), bh = Math.max(1, box.y1 - box.y0);
  const z = Math.min(FIT_MAX, clampZ(Math.min(Math.max(1, w - pad * 2) / bw, Math.max(1, h - pad * 2) / bh)));
  return { z, x: (w - bw * z) / 2 - box.x0 * z, y: (h - bh * z) / 2 - box.y0 * z };
}

/** World spacing of the dot grid: a power of two multiple of 28 so dots stay 22..44 px apart on screen. */
export function dotSpacing(z: number): number {
  const base = 28;
  const k = Math.ceil(Math.log2(22 / (base * z)));
  return base * 2 ** k;
}

/** Label detail level by zoom. */
export function lodAt(z: number): "far" | "mid" | "near" {
  return z < 0.18 ? "far" : z < 0.55 ? "mid" : "near";
}
