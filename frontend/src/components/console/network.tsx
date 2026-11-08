"use client";

import { useState } from "react";
import type { FacilityState, Incident, SystemState } from "@/lib/engine/types";
import { facilityName, num, systemNum } from "@/lib/format";
import { cn } from "@/lib/utils";

const ROW = 70; // px per facility row in the schematic
const W = 940;
const X = { wells: 34, tank: 156, pump: 240, pipeStart: 256, manifold: 700, disposal: 790 };

type Status = "flowing" | "idle" | "down" | "leak" | "worn" | "nodata" | "shut";

function pipeStatus(f: FacilityState): Status {
  if (f.health === "no_data") return "nodata";
  if (f.health === "failure") return "down";
  if (f.health === "shut_in") return "shut";
  if (f.health === "leak") return "leak";
  if (f.health === "degradation") return "worn";
  return f.pump.status === 1 && f.pump.flowBpd > 1 ? "flowing" : "idle";
}

const statusColor: Record<Status, string> = {
  flowing: "#0a84ff",
  idle: "rgba(60,60,67,0.28)",
  down: "#ff3b30",
  leak: "#ff9500",
  worn: "#ff9500",
  nodata: "#8e8e93",
  shut: "#8e8e93",
};

/** Default to the system that most needs attention. */
function pickSystem(systems: SystemState[], alerts: Incident[]) {
  return (
    systems.find((s) => alerts.some((a) => a.systemId === s.id && a.category === "pump_failure")) ??
    systems.find((s) => alerts.some((a) => a.systemId === s.id)) ??
    systems[0]
  );
}

export function NetworkCard({
  systems,
  alerts,
  onFacility,
}: {
  systems: SystemState[];
  alerts: Incident[];
  onFacility: (f: FacilityState) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const sys = systems.find((s) => s.id === picked) ?? pickSystem(systems, alerts);
  if (!sys) return null;

  const down = new Set(alerts.filter((a) => a.category === "pump_failure").map((a) => a.systemId));
  const attention = new Set(alerts.map((a) => a.systemId));
  const rows = sys.facilities;
  const h = Math.max(1, rows.length) * ROW + 24;
  const midY = (i: number) => 12 + i * ROW + ROW / 2;
  const maxFlow = Math.max(1, ...rows.map((f) => f.pump.maxFlowBpd));
  const totalIn = rows.reduce((t, f) => t + (Number.isFinite(f.pipeline.receiveFlowBpd) ? f.pipeline.receiveFlowBpd : 0), 0);
  const trunkY = h / 2;

  return (
    <div className="glass overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <div role="tablist" aria-label="System" className="inline-flex flex-wrap rounded-[9px] bg-[rgba(118,118,128,0.12)] p-0.5">
          {systems.map((s) => {
            const on = s.id === sys.id;
            return (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setPicked(s.id)}
                className={cn(
                  "flex items-center gap-1.5 rounded-[7px] px-3 py-1 text-[13px] whitespace-nowrap text-text transition-[background-color,box-shadow] duration-150",
                  on && "bg-white font-semibold shadow-[0_1px_2px_rgba(0,0,0,0.12),0_0_0_0.5px_rgba(0,0,0,0.04)]",
                )}
              >
                {attention.has(s.id) && (
                  <span className={cn("size-1.5 rounded-full", down.has(s.id) ? "bg-crit" : "bg-warn-fill")} aria-hidden />
                )}
                System {systemNum(s.id)}
                {attention.has(s.id) && <span className="sr-only">{down.has(s.id) ? ", pump down" : ", needs an inspector"}</span>}
              </button>
            );
          })}
        </div>
        <Legend />
      </div>

      <div className="overflow-x-auto px-2 py-2">
        <svg
          viewBox={`0 0 ${W} ${h}`}
          className="block h-auto w-full min-w-[680px]"
          role="img"
          aria-label={`Pipe flow for System ${systemNum(sys.id)}: ${rows.length} facilities pumping to ${sys.disposal.id}`}
        >
          {/* manifold + trunk to the disposal site */}
          {rows.length > 1 && (
            <line x1={X.manifold} x2={X.manifold} y1={midY(0)} y2={midY(rows.length - 1)} stroke="rgba(60,60,67,0.22)" strokeWidth={6} strokeLinecap="round" />
          )}
          <line x1={X.manifold} x2={X.disposal - 34} y1={trunkY} y2={trunkY} stroke={totalIn > 1 ? "#0a84ff" : "rgba(60,60,67,0.22)"} strokeWidth={8} strokeLinecap="round" />
          {totalIn > 1 && <line className="pipe-flow" x1={X.manifold} x2={X.disposal - 34} y1={trunkY} y2={trunkY} stroke="#fff" strokeOpacity={0.75} strokeWidth={2} />}
          <g transform={`translate(${X.disposal - 30},${trunkY - 30})`}>
            <rect width={170} height={60} rx={14} fill="#fff" stroke="rgba(60,60,67,0.18)" />
            <text x={14} y={24} className="fill-[var(--text)] text-[14px] font-semibold">Disposal site</text>
            <text x={14} y={44} className="fill-[var(--muted)] text-[12.5px]">
              {num(sys.disposal.pressurePsi)} psi, {num(totalIn)} bpd in
            </text>
          </g>

          {rows.map((f, i) => (
            <FacilityRow key={f.id} f={f} y={midY(i)} trunkY={trunkY} maxFlow={maxFlow} onClick={() => onFacility(f)} />
          ))}
        </svg>
      </div>
    </div>
  );
}

