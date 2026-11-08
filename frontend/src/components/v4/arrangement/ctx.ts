"use client";
import { createContext, useContext } from "react";
import type { Snapshot } from "@/lib/engine/types";
import type { Bounds, View } from "@/lib/v4/arrangement-scale";
import { timeToX } from "@/lib/v4/arrangement-scale";

export interface ArrCtx {
  snapshot: Snapshot;
  view: View;
  /** Width in px of the lane area (everything right of the header column). */
  width: number;
  domain: Bounds;
  window: { start: number; end: number };
}

export const ArrContext = createContext<ArrCtx | null>(null);

export function useArr(): ArrCtx {
  const c = useContext(ArrContext);
  if (!c) throw new Error("useArr outside Arrangement");
  return c;
}

/** SVG viewBox for a lane: x in seconds since domain.start across the visible view, y 0..100. */
export function laneViewBox(c: ArrCtx): string {
  return `${c.view.t0 - c.domain.start} 0 ${Math.max(1, c.view.t1 - c.view.t0)} 100`;
}

export const xOf = (c: ArrCtx, t: number) => timeToX(c.view, c.width, t);
