"use client";

import { Check, Truck } from "lucide-react";
import type { BoardFacility, BoardStatus, Category, FacilityState, Incident, PlanOption, SystemState } from "@/lib/engine/types";
import { categoryLabel, clockFrom, countdownState, facilityName, facilityTitle, humanize, money, num, planText, systemNum } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Limits } from "./tank";

export function StatCard({ label, value, tone }: { label: string; value: string; tone?: "crit" }) {
  return (
    <div className="glass px-[18px] py-4">
      <p className="text-[13px] text-muted-foreground">{label}</p>
      <p className={cn("tracking-display mt-1.5 font-display text-[28px] leading-[1.4] font-semibold", tone === "crit" && "text-crit")}>
        {value}
      </p>
    </div>
  );
}

/** Ring = how full the tank is on its way to the shutdown line. */
function Ring({ pct, shutdownPct, tone }: { pct: number; shutdownPct: number; tone: "crit" | "warn" }) {
  const c = 2 * Math.PI * 18;
  const raw = shutdownPct > 0 && Number.isFinite(pct) ? pct / shutdownPct : 0;
  const frac = Math.max(0.04, Math.min(1, raw));
  const color = tone === "crit" ? "#ff3b30" : "#ff9500";
  return (
    <svg className="size-11 shrink-0" viewBox="0 0 44 44" aria-hidden>
      <circle cx="22" cy="22" r="18" fill="none" stroke={color} strokeOpacity={0.16} strokeWidth="6" />
      <circle
        cx="22"
        cy="22"
        r="18"
        fill="none"
        stroke={color}
        strokeWidth="6"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - frac)}
        transform="rotate(-90 22 22)"
      />
    </svg>
  );
}

