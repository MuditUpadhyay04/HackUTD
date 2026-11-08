"use client";

// Operational overview: one tile per system (disposal site and its facilities), and one table of everything
// that needs an operator. Plain and dense on purpose: this is a working dashboard.

import type { FacilityState, Incident, SystemState } from "@/lib/engine/types";
import { categoryLabel, clockFrom, countdownState, facilityName, humanize, letterOf, money, num, planText, systemNum } from "@/lib/format";
import { cn } from "@/lib/utils";
import { pipeStatus, statusColor } from "./network";

const TW = 236; // tile viewBox, close to its on-screen size so text stays readable
const TH = 172;

/** Evenly spaced positions around the disposal site, in each facility's real compass order. */
function ring(system: SystemState) {
  const k = Math.cos((system.disposal.lat * Math.PI) / 180);
  const bearing = (f: FacilityState) => Math.atan2(-(f.lat - system.disposal.lat), (f.lon - system.disposal.lon) * k);
  const sorted = [...system.facilities].sort((a, b) => bearing(a) - bearing(b));
  const n = sorted.length;
  const a0 = n ? bearing(sorted[0]!) : 0;
  const r = n <= 2 ? 50 : 46;
  return sorted.map((f, i) => {
    const a = n === 1 ? a0 : a0 + (i * 2 * Math.PI) / n;
    return { f, a, x: TW / 2 + Math.cos(a) * r * 1.3, y: TH / 2 + Math.sin(a) * r };
  });
}

