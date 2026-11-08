"use client";

import { useRef, type ReactNode } from "react";
import { Check, Truck } from "lucide-react";
import type { BoardFacility, BoardScores, FacilityState, Incident, PlanOption } from "@/lib/engine/types";
import { assetName, categoryLabel, clockFrom, countdownState, dayClock, duration, planText, facilityTitle, humanize, money, num, systemNum } from "@/lib/format";
import { Dialog as Sheet, DialogContent as SheetContent, DialogDescription as SheetDescription, DialogHeader as SheetHeader, DialogTitle as SheetTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { LevelChart } from "./level-chart";
import { TankGlyph, toneFor, type Limits } from "./tank";

const sheetClass =
  "block max-h-[90vh] gap-0 overflow-y-auto rounded-[20px] bg-white/90 backdrop-blur-[40px] backdrop-saturate-[1.8] p-0 shadow-[0_24px_60px_-20px_rgba(16,20,24,0.28)] ring-0 sm:max-w-[820px]";

export function IncidentSheet({
  incident,
  facility,
  nowUnix,
  limits,
  approvedAt,
  onApprove,
  onClose,
  boardFacility,
  boardSource,
  boardTestWeights,
  boardSoftware,
}: {
  incident: Incident | null;
  facility?: FacilityState;
  nowUnix: number;
  limits: Limits;
  approvedAt?: number;
  onApprove: (a: Incident) => void;
  onClose: () => void;
  /** Live board data for this facility; absent in local mode, so nothing extra renders. */
  boardFacility?: BoardFacility;
  boardSource?: "live" | "simulated";
  boardTestWeights?: boolean;
  boardSoftware?: boolean;
}) {
  // Focus starts on the sheet itself, so a stray Enter can't approve a plan nobody has read yet.
  const popupRef = useRef<HTMLDivElement>(null);
  return (
    <Sheet open={!!incident} onOpenChange={(o) => !o && onClose()}>
      <SheetContent ref={popupRef} initialFocus={popupRef} className={sheetClass}>
        {incident && (incident.category === "pump_failure" ? (
          <FailureDetail
            incident={incident}
            facility={facility}
            nowUnix={nowUnix}
            limits={limits}
            approvedAt={approvedAt}
            onApprove={() => onApprove(incident)}
            board={boardFacility && <BoardSection board={boardFacility} source={boardSource} testWeights={boardTestWeights} software={boardSoftware} nowUnix={nowUnix} />}
          />
        ) : (
          <InspectionDetail
            incident={incident}
            facility={facility}
            nowUnix={nowUnix}
            board={
              boardFacility && (
                <BoardSection
                  board={boardFacility}
                  source={boardSource}
                  testWeights={boardTestWeights}
                  software={boardSoftware}
                  nowUnix={nowUnix}
                  showTrend={incident.category === "pump_degradation"}
                  onsetUnix={incident.onsetUnix}
                />
              )
            }
          />
        ))}
      </SheetContent>
    </Sheet>
  );
}

function FailureDetail({
  incident: a,
  facility,
  nowUnix,
  limits,
  approvedAt,
  onApprove,
  board,
}: {
  incident: Incident;
  facility?: FacilityState;
  nowUnix: number;
  limits: Limits;
  approvedAt?: number;
  onApprove: () => void;
  board?: ReactNode;
}) {
  const cd = countdownState(a, nowUnix);
  const doNothing = a.options?.find((o) => o.kind === "do_nothing");
  // The plan the chart draws as a blue line; the legend lists only marks that are on the chart.
  const rec = a.plan && a.plan.kind !== "do_nothing" ? a.plan : null;
  return (
    <>
      <SheetHeader className="border-b border-line px-5 sm:px-8 pt-7 pb-6">
        <SheetDescription className="text-[14px] text-crit">
          Pump down since {clockFrom(a.onsetUnix, nowUnix)}{a.repairEndsUnix ? `, repair due ${clockFrom(a.repairEndsUnix, nowUnix)}` : ""}
        </SheetDescription>
        <SheetTitle className="font-display text-[28px] leading-tight font-semibold text-text [overflow-wrap:anywhere]">
          {cd.kind === "counting" ? (
            <>
              {facilityTitle(a.facilityId)} reaches shutdown in <span className="num text-crit">{duration(cd.hours)}</span> unless we act
            </>
          ) : cd.kind === "shut_in" ? (
            `${facilityTitle(a.facilityId)} is shut in until the repair`
          ) : cd.kind === "repair_first" ? (
            `${facilityTitle(a.facilityId)} should be repaired before the tank fills`
          ) : (
            `${facilityTitle(a.facilityId)} has a pump down`
          )}
        </SheetTitle>
        {a.hoursToLimit && cd.kind === "counting" && (
          <p className="text-[14px] text-muted-foreground">
            Most likely {clockFrom(cd.at, nowUnix)}, between {clockFrom(nowUnix + a.hoursToLimit.p10 * 3600, nowUnix)} and {clockFrom(nowUnix + a.hoursToLimit.p90 * 3600, nowUnix)}, depending on how fast the wells flow.
          </p>
        )}
      </SheetHeader>

      <section className="px-5 sm:px-8 pt-6">
        <h3 className="mb-2 font-display text-[16px] font-semibold">Tank level, and where it goes next</h3>
        {facility && (
          <LevelChart
            history={facility.series.level}
            nowUnix={nowUnix}
            limits={limits}
            projections={[
              ...(doNothing ? [{ option: doNothing, emphasis: "baseline" as const }] : []),
              ...(rec ? [{ option: rec, emphasis: "recommended" as const }] : []),
            ]}
          />
        )}
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[13px] whitespace-nowrap text-muted-foreground">
          <span className="flex items-center gap-1.5"><span className="h-0 w-5 border-t-2 border-dashed border-crit" /> If nobody acts</span>
          {rec && <span className="flex items-center gap-1.5"><span className="h-0 w-5 border-t-2 border-water" /> Recommended plan</span>}
          {rec && rec.truckArrivalsMin.length > 0 && <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full border-2 border-water" /> Truck arrives</span>}
        </div>
      </section>

      <section className="px-5 sm:px-8 pt-7">
        <h3 className="mb-3 font-display text-[16px] font-semibold">Options, cheapest first</h3>
        <ul className="flex flex-col gap-2">
          {(a.options ?? []).map((o, i) => (
            <OptionRow key={o.label} option={o} best={i === 0} nowUnix={nowUnix} />
          ))}
        </ul>
        <p className="mt-3 text-[13px] text-faint">
          Costs include truck trips, travel times and the oil and gas revenue lost while wells are shut in. The plan solver does the math.
        </p>
      </section>

      {facility && <WellsTable facility={facility} highlight={a.plan?.shutIns.map((s) => s.wellId) ?? []} />}

      {board}

      <section className="px-5 sm:px-8 py-7">
        <h3 className="mb-2 font-display text-[16px] font-semibold">Why we think the pump is down</h3>
        <ul className="flex flex-col gap-1.5 text-[14px] text-muted-foreground">
          {a.evidence.map((e) => (
            <li key={e} className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-faint" aria-hidden />{humanize(e)}</li>
          ))}
        </ul>
        <p className="mt-3 text-[13px] text-faint">Confidence {Math.round(a.confidence * 100)}%</p>
        {doNothing && a.plan && doNothing.cost > a.plan.cost && (
          <p className="mt-4 text-[14px] text-muted-foreground">
            Doing nothing would cost <span className="num text-text">{money(doNothing.cost)}</span> in lost production.
          </p>
        )}
      </section>
      {a.plan && (
        <div className="sticky bottom-0 flex items-center gap-4 border-t border-line bg-white/80 px-5 py-4 backdrop-blur-[30px] sm:px-8">
          <p className="min-w-0 text-[14px] text-muted-foreground">
            <span className="block font-semibold text-text">{planText(a.plan.label, nowUnix)}</span>
            {money(a.plan.cost)} in total
          </p>
          {approvedAt ? (
            <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[14px] font-medium text-ok">
              <Check className="size-4" aria-hidden /> Approved at {clockFrom(approvedAt, nowUnix)}
            </span>
          ) : (
            <button
              type="button"
              onClick={onApprove}
              className="ml-auto shrink-0 rounded-[10px] bg-water px-5 py-[9px] text-[14px] font-semibold text-white shadow-[inset_0_0.5px_0_rgba(255,255,255,0.35),0_1px_2px_rgba(10,132,255,0.35)] transition-[transform,background-color] duration-100 hover:bg-water-deep active:scale-[0.98]"
            >
              Approve plan
            </button>
          )}
        </div>
      )}
    </>
  );
}

function OptionRow({ option: o, best, nowUnix }: { option: PlanOption; best: boolean; nowUnix: number }) {
  // Skip "Tank still reaches shutdown" when the label already names that time (plan labels say
  // "reaches shutdown at", do-nothing says "shut in automatically at"), so a row never shows two minutes.
  const sub = [
    o.tankTrips
      ? /reaches shutdown|shut in automatically/i.test(o.label)
        ? null
        : `Tank still reaches shutdown${o.tripAtMin != null ? ` at ${clockFrom(nowUnix + o.tripAtMin * 60, nowUnix)}` : ""}`
      : "Tank stays below shutdown",
    o.truckArrivalsMin.length > 0 ? `First truck arrives at ${clockFrom(nowUnix + o.truckArrivalsMin[0] * 60, nowUnix)}` : null,
  ]
    .filter(Boolean)
    .join(". ");
  return (
    <li
      className={cn(
        "grid grid-cols-[1fr_auto] items-start gap-3 rounded-xl border px-4 py-3 sm:items-center sm:gap-4",
        best ? "border-water/60 bg-water/[0.05]" : "border-line bg-white/60",
      )}
    >
      <div className="min-w-0">
        {best && <p className="mb-0.5 text-[12.5px] font-semibold text-water sm:hidden">Recommended</p>}
        <p className="text-[15px] leading-snug font-semibold text-text sm:text-[16px]">
          {o.trucks > 0 && <Truck className="mr-1.5 inline size-4 shrink-0 align-[-2px]" aria-hidden />}
          {planText(o.label, nowUnix)}
          {best && <span className="ml-2 hidden text-[13px] font-semibold whitespace-nowrap text-water sm:inline">Recommended</span>}
        </p>
        {sub && <p className="mt-0.5 text-[13px] text-muted-foreground">{sub}</p>}
      </div>
      <span className="num text-[18px] font-semibold whitespace-nowrap text-text sm:text-[20px]">{money(o.cost)}</span>
    </li>
  );
}

function WellsTable({ facility: f, highlight }: { facility: FacilityState; highlight: string[] }) {
  return (
    <section className="px-5 sm:px-8 pt-7">
      <h3 className="mb-2 font-display text-[16px] font-semibold">Wells feeding this tank</h3>
      <table className="w-full text-[14px]">
        <thead>
          <tr className="text-left text-[13px] text-muted-foreground">
            <th className="py-2 font-normal">Well</th>
            <th className="py-2 text-right font-normal" title="bpd = barrels per day">Water</th>
            <th className="py-2 text-right font-normal">Revenue if shut in</th>
            <th className="py-2 text-right font-normal">Cost per bbl avoided</th>
          </tr>
        </thead>
        <tbody>
          {f.wells.map((w) => (
            <tr key={w.id} className={cn("border-t border-line", highlight.includes(w.id) && "font-medium")}>
              <td className="py-2.5">
                {assetName(w.id)}
                {!w.producing && <span className="ml-2 text-[13px] text-muted-foreground">shut in</span>}
                {highlight.includes(w.id) && <span className="ml-2 text-[13px] font-normal text-muted-foreground">planned shut-in</span>}
              </td>
              <td className="num py-2.5 text-right">{num(w.waterBpd)} bpd</td>
              <td className="num py-2.5 text-right">{money(w.revenuePerHour)}/h</td>
              <td className="num py-2.5 text-right">{money(w.costPerBblAvoided)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function InspectionDetail({
  incident: a,
  facility,
  nowUnix,
  board,
}: {
  incident: Incident;
  facility?: FacilityState;
  nowUnix: number;
  board?: ReactNode;
}) {
  return (
    <>
      <SheetHeader className="border-b border-line px-5 sm:px-8 pt-7 pb-6">
        <SheetDescription className="text-[14px] text-warn">
          {categoryLabel[a.category]} since {clockFrom(a.onsetUnix, nowUnix)}, {duration((nowUnix - a.onsetUnix) / 3600)} ago
        </SheetDescription>
        <SheetTitle className="font-display text-[28px] leading-tight font-semibold text-text [overflow-wrap:anywhere]">
          Send an inspector to {humanize(a.assetId)}
        </SheetTitle>
        <p className="text-[14px] text-muted-foreground">
          {a.category === "pipeline_leak"
            ? "Water is leaving the pump but not all of it reaches the disposal site. The tank is not at risk; the leak itself is the problem."
            : "The pump still runs but moves less water each hour. Catching it now avoids a failure later."}
        </p>
      </SheetHeader>
      <section className="grid grid-cols-2 gap-6 px-5 pt-6 sm:grid-cols-3 sm:px-8">
        {a.estLeakBblPerDay != null && <Stat label="Estimated water lost" value={`${num(a.estLeakBblPerDay)} bpd`} title="bpd = barrels per day" />}
        {a.capacityLossPct != null && <Stat label="Pumping capacity lost" value={`${num(a.capacityLossPct, 1)}%`} />}
        <Stat label="Confidence" value={`${Math.round(a.confidence * 100)}%`} />
      </section>
      {facility && (
        <section className="px-5 sm:px-8 pt-6">
          <h3 className="mb-2 font-display text-[16px] font-semibold">
            {a.category === "pipeline_leak" ? "Water that never reached the disposal site" : "How much water the pump moves, vs. what it should"}
          </h3>
          {a.category === "pipeline_leak" ? <LeakChart facility={facility} onsetUnix={a.onsetUnix} nowUnix={nowUnix} /> : <WearChart facility={facility} onsetUnix={a.onsetUnix} nowUnix={nowUnix} />}
        </section>
      )}
      {board}
      <section className="px-5 sm:px-8 py-7">
        <h3 className="mb-2 font-display text-[16px] font-semibold">What we saw</h3>
        <ul className="flex flex-col gap-1.5 text-[14px] text-muted-foreground">
          {a.evidence.map((e) => (
            <li key={e} className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-faint" aria-hidden />{humanize(e)}</li>
          ))}
        </ul>
      </section>
    </>
  );
}

const bpd = (n: number) => (Number.isFinite(n) ? `${num(n)} bpd` : "No data");

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="flex flex-col py-1" title={title}>
      <p className="text-[13px] text-muted-foreground">{label}</p>
      <p className="num mt-1 text-[28px] leading-none font-light text-text">{value}</p>
    </div>
  );
}

/** Shared frame for the small inspection charts: time on x, a value on y, onset marked. */
function MiniChart({
  t,
  bars,
  line,
  target: refLine,
  onsetUnix,
  nowUnix,
  unit,
  label,
  domain,
}: {
  t: number[];
  bars?: (number | null)[];
  line?: (number | null)[];
  target?: { value: number; label: string };
  onsetUnix?: number;
  nowUnix: number;
  unit: string;
  label: string;
  /** Fixed y range, e.g. [0, 100] for a score in percent. */
  domain?: [number, number];
}) {
  const w = 640, h = 180, padL = 48, padR = 10, padT = 22, padB = 22;
  const vals = [...(bars ?? []), ...(line ?? []), refLine?.value ?? 0].filter((v): v is number => v != null);
  const lo = domain ? domain[0] : line ? Math.min(...vals) * 0.98 : 0;
  const hi = domain ? domain[1] : Math.max(1, ...vals) * 1.05;
  const t0 = t[0], t1 = t[t.length - 1];
  const x = (tt: number) => padL + ((tt - t0) / Math.max(1, t1 - t0)) * (w - padL - padR);
  const y = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);
  const bw = Math.max(1.5, (w - padL - padR) / t.length - 1);
  let d = "";
  line?.forEach((v, i) => {
    if (v == null) return;
    const prev = i > 0 ? line[i - 1] : null;
    d += `${prev == null ? "M" : "L"}${x(t[i]).toFixed(1)},${y(v).toFixed(1)}`;
  });
  const ticks = [lo, (lo + hi) / 2, hi].map((v) => Math.round(v / 10) * 10);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-auto w-full" role="img" aria-label={label}>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={padL} x2={w - padR} y1={y(v)} y2={y(v)} stroke="var(--line-soft)" />
          <text x={padL - 8} y={y(v) + 4} textAnchor="end" className="fill-[var(--faint)] text-[11px]">{num(v)}</text>
        </g>
      ))}
      <text x={padL} y={padT - 2} className="fill-[var(--faint)] text-[10.5px]">{unit}</text>
      {bars?.map((v, i) =>
        v != null && v > 0 ? (
          <rect key={i} x={x(t[i]) - bw / 2} y={y(v)} width={bw} height={y(lo) - y(v)} fill="var(--warn)" opacity={onsetUnix == null || t[i] >= onsetUnix ? 0.9 : 0.3} />
        ) : null,
      )}
      {refLine && (
        <>
          <line x1={padL} x2={w - padR} y1={y(refLine.value)} y2={y(refLine.value)} stroke="var(--text)" strokeOpacity={0.5} strokeDasharray="4 4" />
          <text x={w - padR} y={y(refLine.value) - 5} textAnchor="end" className="fill-[var(--muted)] text-[11px]">{refLine.label}</text>
        </>
      )}
      {d && <path d={d} fill="none" stroke="var(--warn)" strokeWidth={1.8} />}
      {onsetUnix != null && onsetUnix >= t0 && (
        <>
          <line x1={x(onsetUnix)} x2={x(onsetUnix)} y1={padT} y2={h - padB} stroke="var(--warn)" strokeOpacity={0.6} strokeDasharray="2 3" />
          <text x={x(onsetUnix) + 5} y={domain ? padT + 12 : h - padB - 6} className="fill-[var(--warn)] text-[11px]">Started {clockFrom(onsetUnix, nowUnix)}</text>
        </>
      )}
      {[t0, (t0 + t1) / 2, t1].map((tt) => (
        <text key={tt} x={x(tt)} y={h - 5} textAnchor={tt === t0 ? "start" : tt === t1 ? "end" : "middle"} className="fill-[var(--faint)] text-[11px]">{dayClock(tt)}</text>
      ))}
    </svg>
  );
}

function LeakChart({ facility: f, onsetUnix, nowUnix }: { facility: FacilityState; onsetUnix: number; nowUnix: number }) {
  const { t, v: sent } = f.series.pumpFlow;
  const got = f.series.receiveFlow.v;
  const gap = sent.map((s, i) => (s > 50 ? Math.max(0, s - (got[i] ?? s)) : null));
  return (
    <>
      <MiniChart t={t} bars={gap} onsetUnix={onsetUnix} nowUnix={nowUnix} unit="bpd" label="Water lost per reading since the leak started" />
      <p className="mt-1 text-[13px] text-muted-foreground">
        Each bar is water the pump sent that didn&apos;t arrive. Gaps are when the pump was off and nothing flows.
      </p>
    </>
  );
}

function WearChart({ facility: f, onsetUnix, nowUnix }: { facility: FacilityState; onsetUnix: number; nowUnix: number }) {
  const { t, v } = f.series.pumpFlow;
  const running = v.map((x) => (x > 50 ? x : null));
  return (
    <>
      <MiniChart t={t} line={running} target={{ value: f.pump.maxFlowBpd, label: `Rated ${num(f.pump.maxFlowBpd)} bpd` }} onsetUnix={onsetUnix} nowUnix={nowUnix} unit="bpd" label="Pump flow compared with rated flow" />
      <p className="mt-1 text-[13px] text-muted-foreground">Flow while the pump runs. A healthy pump sits on the dashed line.</p>
    </>
  );
}

export function FacilitySheet({
  facility,
  incident,
  nowUnix,
  limits,
  onClose,
  onOpenIncident,
  boardFacility,
  boardSource,
  boardTestWeights,
  boardSoftware,
}: {
  facility: FacilityState | null;
  incident?: Incident;
  nowUnix: number;
  limits: Limits;
  onClose: () => void;
  onOpenIncident: (incident: Incident) => void;
  /** Live board data for this facility; absent in local mode, so nothing extra renders. */
  boardFacility?: BoardFacility;
  boardSource?: "live" | "simulated";
  boardTestWeights?: boolean;
  boardSoftware?: boolean;
}) {
  const f = facility;
  const pumpText = f ? (["Stopped", "Running", "Fault"][f.pump.status] ?? "status unknown") : "";
  const level = f && Number.isFinite(f.tank.levelPct) ? Math.round(f.tank.levelPct) : null;
  const dq = f && f.dataQuality && f.dataQuality.quality !== "VALID" ? f.dataQuality : undefined;
  const popupRef = useRef<HTMLDivElement>(null);
  return (
    <Sheet open={!!f} onOpenChange={(o) => !o && onClose()}>
      <SheetContent ref={popupRef} initialFocus={popupRef} className={sheetClass}>
        {f && (
          <>
            <SheetHeader className="flex-row items-center gap-6 border-b border-line px-5 sm:px-8 pt-7 pb-6">
              <TankGlyph level={f.tank.levelPct} tone={toneFor(f, limits)} limits={limits} height={120} width={74} />
              <div className="flex min-w-0 flex-col gap-1">
                <SheetDescription className="text-[14px]">System {systemNum(f.systemId)}, {num(f.tank.capacityBbl)} bbl tank</SheetDescription>
                <SheetTitle className="font-display text-[28px] leading-tight font-semibold text-text [overflow-wrap:anywhere]">
                  {f.health === "no_data" && level == null ? (
                    `${facilityTitle(f.id)} has no data`
                  ) : (
                    <>
                      {facilityTitle(f.id)} is <span className="num">{level ?? 0}%</span> full
                    </>
                  )}
                </SheetTitle>
                {Number.isFinite(f.fillPctPerHour) && (
                  <p className="text-[14px] text-muted-foreground">
                    {f.fillPctPerHour >= 0 ? "Rising" : "Falling"} <span className="num text-text">{num(Math.abs(f.fillPctPerHour), 1)}%</span> per hour. Pump {pumpText.toLowerCase()}.
                  </p>
                )}
                {dq && (
                  <ul className="mt-1 flex flex-col gap-0.5 text-[13px] text-faint">
                    <li className="font-medium">{f.health === "no_data" ? "No data" : dq.quality === "HELD" ? "Some readings held" : "Some readings missing"}</li>
                    {dq.reasons.map((r) => (
                      <li key={r}>{humanize(r)}</li>
                    ))}
                  </ul>
                )}
              </div>
            </SheetHeader>
            {incident && (
              <button
                type="button"
                onClick={() => onOpenIncident(incident)}
                className={cn(
                  "mx-5 mt-6 flex w-[calc(100%-2.5rem)] items-center justify-between gap-4 rounded-xl border px-4 py-3 text-left transition-colors sm:mx-8 sm:w-[calc(100%-4rem)]",
                  incident.plan ? "border-crit/30 bg-crit/[0.06] hover:bg-crit/[0.12]" : "border-warn-fill/40 bg-warn-fill/[0.08] hover:bg-warn-fill/[0.14]",
                )}
              >
                <span className="text-[14px] text-text">
                  <span className="font-semibold">{categoryLabel[incident.category]}.</span>{" "}
                  {incident.plan ? `Recommended: ${planText(incident.plan.label, nowUnix)} (${money(incident.plan.cost)})` : "Send an inspector."}
                </span>
                <span className="shrink-0 text-[14px] font-semibold text-water">{incident.plan ? "See the plan" : "See details"}</span>
              </button>
            )}
            <section className="px-5 sm:px-8 pt-6">
              <h3 className="mb-2 font-display text-[16px] font-semibold">Tank level, last 48 hours</h3>
              <LevelChart history={f.series.level} nowUnix={nowUnix} limits={limits} />
            </section>
            <section className="grid grid-cols-2 gap-6 px-5 pt-6 sm:grid-cols-3 sm:px-8">
              <Stat label="Water coming in" value={bpd(f.inflowBpd)} title="bpd = barrels per day" />
              <Stat label="Pump moving" value={bpd(f.pump.flowBpd)} />
              <Stat label="Reaching disposal" value={bpd(f.pipeline.receiveFlowBpd)} />
            </section>
            {boardFacility && <BoardSection board={boardFacility} source={boardSource} testWeights={boardTestWeights} software={boardSoftware} nowUnix={nowUnix} showTrend />}
            <WellsTable facility={f} highlight={[]} />
            <div className="h-8" />
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// What the board sees: model scores, alarm and history straight from board data (docs/live-api.md).
// Only numbers present in the board data are shown; nothing here is computed by the console.

const HEADS: { key: keyof BoardScores; label: string; over: "crit" | "warn" }[] = [
  { key: "pipeline_leak", label: "Pipeline leak", over: "warn" },
  { key: "pump_degradation", label: "Pump wearing out", over: "warn" },
  { key: "pump_failure", label: "Pump down", over: "crit" },
  { key: "facility_shut_in", label: "Shut in", over: "crit" },
];

/** Fewer readings than this and the scores are still warming up. */
const WARM_READINGS = 12;

const pct = (p: number) => Math.round(p * 100);

function alarmText(b: BoardFacility, nowUnix: number) {
  if (b.alarm === "none") return null;
  const at = b.alarmSinceUnix != null ? clockFrom(b.alarmSinceUnix, nowUnix) : null;
  if (b.alarm === "e_stop") {
    if (b.alarmState === "cleared") return `E-STOP cleared${at ? `, it was latched at ${at}` : ""}`;
    if (b.alarmState === "acknowledged") return `E-STOP latched${at ? ` at ${at}` : ""}, acknowledged`;
    return `E-STOP latched${at ? ` at ${at}` : ""}`;
  }
  if (b.alarmState === "cleared") return `Night Shift alarm cleared${at ? `, it was raised at ${at}` : ""}`;
  if (b.alarmState === "acknowledged") return `Night Shift alarm raised${at ? ` at ${at}` : ""}, acknowledged`;
  return `Night Shift alarm raised${at ? ` at ${at}` : ""}`;
}

function sourceText(b: BoardFacility, simulated: boolean, testWeights = false) {
  const over = b.overThreshold as string[];
  const s = b.scores;
  // The model's confidence in what it flagged: the highest score among heads over threshold.
  const flagged = s ? HEADS.filter((h) => over.includes(h.key)).map((h) => s[h.key]) : [];
  // A simulated feed is not model output, so it never says "Model N% sure".
  const top = flagged.length ? pct(Math.max(...flagged)) : null;
  const sure =
    top == null ? null : simulated ? `Simulated score ${top}%` : testWeights ? "Untrained test weights, scores not meaningful" : `Model ${top}% sure`;
  switch (b.source) {
    case "both":
      return sure ? `${sure}, rule and model agree` : "Rule and model agree";
    case "model":
      return sure ? `${sure}, raised by the model alone` : "Raised by the model alone";
    case "rule":
      return "Raised by the rule alone, the model did not cross its threshold";
    default:
      return "Neither the rule nor the model has raised anything here";
  }
}

function BoardSection({
  board: b,
  source,
  nowUnix,
  showTrend = false,
  onsetUnix,
  testWeights = false,
  software = false,
}: {
  board: BoardFacility;
  source?: "live" | "simulated";
  nowUnix: number;
  showTrend?: boolean;
  onsetUnix?: number;
  testWeights?: boolean;
  software?: boolean;
}) {
  const simulated = source === "simulated";
  const over = b.overThreshold as string[];
  const alarm = alarmText(b, nowUnix);
  const alarmActive = b.alarm !== "none" && b.alarmState !== "cleared";
  const trend = showTrend && b.degradationTrend && b.degradationTrend.t.length >= 2 ? b.degradationTrend : null;
  return (
    <section className="px-5 sm:px-8 pt-7" aria-label={simulated ? "What the board sees, simulated board" : "What the board sees"}>
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h3 className="font-display text-[16px] font-semibold">What the board sees</h3>
        {simulated && (
          <span className="rounded-full border border-warn-fill/50 bg-warn-fill/[0.12] px-2.5 py-0.5 text-[12.5px] font-semibold text-warn">
            Simulated board
          </span>
        )}
      </div>
      {simulated && (
        <p className="-mt-1.5 mb-3 text-[13px] text-muted-foreground">
          Development feed made from the console&apos;s own detections. These are not model scores.
        </p>
      )}
      {software && !simulated && (
        <p className="-mt-1.5 mb-3 text-[13px] text-muted-foreground">
          The board isn&apos;t connected, so the server&apos;s software copy of the board model produced these scores.
        </p>
      )}
      <div className="rounded-xl border border-line bg-white/60 px-4 py-4 shadow-[inset_0_0.5px_0_rgba(255,255,255,0.9)]">
        {alarm && (
          <p
            className={cn(
              "mb-3 flex items-center gap-2 text-[14px] font-semibold",
              !alarmActive ? "text-muted-foreground" : b.alarm === "e_stop" ? "text-crit" : "text-warn",
            )}
          >
            <span
              aria-hidden
              className={cn("size-2 shrink-0 rounded-full", !alarmActive ? "bg-faint" : b.alarm === "e_stop" ? "bg-crit" : "bg-warn-fill")}
            />
            {alarm}
          </p>
        )}
        {b.replayed && <p className="-mt-2 mb-3 pl-4 text-[13px] text-muted-foreground">Replayed from the board&apos;s buffer</p>}

        {b.scores ? (
          <ul className="flex flex-col gap-3">
            {HEADS.map((h) => {
              const p = pct(b.scores![h.key]);
              const isOver = over.includes(h.key);
              const tone = isOver ? (h.over === "crit" ? "crit" : "warn") : null;
              return (
                <li key={h.key}>
                  <div className="flex items-baseline justify-between gap-3 text-[14px]">
                    <span className={cn("min-w-0 text-text", isOver && "font-semibold")}>{h.label}</span>
                    <span className="flex shrink-0 items-baseline gap-2">
                      {tone && (
                        <span className={cn("text-[12.5px] font-semibold", tone === "crit" ? "text-crit" : "text-warn")}>Over threshold</span>
                      )}
                      <span className="num w-[3.2ch] text-right font-semibold text-text">{p}%</span>
                    </span>
                  </div>
                  <div
                    className="mt-1.5 h-[6px] overflow-hidden rounded-full bg-[var(--raised)]"
                    role="img"
                    aria-label={`${h.label} score ${p}%${isOver ? ", over threshold" : ""}`}
                  >
                    <div
                      className={cn("h-full rounded-full", tone === "crit" ? "bg-crit" : tone === "warn" ? "bg-warn-fill" : "bg-water")}
                      style={{ width: `${Math.max(p, p > 0 ? 1.5 : 0)}%` }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-[14px] text-muted-foreground">No model loaded on the board yet, so there are no scores.</p>
        )}

        <div className="mt-4 flex flex-col gap-1 border-t border-line-soft pt-3 text-[13px] text-muted-foreground">
          <p className="text-text">{sourceText(b, simulated, testWeights)}</p>
          <p>
            History behind these scores: <span className="num text-text">{b.sinceReset >= 255 ? "255 or more" : num(b.sinceReset)}</span>{" "}
            {b.sinceReset === 1 ? "reading" : "readings"}
            {b.sinceReset < WARM_READINGS && ". The scores are still warming up, so read them with care."}
          </p>
        </div>
      </div>

      {trend && (
        <div className="mt-5">
          <h3 className="mb-2 font-display text-[16px] font-semibold">Wear score trend</h3>
          <MiniChart
            t={trend.t}
            line={trend.v.map((v) => v * 100)}
            domain={[0, 100]}
            onsetUnix={onsetUnix}
            nowUnix={nowUnix}
            unit="%"
            label={`Wear score from ${pct(trend.v[0])}% to ${pct(trend.v[trend.v.length - 1])}% between ${clockFrom(trend.t[0], nowUnix)} and ${clockFrom(trend.t[trend.t.length - 1], nowUnix)}`}
          />
          <p className="mt-1 text-[13px] text-muted-foreground">
            The board&apos;s pump wearing out score over time. Higher means more wear.{simulated ? " Simulated board." : ""}
          </p>
        </div>
      )}
    </section>
  );
}