function FacilityRow({
  f,
  y,
  maxFlow,
  onClick,
}: {
  f: FacilityState;
  y: number;
  trunkY: number;
  maxFlow: number;
  onClick: () => void;
}) {
  const st = pipeStatus(f);
  const color = statusColor[st];
  const flow = Number.isFinite(f.pump.flowBpd) ? f.pump.flowBpd : 0;
  const recv = Number.isFinite(f.pipeline.receiveFlowBpd) ? f.pipeline.receiveFlowBpd : 0;
  const width = st === "flowing" || st === "leak" || st === "worn" ? 3 + 7 * Math.min(1, flow / maxFlow) : 4;
  const moving = flow > 1 && st !== "down" && st !== "nodata";
  const lost = Math.max(0, flow - recv);
  const level = Number.isFinite(f.tank.levelPct) ? Math.max(0, Math.min(100, f.tank.levelPct)) : 0;
  const wells = f.wells.slice(0, 6);
  const tankH = 46;
  const leakX = X.pipeStart + (X.manifold - X.pipeStart) * 0.62;

  const label =
    st === "down"
      ? "Pump down, no flow"
      : st === "nodata"
        ? "No recent readings"
        : st === "shut"
          ? "Wells shut in"
          : st === "leak"
            ? flow > 1
              ? `${num(flow)} bpd sent, ${num(recv)} arrives`
              : "Leak suspected, pump off right now"
            : st === "worn" && flow <= 1
              ? "Pump wearing out, off right now"
              : flow > 1
              ? `${num(flow)} bpd`
              : "Pump off, tank filling";

  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={`${facilityName(f.id)}: ${label}. Open details`}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className="cursor-pointer outline-none [&:focus-visible>rect:first-child]:stroke-[var(--water)] [&:hover>rect:first-child]:fill-black/[0.03]"
    >
      <rect x={4} y={y - ROW / 2 + 4} width={X.manifold - 8} height={ROW - 8} rx={12} fill="transparent" stroke="transparent" strokeWidth={2} />

      {/* wells feeding the tank */}
      <text x={X.wells - 22} y={y - 16} className="fill-[var(--text)] text-[13px] font-semibold">{f.letter}</text>
      {wells.map((w, k) => {
        const wx = X.wells + k * 13;
        return (
          <circle
            key={w.id}
            cx={wx}
            cy={y + 2}
            r={4.5}
            fill={w.producing ? "#34c759" : "#c7c7cc"}
            stroke="#fff"
            strokeWidth={1}
          >
            <title>{`Well ${w.id.split("_").pop()}: ${w.producing ? `${num(w.waterBpd)} bpd` : "shut in"}`}</title>
          </circle>
        );
      })}
      <text x={X.wells - 22} y={y + 22} className="fill-[var(--faint)] text-[11px]">{num(f.inflowBpd)} bpd in</text>
      <line x1={X.wells + wells.length * 13} x2={X.tank - 16} y1={y + 2} y2={y + 2} stroke="rgba(60,60,67,0.3)" strokeWidth={2} strokeLinecap="round" />

      {/* tank */}
      <g transform={`translate(${X.tank - 14},${y - tankH / 2})`}>
        <rect width={28} height={tankH} rx={8} fill="rgba(118,118,128,0.14)" />
        <rect y={tankH * (1 - level / 100)} width={28} height={(tankH * level) / 100} rx={level > 90 ? 8 : 0} fill={st === "down" ? "#ff3b30" : st === "nodata" || st === "shut" ? "#8e8e93" : "#0a84ff"} opacity={0.9} />
        <rect width={28} height={tankH} rx={8} fill="none" stroke="rgba(0,0,0,0.08)" />
      </g>
      <text x={X.tank + 20} y={y - 8} className="fill-[var(--text)] text-[12px] font-semibold">
        {st === "nodata" ? "?" : `${Math.round(level)}%`}
      </text>

      {/* tank -> pump */}
      <line x1={X.tank + 14} x2={X.pump - 13} y1={y + 6} y2={y + 6} stroke={moving ? color : "rgba(60,60,67,0.25)"} strokeWidth={4} strokeLinecap="round" />

      {/* pump */}
      <circle cx={X.pump} cy={y + 6} r={13} fill="#fff" stroke={color} strokeWidth={2.5} />
      {st === "down" ? (
        <path d={`M${X.pump - 5} ${y + 1}l10 10M${X.pump + 5} ${y + 1}l-10 10`} stroke="#ff3b30" strokeWidth={2.5} strokeLinecap="round" />
      ) : (
        <circle cx={X.pump} cy={y + 6} r={4} fill={moving ? color : "rgba(60,60,67,0.35)"} />
      )}

      {/* pipeline to the manifold */}
      <line
        x1={X.pipeStart}
        x2={X.manifold}
        y1={y + 6}
        y2={y + 6}
        stroke={color}
        strokeOpacity={st === "idle" ? 1 : 0.95}
        strokeWidth={width}
        strokeLinecap="round"
        strokeDasharray={st === "down" ? "8 7" : undefined}
      />
      {moving && <line className="pipe-flow" x1={X.pipeStart} x2={X.manifold} y1={y + 6} y2={y + 6} stroke="#fff" strokeOpacity={0.75} strokeWidth={Math.max(1.5, width / 3)} />}
      {st === "leak" && lost > 0 && (
        <g>
          <circle cx={leakX} cy={y + 6} r={9} fill="#ff9500" opacity={0.25} />
          <path d={`M${leakX} ${y + 12}c-3 5-3 8 0 10c3-2 3-5 0-10z`} fill="#ff9500" />
          <text x={leakX + 14} y={y + 30} className="fill-[var(--warn)] text-[12px] font-semibold">{num(lost)} bpd short right now</text>
        </g>
      )}
      <text x={X.pipeStart + 14} y={y - 8} className={cn("text-[12.5px]", st === "down" ? "fill-[var(--crit)] font-semibold" : "fill-[var(--muted)]")}>
        {label}
      </text>
      <text x={X.manifold - 12} y={y - 8} textAnchor="end" className="fill-[var(--faint)] text-[11.5px]">
        {Number.isFinite(f.pipeline.pressurePsi) ? `${num(f.pipeline.pressurePsi)} psi` : ""}
      </text>
    </g>
  );
}

function Legend() {
  return (
    <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span className="h-[4px] w-5 rounded-full bg-water" aria-hidden /> Flowing (thicker = more)
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-0 w-5 border-t-[3px] border-dashed border-crit" aria-hidden /> Pump down
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-[4px] w-5 rounded-full bg-warn-fill" aria-hidden /> Leak or worn pump
      </span>
    </div>
  );
}
