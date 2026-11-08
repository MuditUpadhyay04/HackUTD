"use client";

import { useId } from "react";
import type { FacilityState, Snapshot } from "@/lib/engine/types";

export type Limits = Snapshot["limits"];
export type TankTone = "water" | "warn" | "crit" | "idle";

/** A slim tank: real water level, the warning tick and the shutdown line. */
export function TankGlyph({
  level,
  tone,
  limits,
  height = 76,
  width = 30,
}: {
  level: number;
  tone: TankTone;
  limits: Limits;
  height?: number;
  width?: number;
}) {
  const id = `tank${useId().replace(/:/g, "")}`;
  const inset = 2;
  const innerH = height - inset * 2;
  const y = (pct: number) => inset + innerH * (1 - Math.min(100, Math.max(0, Number.isFinite(pct) ? pct : 0)) / 100);
  const fill =
    tone === "crit" ? "var(--crit)" : tone === "warn" ? "var(--warn-fill)" : tone === "idle" ? "var(--faint)" : "var(--water)";
  const r = Math.min(8, width / 3);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden className="shrink-0">
      <defs>
        <clipPath id={id}>
          <rect x={inset} y={inset} width={width - inset * 2} height={innerH} rx={r - 1} />
        </clipPath>
      </defs>
      <rect x={inset} y={inset} width={width - inset * 2} height={innerH} rx={r - 1} fill="var(--line-soft)" />
      <rect
        x={inset}
        y={y(level)}
        width={width - inset * 2}
        height={height - inset - y(level)}
        fill={fill}
        clipPath={`url(#${id})`}
      />
      <line x1={inset} x2={width - inset} y1={y(limits.warningPct)} y2={y(limits.warningPct)} stroke="var(--warn-fill)" strokeWidth={1} strokeDasharray="2 2" />
      <line x1={0} x2={width} y1={y(limits.shutdownPct)} y2={y(limits.shutdownPct)} stroke="var(--crit)" strokeWidth={1.5} />
      <rect x={inset} y={inset} width={width - inset * 2} height={innerH} rx={r - 1} fill="none" stroke="var(--line)" />
    </svg>
  );
}

export function toneFor(f: FacilityState, limits: Limits): TankTone {
  if (f.health === "shut_in" || f.health === "no_data") return "idle";
  if (f.health === "failure") return f.tank.levelPct >= limits.warningPct ? "crit" : "warn";
  if (f.tank.levelPct >= limits.shutdownPct) return "crit";
  if (f.tank.levelPct >= limits.warningPct) return "warn";
  return "water";
}