function Countdown({ hours, className }: { hours: number; className?: string }) {
  const total = Math.max(0, Math.round(hours * 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  const unit = "mr-[6px] ml-[2px] text-[22px] font-medium tracking-normal text-muted-foreground";
  return (
    <span className={cn("font-display text-[56px] leading-none font-semibold tracking-[-0.035em] tabular-nums", className)}>
      {h > 0 && (
        <>
          {h}
          <small className={unit}>h</small>
        </>
      )}
      {String(m).padStart(h > 0 ? 2 : 1, "0")}
      <small className={unit}>m</small>
    </span>
  );
}

/** Button wording follows what the plan actually asks the operator to do. */
function actionVerb(plan?: PlanOption) {
  return "Review plan";
}

export function PumpCard({
  incident: a,
  nowUnix,
  limits,
  approvedAt,
  onOpen,
  board,
}: {
  incident: Incident;
  nowUnix: number;
  limits: Limits;
  approvedAt?: number;
  onOpen: () => void;
  /** Live board data; undefined or null shows nothing extra. */
  board?: BoardStatus | null;
}) {
  const cd = countdownState(a, nowUnix);
  const urgent = cd.kind === "counting" && cd.hours < 2;
  const tone = cd.kind === "counting" && cd.hours < 3 ? "crit" : "warn";
  const doNothing = a.options?.find((o) => o.kind === "do_nothing");
  const saved = doNothing && a.plan ? doNothing.cost - a.plan.cost : 0;
  const level = a.levelPct;
  const dq = a.dataQuality && a.dataQuality.quality !== "VALID" ? a.dataQuality : undefined;

  return (
    <article className="glass flex flex-col px-5 py-[18px]">
      <button type="button" onClick={onOpen} className="-m-2 flex items-center gap-3 rounded-xl p-2 text-left transition-colors hover:bg-black/[0.03]">
        {level != null ? <Ring pct={level} shutdownPct={limits.shutdownPct} tone={tone} /> : <span className="w-11 text-center text-faint">?</span>}
        <span className="min-w-0">
          <span className="block text-[17px] font-semibold">{facilityTitle(a.facilityId)}</span>
          <span className="block text-[13px] text-faint">Pump down since {clockFrom(a.onsetUnix, nowUnix)}</span>
        </span>
      </button>

      <div className="mt-[18px]">
        {cd.kind === "counting" ? (
          <Countdown hours={cd.hours} className={urgent ? "text-crit" : undefined} />
        ) : (
          <span className="font-display text-[44px] leading-none font-semibold tracking-[-0.03em] text-muted-foreground">
            {cd.kind === "shut_in" ? "At limit" : cd.kind === "not_filling" ? "Not filling" : cd.kind === "repair_first" ? "Repair first" : "Unknown"}
          </span>
        )}
        <p className="mt-1.5 text-[13px] text-muted-foreground">
          {cd.kind === "counting"
            ? `until the tank reaches shutdown at ${clockFrom(cd.at, nowUnix)}`
            : cd.kind === "shut_in"
              ? "Tank is at the shutdown limit"
              : cd.kind === "repair_first"
                ? `Repair due ${clockFrom(cd.repairAt, nowUnix)}, before the tank fills`
                : cd.kind === "not_filling"
                  ? "The tank isn't filling"
                  : "Not enough readings to estimate"}
        </p>
        {dq && <p className="mt-0.5 text-[12.5px] text-faint">{dataQualityLine(dq)}</p>}
        {a.countdown && <p className="mt-0.5 text-[12.5px] text-faint">Estimate: {a.countdown.source}, {a.countdown.method}, {a.countdown.quality}</p>}
      </div>

      {a.plan && (
        <div className="mt-[18px] flex items-start gap-3 border-t-[0.5px] border-line pt-3.5">
          <p className="text-[14px] leading-snug font-medium">
            <span className="mb-0.5 block text-[12.5px] font-normal text-faint">Recommended</span>
            {planText(a.plan.label, nowUnix)}
          </p>
          <p className="ml-auto shrink-0 text-right text-[17px] font-semibold tabular-nums">
            {money(a.plan.cost)}
            {saved > 0 && <span className="block text-[12.5px] font-medium text-ok">saves {money(saved)}</span>}
          </p>
        </div>
      )}

      <div className="mt-auto pt-3.5">
        {approvedAt ? (
          <p className="flex items-center justify-center gap-1.5 rounded-[10px] bg-black/[0.04] py-[9px] text-[14px] font-medium text-ok">
            <Check className="size-4" aria-hidden /> Advice acknowledged
          </p>
        ) : (
          <button
            type="button"
            onClick={onOpen}
            aria-label={`${actionVerb(a.plan)} for ${facilityName(a.facilityId)}`}
            className="w-full rounded-[10px] bg-water py-[9px] text-[14px] font-semibold text-white shadow-[inset_0_0.5px_0_rgba(255,255,255,0.35),0_1px_2px_rgba(10,132,255,0.35)] transition-[transform,background-color] duration-100 hover:bg-water-deep active:scale-[0.98]"
          >
            {actionVerb(a.plan)}
          </button>
        )}
      </div>
    </article>
  );
}

function Drop({ className }: { className?: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" className={className} aria-hidden>
      <path d="M9 2.5c2.6 3.3 4.2 5.7 4.2 7.6a4.2 4.2 0 1 1-8.4 0C4.8 8.2 6.4 5.8 9 2.5z" fill="#ff9500" />
    </svg>
  );
}
function Gauge({ className }: { className?: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" className={className} aria-hidden>
      <path d="M3 12.5a6 6 0 1 1 12 0" fill="none" stroke="#ff9500" strokeWidth="2" strokeLinecap="round" />
      <path d="M9 12.5 11.5 8" stroke="#ff9500" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function InspectorRows({
  items,
  tickets,
  onOpen,
  onTicket,
  disabled,
}: {
  items: Incident[];
  tickets: Record<string, number>;
  onOpen: (a: Incident) => void;
  onTicket: (a: Incident) => void;
  disabled?: boolean;
}) {
  return (
    <div className="glass overflow-hidden">
      {items.map((a, i) => (
        <div
          key={a.id}
          className={cn(
            "grid grid-cols-[26px_1fr_auto] items-center gap-x-3 gap-y-0.5 px-[18px] py-[13px] text-[14px] sm:grid-cols-[26px_1.2fr_1fr_1fr_auto]",
            i > 0 && "border-t-[0.5px] border-line",
          )}
        >
          {a.category === "pipeline_leak" ? <Drop /> : <Gauge />}
          <button type="button" onClick={() => onOpen(a)} className="text-left font-semibold hover:underline">
            {categoryLabel[a.category]}
          </button>
          <span className="col-start-2 text-muted-foreground sm:col-start-auto">{humanize(a.assetId)}</span>
          <span className="col-start-2 text-muted-foreground tabular-nums sm:col-start-auto">
            {a.estLeakBblPerDay != null
              ? <>{num(a.estLeakBblPerDay)} <abbr title="barrels per day" className="no-underline">bpd</abbr> lost</>
              : a.capacityLossPct != null
                ? `${num(a.capacityLossPct, 1)}% less water`
                : ""}
          </span>
          <span className="col-start-3 row-span-3 row-start-1 self-center sm:col-start-auto sm:row-span-1 sm:row-start-auto">
            {tickets[a.id] ? (
              <span className="flex items-center gap-1 text-[13.5px] text-ok">
                <Check className="size-4" aria-hidden /> Ticket created
              </span>
            ) : (
              <button type="button" disabled={disabled} onClick={() => onTicket(a)} aria-label={`Create ticket for ${humanize(a.assetId)}`} className="font-medium text-water hover:underline disabled:opacity-50">
                Create ticket
              </button>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live board data. Shown only when the board sent it; never derived or invented here.

export function boardFacility(board: BoardStatus | null | undefined, facilityId: string): BoardFacility | undefined {
  return board?.facilities.find((f) => f.facilityId === facilityId);
}

/** Alarm wording and tone: "Night Shift alarm" (orange), "E-STOP latched" (red), cleared or acknowledged (grey). */
export function boardAlarm(f: BoardFacility | undefined, nowUnix: number) {
  if (!f || f.alarm === "none") return undefined;
  const night = f.alarm === "night_shift";
  const st = f.alarmState;
  const active = st === "raised" || st === null;
  const short = night
    ? st === "raised" || st === null ? "Night Shift alarm" : `Night Shift alarm ${st}`
    : st === "raised" ? "E-STOP latched" : st === null ? "E-STOP" : `E-STOP ${st}`;
  const at = f.alarmSinceUnix != null ? ` at ${clockFrom(f.alarmSinceUnix, nowUnix)}` : "";
  const long = night && st === "raised" ? `Night Shift alarm raised${at}` : `${short}${at}`;
  const tone: "crit" | "warn" | "off" = !active ? "off" : night ? "warn" : "crit";
  return { short, long, tone };
}

const sourceText = { both: "rule and model agree", model: "raised by the model", rule: "raised by a rule" } as const;

export function AlarmChip({ alarm, label }: { alarm: NonNullable<ReturnType<typeof boardAlarm>>; label?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-px text-[12px] font-semibold whitespace-nowrap",
        alarm.tone === "crit" ? "bg-crit/12 text-crit" : alarm.tone === "warn" ? "bg-warn-fill/15 text-warn" : "bg-black/[0.05] text-faint",
      )}
    >
      <span
        className={cn("size-1.5 rounded-full", alarm.tone === "crit" ? "bg-crit" : alarm.tone === "warn" ? "bg-warn-fill" : "bg-[#8e8e93]")}
        aria-hidden
      />
      {label ?? alarm.short}
    </span>
  );
}

/** One small line: alarm chip, "Model 98% sure, rule and model agree", "Replayed from the board". */
function BoardLine({
  board,
  facilityId,
  category,
  nowUnix,
  className,
}: {
  board?: BoardStatus | null;
  facilityId: string;
  category: Category;
  nowUnix: number;
  className?: string;
}) {
  const f = boardFacility(board, facilityId);
  if (!board || !f) return null;
  const alarm = boardAlarm(f, nowUnix);
  const score = f.scores ? f.scores[category] : undefined;
  const src = f.source !== "none" ? sourceText[f.source] : undefined;
  let text =
    score != null ? (board.source === "simulated" ? `Simulated score ${Math.round(score * 100)}%` : `Model ${Math.round(score * 100)}% sure`) : "";
  if (src) text = text ? `${text}, ${src}` : src[0].toUpperCase() + src.slice(1);
  if (!alarm && !text && !f.replayed) return null;
  return (
    <p className={cn("flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px] text-muted-foreground", className)}>
      {alarm && (
        <span title={alarm.long}>
          <AlarmChip alarm={alarm} />
          {alarm.long !== alarm.short && <span className="sr-only">, {alarm.long.slice(alarm.short.length).trim()}</span>}
        </span>
      )}
      {board.source === "simulated" && <span className="font-medium text-warn">Simulated board</span>}
      {text && <span>{text}</span>}
      {f.replayed && <span className="text-faint">Replayed from the board</span>}
    </p>
  );
}

function waterClass(f: FacilityState) {
  if (f.health === "failure") return "bg-[linear-gradient(180deg,#ff9f0a,#ff3b30)]";
  if (f.health === "leak" || f.health === "degradation") return "bg-[linear-gradient(180deg,#ffcc00,#ff9500)]";
  if (f.health === "shut_in" || f.health === "no_data" || f.health === "unknown") return "bg-[linear-gradient(180deg,#c7c7cc,#8e8e93)]";
  return "bg-[linear-gradient(180deg,#5ac8fa,#0a84ff)]";
}

export function SystemCard({
  system: s,
  trucksFree,
  limits,
  highlight,
  onTank,
}: {
  system: SystemState;
  trucksFree: number;
  limits: Limits;
  highlight?: boolean;
  onTank: (f: FacilityState) => void;
}) {
  // More than 4 tanks: tighter gaps and smaller text so the labels never run together (approved look keeps 4 or fewer).
  const dense = s.facilities.length > 4;
  return (
    <section
      id={`system-${s.id}`}
      aria-label={`System ${systemNum(s.id)}`}
      className={cn("glass scroll-mt-24 px-4 pt-4 pb-3.5 transition-shadow duration-300", highlight && "ring-2 ring-water/60")}
    >
      <div className="flex items-baseline justify-between gap-2">
        <b className="text-[15px] font-semibold whitespace-nowrap">System {systemNum(s.id)}</b>
        <span
          className={cn("flex items-center gap-1 text-[12px] whitespace-nowrap tabular-nums", trucksFree === 0 ? "text-crit" : "text-faint")}
          title="Proposed allocation, not a reservation or dispatch"
        >
          <Truck className="size-3.5" aria-hidden />
          {s.fleetSize - trucksFree} of {s.fleetSize} proposed
          <span className="sr-only">trucks</span>
        </span>
      </div>
      <div className={cn("mt-3.5 flex items-end", dense ? "gap-1" : "gap-2.5")}>
        {s.facilities.map((f) => {
          const noData = f.health === "no_data" || f.health === "unknown";
          const level = f.tank.levelPct;
          const known = level != null && Number.isFinite(level);
          const pct = known ? Math.round(level) : null;
          const label =
            f.health === "leak" ? "leak" : f.health === "degradation" ? "worn" : f.health === "shut_in" ? "shut in" : "";
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => onTank(f)}
              aria-label={`${facilityName(f.id)}, ${pct != null ? `tank ${pct} percent` : "tank level unknown"}${f.health !== "ok" ? `, ${f.health.replace("_", " ")}` : ""}`}
              className="group flex min-w-0 flex-1 flex-col items-center gap-1.5 rounded-xl p-1 transition-colors hover:bg-black/[0.04]"
            >
              <span className="relative block h-[92px] w-full max-w-10 overflow-hidden rounded-xl bg-[rgba(118,118,128,0.12)] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.06)]">
                <span
                  className={cn("absolute inset-x-0 bottom-0 transition-[height] duration-500 ease-out", waterClass(f))}
                  style={{ height: `${known ? Math.min(100, Math.max(0, level)) : 0}%` }}
                />
                <span className="absolute inset-x-0 h-[1.5px] bg-crit/90" style={{ top: `${100 - limits.shutdownPct}%` }} />
              </span>
              {noData ? (
                <span className={cn("leading-[22px] font-semibold whitespace-nowrap text-faint", dense ? "text-[11px]" : "text-[13px]")}>No data</span>
              ) : (
                <span className={cn("font-semibold tabular-nums", dense ? "text-[12px] leading-[22px]" : "text-[15px]", f.health === "failure" && "text-crit")}>
                  {pct != null ? `${pct}%` : "No data"}
                </span>
              )}
              {dense ? (
                <span className="-mt-1 flex max-w-full flex-col items-center text-[11px] leading-tight text-faint" title={label ? `${f.letter} ${label}` : undefined}>
                  <span>{f.letter}</span>
                  {label && <span className="max-w-full truncate">{label}</span>}
                </span>
              ) : (
                <span className="-mt-1 max-w-full truncate text-[11.5px] text-faint">
                  {f.letter}
                  {label && ` ${label}`}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** One short grey line about readings that were held or missing, e.g. "Readings held 10 min". */
function dataQualityLine(dq: NonNullable<Incident["dataQuality"]>) {
  if (dq.reasons[0]) return humanize(dq.reasons[0]);
  return dq.quality === "HELD" ? "Readings held" : dq.quality === "INVALID" ? "Some readings unreadable" : "Readings missing";
}

/** Facilities whose key sensors stopped reporting: never shown as healthy (team plan hard rule 9). */
export function SensorRows({ items, onOpen }: { items: FacilityState[]; onOpen: (f: FacilityState) => void }) {
  return (
    <div className="glass overflow-hidden">
      {items.map((f, i) => (
        <div
          key={f.id}
          className={cn(
            "grid grid-cols-[26px_1fr_auto] items-center gap-x-3 gap-y-0.5 px-[18px] py-[13px] text-[14px] sm:grid-cols-[26px_1.2fr_2fr_auto]",
            i > 0 && "border-t-[0.5px] border-line",
          )}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
            <circle cx="9" cy="9" r="7" fill="none" stroke="#8e8e93" strokeWidth="1.8" />
            <path d="M9 5.2v4.6" stroke="#8e8e93" strokeWidth="1.8" strokeLinecap="round" />
            <circle cx="9" cy="12.6" r="1.1" fill="#8e8e93" />
          </svg>
          <span className="font-semibold">{facilityTitle(f.id)}</span>
          <span className="col-start-2 text-muted-foreground sm:col-start-auto">
            {humanize(f.dataQuality.reasons[0] ?? "Sensor readings missing")}
            {f.dataQuality.reasons.length > 1 && ` (+${f.dataQuality.reasons.length - 1} more)`}
          </span>
          <button
            type="button"
            onClick={() => onOpen(f)}
            aria-label={`See readings for ${facilityName(f.id)}`}
            className="col-start-3 row-span-2 row-start-1 self-center font-medium text-water hover:underline sm:col-start-auto sm:row-span-1 sm:row-start-auto"
          >
            See readings
          </button>
        </div>
      ))}
    </div>
  );
}
