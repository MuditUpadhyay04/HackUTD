"use client";

import type { PlanOption, Series } from "@/lib/engine/types";
import { clock, dayClock } from "@/lib/format";

/**
 * Tank level over time: the recorded history (solid) and, optionally, where it goes
 * next under each plan (dashed for "do nothing", solid water-blue for the recommended plan).
 */
export function LevelChart({
  history,
  nowUnix,
  limits,
  projections = [],
  height = 220,
}: {
  history: Series;
  nowUnix: number;
  limits: { warningPct: number; shutdownPct: number };
  projections?: { option: PlanOption; emphasis: "recommended" | "baseline" }[];
  height?: number;
}) {
  const width = 640;
  const padL = 36;
  const padR = 12;
  const padT = 10;
  const padB = 24;

  const projEnd = projections.reduce(
    (m, p) => Math.max(m, ...p.option.levelCurve.map((c) => nowUnix + c.min * 60)),
    nowUnix,
  );
  // With a forecast, keep the past short so the future gets room on the axis.
  const window = projections.length ? 10 * 3600 : Infinity;
  const keep = history.t.map((t, i) => [t, history.v[i]] as [number, number]).filter(([t, v]) => t >= nowUnix - window && Number.isFinite(v));
  const t0 = keep[0]?.[0] ?? nowUnix - 86400;
  const t1 = Math.max(projEnd, nowUnix + 60 * 60);
  const x = (t: number) => padL + ((t - t0) / (t1 - t0)) * (width - padL - padR);
  const y = (pct: number) => padT + (1 - pct / 100) * (height - padT - padB);

  const path = (pts: [number, number][]) =>
    pts.map(([a, b], i) => `${i ? "L" : "M"}${x(a).toFixed(1)},${y(b).toFixed(1)}`).join("");

  const hist = path(keep);
  const ticks: number[] = [];
  const step = (t1 - t0) / 3600 > 20 ? 6 * 3600 : 2 * 3600;
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) ticks.push(t);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img" aria-label="Tank level over time">
      {[0, 50, 100].map((p) => (
        <g key={p}>
          <line x1={padL} x2={width - padR} y1={y(p)} y2={y(p)} stroke="var(--line-soft)" />
          <text x={padL - 8} y={y(p) + 4} textAnchor="end" className="fill-[var(--faint)] text-[11px]">
            {p}%
          </text>
        </g>
      ))}
      <line x1={padL} x2={width - padR} y1={y(limits.warningPct)} y2={y(limits.warningPct)} stroke="var(--warn)" strokeOpacity={0.5} strokeDasharray="4 4" />
      <line x1={padL} x2={width - padR} y1={y(limits.shutdownPct)} y2={y(limits.shutdownPct)} stroke="var(--crit)" strokeOpacity={0.75} />
      <text x={padL + 6} y={y(limits.shutdownPct) - 5} className="fill-[var(--crit)] text-[11px]">
        Shutdown {limits.shutdownPct}%
      </text>

      {ticks.map((t) => (
        <text
          key={t}
          x={x(t)}
          y={height - 6}
          textAnchor={x(t) > width - padR - 20 ? "end" : x(t) < padL + 20 ? "start" : "middle"}
          className="fill-[var(--faint)] text-[11px]"
        >
          {/* Midnight ticks carry the weekday so two 00:00 labels can be told apart. */}
          {t % 86400 === 0 ? dayClock(t) : clock(t)}
        </text>
      ))}

      <rect x={x(nowUnix)} y={padT} width={Math.max(0, width - padR - x(nowUnix))} height={height - padT - padB} fill="var(--raised)" opacity={0.45} />
      <line x1={x(nowUnix)} x2={x(nowUnix)} y1={padT} y2={height - padB} stroke="var(--muted)" strokeOpacity={0.6} />
      <text
        x={x(nowUnix) + (x(nowUnix) > width - 60 ? -6 : 6)}
        y={height - padB - 6}
        textAnchor={x(nowUnix) > width - 60 ? "end" : "start"}
        className="fill-[var(--muted)] text-[11px]"
      >
        Now
      </text>

      <path d={hist} fill="none" stroke="var(--text)" strokeOpacity={0.85} strokeWidth={1.6} />

      {projections.map(({ option, emphasis }) => {
        const d = path(option.levelCurve.map((c) => [nowUnix + c.min * 60, c.pct]));
        return (
          <g key={option.label}>
            <path
              d={d}
              fill="none"
              stroke={emphasis === "recommended" ? "var(--water)" : "var(--crit)"}
              strokeWidth={emphasis === "recommended" ? 2.2 : 1.6}
              strokeDasharray={emphasis === "baseline" ? "5 5" : undefined}
              strokeOpacity={emphasis === "baseline" ? 0.8 : 1}
            />
            {emphasis === "recommended" &&
              option.truckArrivalsMin.map((m, i) => {
                const pt = option.levelCurve.reduce((best, c) =>
                  Math.abs(c.min - m) < Math.abs(best.min - m) ? c : best,
                );
                return (
                  <g key={i} transform={`translate(${x(nowUnix + m * 60)},${y(pt.pct)})`}>
                    <circle r={5} fill="var(--ink)" stroke="var(--water)" strokeWidth={2} />
                  </g>
                );
              })}
          </g>
        );
      })}
    </svg>
  );
}
