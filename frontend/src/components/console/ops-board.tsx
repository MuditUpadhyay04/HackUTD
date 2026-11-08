"use client";

// Operational overview: a network graph drawn from the real coordinates in network.json, and one table of
// everything that needs an operator. Plain and dense on purpose: this is a working dashboard.

import type { FacilityState, Incident, SystemState } from "@/lib/engine/types";
import { categoryLabel, clockFrom, countdownState, facilityName, humanize, money, num, planText, systemNum } from "@/lib/format";
import { cn } from "@/lib/utils";
import { pipeStatus, statusColor } from "./network";

const W = 900;
const H = 480;

/** System positions: keep their real left/right and up/down order, stretched to fill the panel. */
function spread(points: [number, number][], padX: number, padY: number) {
  const lats = points.map((p) => p[0]);
  const lons = points.map((p) => p[1]);
  const [minLat, maxLat, minLon, maxLon] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
  const fx = (lon: number) => (maxLon === minLon ? W / 2 : padX + ((lon - minLon) / (maxLon - minLon)) * (W - 2 * padX));
  const fy = (lat: number) => (maxLat === minLat ? H / 2 : padY + ((maxLat - lat) / (maxLat - minLat)) * (H - 2 * padY));
  return (lat: number, lon: number) => ({ x: fx(lon), y: fy(lat) });
}