/** One equal tile per system: disposal site in the middle, its facilities evenly around it. Nothing overlaps. */
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
  const maxFlow = Math.max(1, ...systems.flatMap((s) => s.facilities.map((f) => f.pump.maxFlowBpd)));
  const failureAt = (f: FacilityState) => {
    const a = alerts.find((x) => x.facilityId === f.id && x.category === "pump_failure");
    if (!a) return undefined;
    const cd = countdownState(a, nowUnix);
    return cd.kind === "counting" ? clockFrom(cd.at, nowUnix) : cd.kind === "shut_in" ? "shut in" : "down";
  };
  // Systems that need someone first; otherwise network order.
  const rank = (s: SystemState) => (alerts.some((a) => a.systemId === s.id && a.category === "pump_failure") ? 0 : alerts.some((a) => a.systemId === s.id) ? 1 : 2);
  const ordered = systems.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map((x) => x.s);

  return (
    <div className="glass overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-4 py-2.5 text-[12.5px] text-muted-foreground">
        <span className="text-[13px] font-semibold text-text">Network</span>
        <span className="text-faint">Red time = tank shutdown</span>
        <Key color={statusColor.flowing} label="Flowing" />
        <Key color={statusColor.down} dashed label="Pump down" />
        <Key color={statusColor.leak} label="Leak or worn" />
        <Key color={statusColor.nodata} label="No data" />
        <span className="flex items-center gap-1.5">
          <svg width="10" height="10" aria-hidden><rect width="10" height="10" rx="2" fill="var(--text)" /></svg> Disposal site
        </span>
      </div>
      <div className={cn("grid grid-cols-1 min-[480px]:grid-cols-2 md:grid-cols-3", systems.length === 4 ? "xl:grid-cols-4" : systems.length >= 5 ? "xl:grid-cols-5" : "")}>
        {ordered.map((s) => {
          const down = alerts.filter((a) => a.systemId === s.id && a.category === "pump_failure").length;
          const inspect = alerts.filter((a) => a.systemId === s.id && a.category !== "pump_failure").length;
          const free = trucksFree(s);
          const pts = ring(s);
          return (
            <section key={s.id} className="px-3 pt-2.5 pb-1 shadow-[inset_-0.5px_-0.5px_0_var(--line)]" aria-label={`System ${systemNum(s.id)}`}>
              <header className="text-[13px] leading-tight">
                <span className="block font-semibold">System {systemNum(s.id)}</span>
                <span className="block text-[12px] text-muted-foreground tabular-nums">
                  {down > 0 && <span className="font-semibold text-crit">{down} down · </span>}
                  {inspect > 0 && <span className="font-semibold text-warn">{inspect} inspect · </span>}
                  <span className={cn(free === 0 && "font-semibold text-crit")}>{free}/{s.fleetSize} trucks free</span>
                </span>
              </header>
              <svg viewBox={`0 0 ${TW} ${TH}`} className="block h-auto w-full" role="img" aria-label={`System ${systemNum(s.id)}: ${s.facilities.length} facilities around the disposal site`}>
                {pts.map(({ f, x, y }) => {
                  const st = pipeStatus(f);
                  const flow = f.pump.flowBpd ?? 0;
                  const w = st === "flowing" || st === "leak" || st === "worn" ? 2.5 + 4 * Math.min(1, flow / maxFlow) : 2.5;
                  return <line key={f.id} x1={TW / 2} y1={TH / 2} x2={x} y2={y} stroke={statusColor[st]} strokeWidth={w} strokeLinecap="round" strokeDasharray={st === "down" ? "6 5" : undefined} />;
                })}
                <rect x={TW / 2 - 8} y={TH / 2 - 8} width={16} height={16} rx={3} fill="var(--text)">
                  <title>{`Disposal site: ${num(s.disposal.pressurePsi)} psi`}</title>
                </rect>
                {pts.map(({ f, a, x, y }) => {
                  const st = pipeStatus(f);
                  const fail = failureAt(f);
                  const c = Math.cos(a), sn = Math.sin(a);
                  const anchor = c > 0.35 ? "start" : c < -0.35 ? "end" : "middle";
                  const lx = x + (anchor === "start" ? 14 : anchor === "end" ? -14 : 0);
                  // Labels sit outside the node: beside it on the left/right, above/below at the top/bottom.
                  const ly = anchor === "middle" ? (sn < 0 ? y - 16 - (fail ? 14 : 0) : y + 24) : y + 4 - (fail ? 7 : 0);
                  const level = f.tank.levelPct;
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
                      className="cursor-pointer outline-none [&:focus-visible>circle]:stroke-[var(--water)] [&:hover>circle]:fill-[#f2f2f7]"
                    >
                      <circle cx={x} cy={y} r={9} fill="#fff" stroke={statusColor[st]} strokeWidth={3} />
                      {st === "down" && <path d={`M${x - 3.5} ${y - 3.5}l7 7M${x + 3.5} ${y - 3.5}l-7 7`} stroke={statusColor.down} strokeWidth={2} strokeLinecap="round" />}
                      <text x={lx} y={ly} textAnchor={anchor} className="fill-[var(--text)] text-[13px] font-semibold">
                        {letterOf(f)}
                        <tspan className="fill-[var(--muted)] font-normal"> {level == null ? "?" : `${Math.round(level)}%`}</tspan>
                      </text>
                      {fail && (
                        <text x={lx} y={ly + 15} textAnchor={anchor} className="fill-[var(--crit)] text-[12.5px] font-semibold">
                          {fail}
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>
            </section>
          );
        })}
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
  agentNote = {},
}: {
  agentNote?: Record<string, string>;
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
                          {agentNote[a.id] && <AgentNote text={planText(agentNote[a.id]!, nowUnix)} />}
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
                  <Cell>
                    Send an inspector
                    {agentNote[a.id] && <AgentNote text={planText(agentNote[a.id]!, nowUnix)} />}
                  </Cell>
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

/** The agents' one-line explanation for an alert, marked as advice from Nemotron. */
function AgentNote({ text }: { text: string }) {
  return (
    <span className="mt-1 block max-w-[52ch] text-[12.5px] leading-snug text-muted-foreground">
      <span className="font-medium text-[#4c8a00]">Agents: </span>
      {text}
    </span>
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