export function NetworkGraph({
  systems,
  alerts,
  nowUnix,
  trucksFree,
  onFacility,
}: {
  systems: SystemState[];
  alerts: Incident[];
  nowUnix: number;
  trucksFree: (s: SystemState) => number;
  onFacility: (f: FacilityState) => void;
}) {
  if (!systems.length) return null;
  // Systems sit at their real relative positions (disposal sites); each system's facilities and truck yard
  // keep their real direction from the disposal site but are spread to a readable distance. Not to scale.
  const R = systems.length > 1 ? 74 : 140;
  const centers = spread(systems.map((s) => [s.disposal.lat, s.disposal.lon] as [number, number]), R + 70, R + 34);
  const k = Math.cos((systems[0].disposal.lat * Math.PI) / 180);
  const around = (s: SystemState, lat: number, lon: number, r: number) => {
    const c = centers(s.disposal.lat, s.disposal.lon);
    const dx = (lon - s.disposal.lon) * k, dy = -(lat - s.disposal.lat);
    const len = Math.hypot(dx, dy) || 1;
    return { x: c.x + (dx / len) * r, y: c.y + (dy / len) * r };
  };
  const p = (s: SystemState, lat: number, lon: number) => {
    const far = Math.max(1e-9, ...s.facilities.map((f) => Math.hypot((f.lon - s.disposal.lon) * k, f.lat - s.disposal.lat)));
    const d = Math.hypot((lon - s.disposal.lon) * k, lat - s.disposal.lat);
    return around(s, lat, lon, R * (0.45 + 0.55 * (d / far)));
  };
  const maxFlow = Math.max(1, ...systems.flatMap((s) => s.facilities.map((f) => f.pump.maxFlowBpd)));
  const failureAt = (f: FacilityState) => {
    const a = alerts.find((x) => x.facilityId === f.id && x.category === "pump_failure");
    if (!a) return undefined;
    const cd = countdownState(a, nowUnix);
    return cd.kind === "counting" ? `shuts in ${clockFrom(cd.at, nowUnix)}` : cd.kind === "shut_in" ? "shut in" : "pump down";
  };

  return (
    <div className="glass overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-4 py-2.5 text-[12.5px] text-muted-foreground">
        <span className="text-[13px] font-semibold text-text">Network map</span>
        <span className="text-faint">Not to scale</span>
        <Key color={statusColor.flowing} label="Flowing" />
        <Key color={statusColor.down} dashed label="Pump down" />
        <Key color={statusColor.leak} label="Leak or worn" />
        <Key color={statusColor.nodata} label="No data" />
        <span className="flex items-center gap-1.5">
          <svg width="10" height="10" aria-hidden><rect width="10" height="10" rx="2" fill="var(--text)" /></svg> Disposal
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="10" height="10" aria-hidden><path d="M5 0L10 10H0z" fill="#8e8e93" /></svg> Truck yard
        </span>
      </div>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full min-w-[620px]" role="img" aria-label="Map of every facility, pipeline and disposal site">
          {systems.map((s) => {
            const d = centers(s.disposal.lat, s.disposal.lon);
            const y = around(s, s.truckYard[0], s.truckYard[1], R * 0.7);
            return (
              <g key={s.id}>
                {/* pipelines: facility -> disposal */}
                {s.facilities.map((f) => {
                  const a = p(s, f.lat, f.lon);
                  const st = pipeStatus(f);
                  const flow = f.pump.flowBpd ?? 0;
                  const w = st === "flowing" || st === "leak" || st === "worn" ? 2 + 4 * Math.min(1, flow / maxFlow) : 2.5;
                  return (
                    <line key={f.id} x1={a.x} y1={a.y} x2={d.x} y2={d.y} stroke={statusColor[st]} strokeWidth={w} strokeLinecap="round" strokeDasharray={st === "down" ? "6 5" : undefined} />
                  );
                })}
                {/* truck yard */}
                <line x1={y.x} y1={y.y} x2={d.x} y2={d.y} stroke="rgba(60,60,67,0.18)" strokeWidth={1} strokeDasharray="2 4" />
                <path d={`M${y.x} ${y.y - 7}l7 12h-14z`} fill="#8e8e93">
                  <title>{`System ${systemNum(s.id)} truck yard: ${trucksFree(s)} of ${s.fleetSize} trucks free`}</title>
                </path>
                <text stroke="#fff" strokeWidth={3.5} paintOrder="stroke" strokeLinejoin="round" x={y.x + 10} y={y.y + 4} className="fill-[var(--faint)] text-[12px]">
                  {trucksFree(s)}/{s.fleetSize} trucks
                </text>
                {/* disposal */}
                <rect x={d.x - 7} y={d.y - 7} width={14} height={14} rx={3} fill="var(--text)">
                  <title>{`System ${systemNum(s.id)} disposal: ${num(s.disposal.pressurePsi)} psi`}</title>
                </rect>
                <text stroke="#fff" strokeWidth={3.5} paintOrder="stroke" strokeLinejoin="round" x={d.x} y={d.y + 22} textAnchor="middle" className="fill-[var(--text)] text-[13.5px] font-semibold">
                  System {systemNum(s.id)}
                </text>
                {/* facilities */}
                {s.facilities.map((f) => {
                  const a = p(s, f.lat, f.lon);
                  const st = pipeStatus(f);
                  const level = f.tank.levelPct;
                  const fail = failureAt(f);
                  return (
                    <g
                      key={f.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`${facilityName(f.id)}${fail ? `, ${fail}` : ""}. Open details`}
                      onClick={() => onFacility(f)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onFacility(f);
                        }
                      }}
                      className="cursor-pointer outline-none [&:focus-visible>circle]:stroke-[var(--water)] [&:hover>circle]:stroke-[var(--text)]"
                    >
                      <circle cx={a.x} cy={a.y} r={9} fill="#fff" stroke={statusColor[st]} strokeWidth={3} />
                      {st === "down" && <path d={`M${a.x - 3.5} ${a.y - 3.5}l7 7M${a.x + 3.5} ${a.y - 3.5}l-7 7`} stroke={statusColor.down} strokeWidth={2} strokeLinecap="round" />}
                      <text stroke="#fff" strokeWidth={3.5} paintOrder="stroke" strokeLinejoin="round" x={a.x + 13} y={a.y + 4} className="fill-[var(--text)] text-[13.5px] font-semibold">
                        {facilityName(f.id)}
                        <tspan className="fill-[var(--muted)] font-normal"> {level == null ? "tank ?" : `${Math.round(level)}%`}</tspan>
                      </text>
                      {fail && (
                        <text stroke="#fff" strokeWidth={3.5} paintOrder="stroke" strokeLinejoin="round" x={a.x + 13} y={a.y + 18} className="fill-[var(--crit)] text-[12.5px] font-semibold">
                          {fail}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

function Key({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <svg width="18" height="6" aria-hidden>
        <line x1="1" x2="17" y1="3" y2="3" stroke={color} strokeWidth="3" strokeLinecap="round" strokeDasharray={dashed ? "4 3" : undefined} />
      </svg>
      {label}
    </span>
  );
}

function actionVerb(a: Incident) {
  const plan = a.plan;
  if (!plan || plan.kind === "do_nothing") return "Review plan";
  if (plan.trucks > 0) return plan.trucks > 1 ? "Dispatch trucks" : "Dispatch truck";
  if (plan.shutIns.length) return "Schedule shut-in";
  return "Review plan";
}

/** Everything that needs an operator, one row each: pump failures (soonest first), inspections, sensor problems. */
export function AlertsTable({
  failures,
  inspections,
  noData,
  nowUnix,
  approvedAt,
  tickets,
  onIncident,
  onTicket,
  onFacility,
}: {
  failures: Incident[];
  inspections: Incident[];
  noData: FacilityState[];
  nowUnix: number;
  approvedAt: (id: string) => number | undefined;
  tickets: Record<string, number>;
  onIncident: (a: Incident) => void;
  onTicket: (a: Incident) => void;
  onFacility: (f: FacilityState) => void;
}) {
  const empty = !failures.length && !inspections.length && !noData.length;
  return (
    <div className="glass overflow-hidden">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <span className="text-[13px] font-semibold">Alerts</span>
        <span className="text-[12.5px] text-muted-foreground">
          {failures.length} down, {inspections.length} inspect{noData.length ? `, ${noData.length} no data` : ""}
        </span>
      </div>
      {empty ? (
        <p className="px-4 py-6 text-[14px] text-muted-foreground">Nothing needs action.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead className="text-[12px] text-faint">
              <tr className="border-b border-line">
                <th className="py-2 pr-2 pl-4 font-normal">Where</th>
                <th className="px-2 py-2 font-normal">When</th>
                <th className="px-2 py-2 font-normal">Plan</th>
                <th className="py-2 pr-4 pl-2 text-right font-normal">Action</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {failures.map((a) => {
                const cd = countdownState(a, nowUnix);
                const ok = approvedAt(a.id);
                return (
                  <tr key={a.id} className="border-b border-line-soft align-top last:border-0">
                    <Cell first>
                      <Dot tone="crit" />
                      <button type="button" onClick={() => onIncident(a)} className="font-semibold hover:underline">{facilityName(a.facilityId)}</button>
                      <span className="block pl-4 text-[12px] text-muted-foreground">Pump down</span>
                    </Cell>
                    <Cell className={cd.kind === "counting" ? "font-semibold text-crit" : "text-muted-foreground"}>
                      {cd.kind === "counting"
                        ? <>Shuts in {clockFrom(cd.at, nowUnix)}<span className="block text-[12px] font-normal text-muted-foreground">in {hm(cd.hours)}</span></>
                        : cd.kind === "shut_in"
                          ? "Shut in"
                          : cd.kind === "repair_first"
                            ? `Repair first, ${clockFrom(cd.repairAt, nowUnix)}`
                            : cd.kind === "not_filling"
                              ? "Not filling"
                              : "Unknown"}
                    </Cell>
                    <Cell>
                      {a.plan ? (
                        <>
                          {planText(a.plan.label, nowUnix)}
                          <span className="block text-faint">{money(a.plan.cost)}</span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">No plan</span>
                      )}
                    </Cell>
                    <Cell last>
                      {ok != null ? (
                        <span className="text-[12.5px] font-medium text-[#248a3d]">Approved {clockFrom(ok, nowUnix)}</span>
                      ) : (
                        <button type="button" onClick={() => onIncident(a)} className="rounded-md bg-water px-2.5 py-1 text-[12.5px] font-medium whitespace-nowrap text-white">
                          {actionVerb(a)}
                        </button>
                      )}
                    </Cell>
                  </tr>
                );
              })}
              {inspections.map((a) => (
                <tr key={a.id} className="border-b border-line-soft align-top last:border-0">
                  <Cell first>
                    <Dot tone="warn" />
                    <button type="button" onClick={() => onIncident(a)} className="font-semibold hover:underline">{facilityName(a.facilityId)}</button>
                    <span className="block pl-4 text-[12px] text-muted-foreground">{categoryLabel[a.category as keyof typeof categoryLabel] ?? humanize(a.category)}</span>
                  </Cell>
                  <Cell className="text-muted-foreground">Since {clockFrom(a.onsetUnix, nowUnix)}</Cell>
                  <Cell>Send an inspector</Cell>
                  <Cell last>
                    {tickets[a.id] != null ? (
                      <span className="text-[12.5px] font-medium text-[#248a3d]">Ticket created</span>
                    ) : (
                      <button type="button" onClick={() => onTicket(a)} className="rounded-md px-2.5 py-1 text-[12.5px] font-medium whitespace-nowrap text-water ring-1 ring-water/40">
                        Create ticket
                      </button>
                    )}
                  </Cell>
                </tr>
              ))}
              {noData.map((f) => (
                <tr key={f.id} className="border-b border-line-soft align-top last:border-0">
                  <Cell first>
                    <Dot tone="none" />
                    <span className="font-semibold">{facilityName(f.id)}</span>
                    <span className="block pl-4 text-[12px] text-muted-foreground">No data</span>
                  </Cell>
                  <Cell className="text-muted-foreground">{humanize(f.dataQuality.reasons[0] ?? "Readings missing")}</Cell>
                  <Cell>Check sensors</Cell>
                  <Cell last>
                    <button type="button" onClick={() => onFacility(f)} className="text-[12.5px] font-medium whitespace-nowrap text-water hover:underline">
                      See readings
                    </button>
                  </Cell>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function hm(hours: number) {
  const m = Math.max(0, Math.round(hours * 60));
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

function Cell({ children, className, first, last }: { children: React.ReactNode; className?: string; first?: boolean; last?: boolean }) {
  return <td className={cn("py-2", first ? "pr-2 pl-4 whitespace-nowrap" : last ? "pr-4 pl-2 text-right" : "px-2", className)}>{children}</td>;
}

function Dot({ tone }: { tone: "crit" | "warn" | "none" }) {
  return (
    <span
      aria-hidden
      className={cn("mr-2 inline-block size-2 rounded-full align-middle", tone === "crit" ? "bg-crit" : tone === "warn" ? "bg-warn-fill" : "bg-[#8e8e93]")}
    />
  );
}

/** One line of numbers instead of big cards. */
export function KpiStrip({ items }: { items: { label: string; value: string; tone?: "crit" }[] }) {
  return (
    <div className="glass grid grid-cols-2 divide-line sm:grid-cols-4 sm:divide-x">
      {items.map((k) => (
        <div key={k.label} className="px-4 py-2.5">
          <p className="text-[12px] text-faint">{k.label}</p>
          <p className={cn("text-[18px] font-semibold tabular-nums", k.tone === "crit" && "text-crit")}>{k.value}</p>
        </div>
      ))}
    </div>
  );
}
