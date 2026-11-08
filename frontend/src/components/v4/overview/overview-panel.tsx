"use client";
// Overview panel (docs/ui-v4-balance.md): the facts in plain English, pinned to the latest reading
// (snapshot.nowUnix), never the playhead, so it does not churn while the map and timeline animate.
import "./overview.css";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import NumberFlow from "@number-flow/react";
import type { Incident, Snapshot } from "@/lib/engine/types";
import { categoryLabel, clockFrom, duration, facilityName, facilityTitle, humanize, money, num, planText } from "@/lib/format";
import { useAnalysis } from "@/components/v4/arrangement/use-analysis";
import { provenanceOf } from "@/lib/v4/arrangement-notes";
import {
  DETECTION_NOTE, datasetLabel, detectionUnavailable, downSince, inspections, latestIncidents, missingFacilities,
  overviewHeadline, overviewStats, pumpCountdown, pumpFailures, readingStamp, savings, systemRows,
  type FirstShutdown, type PumpCountdown,
} from "@/lib/v4/overview";
import { StalePlanError, approvePlan, usePlayhead, usePlayheadActions, usePlayheadStore } from "@/lib/v4/store";

const canHover = () => typeof window !== "undefined" && window.matchMedia("(hover: hover) and (pointer: fine)").matches;

/** Digit runs roll on their own (same approach as the old ticker); screen readers get the plain text. */
function Rolling({ text }: { text: string }) {
  const parts = text.split(/(\d+)/).filter((p) => p !== "");
  return (
    <>
      <span aria-hidden="true">
        {parts.map((p, i) => /^\d+$/.test(p)
          ? <NumberFlow key={i} value={Number(p)} format={{ minimumIntegerDigits: p.length, useGrouping: false }} />
          : <span key={i}>{p}</span>)}
      </span>
      <span className="ov-sr">{text}</span>
    </>
  );
}

function Stat({ label, tone, children }: { label: string; tone?: "red"; children: React.ReactNode }) {
  return (
    <div className="ov-stat" data-tone={tone}>
      <span className="ov-stat-l">{label}</span>
      <span className="ov-stat-v">{children}</span>
    </div>
  );
}

const Unknown = () => <span className="ov-unknown">Unknown</span>;
const Money = ({ value }: { value: number | null }) => (value == null ? <Unknown /> : <NumberFlow value={Math.round(value)} prefix="$" format={{ maximumFractionDigits: 0 }} />);

function firstShutdownView(f: FirstShutdown, nowUnix: number) {
  if (f.kind === "clock") return <Rolling text={clockFrom(f.unix, nowUnix)} />;
  if (f.kind === "shut") return <>Shut in</>;
  if (f.kind === "none") return <>None</>;
  return <Unknown />;
}

/** Soft dithered p10 to p90 band under the countdown, with the p50 tick. Decorative; the text below says the same. */
function Band({ c, nowUnix }: { c: Extract<PumpCountdown, { kind: "counting" }>; nowUnix: number }) {
  const span = Math.max(1, (c.p90At - nowUnix) * 1.2);
  const pos = (u: number) => `${Math.min(100, Math.max(0, ((u - nowUnix) / span) * 100))}%`;
  const left = pos(c.p10At);
  const width = `${Math.max(2, parseFloat(pos(c.p90At)) - parseFloat(left))}%`;
  return (
    <div className="ov-band" aria-hidden="true">
      <i className="ov-band-fill dither-mask-50" style={{ left, width }} />
      <i className="ov-band-tick" style={{ left: pos(c.at) }} />
    </div>
  );
}

type Ack = "idle" | "pending" | "failed" | "stale";

function Approve({ incident, snapshot }: { incident: Incident; snapshot: Snapshot }) {
  const store = usePlayheadStore();
  const approved = usePlayhead((s) => s.approved.includes(incident.id));
  const [ack, setAck] = useState<Ack>("idle");
  useEffect(() => {
    if (ack !== "stale") return;
    const t = window.setTimeout(() => setAck("idle"), 4000);
    return () => window.clearTimeout(t);
  }, [ack]);
  if (!incident.plan) return null;
  if (approved) return <p className="ov-ack" role="status">Acknowledged, not dispatched</p>;
  const label = ack === "pending" ? "Acknowledging" : ack === "failed" ? "Not sent, retry" : ack === "stale" ? "Plan changed, refreshing" : "Approve";
  return (
    <button
      type="button"
      className="ov-btn press"
      data-state={ack}
      disabled={ack === "pending" || ack === "stale"}
      aria-label={`${label}: ${facilityName(incident.facilityId)}`}
      onClick={() => {
        setAck("pending");
        approvePlan(snapshot, store, incident.id).catch((e: unknown) => setAck(e instanceof StalePlanError ? "stale" : "failed"));
      }}
    >
      {label}
    </button>
  );
}

function useFocusHandlers(kind: "facility" | "system", id: string) {
  const { setFocus } = usePlayheadActions();
  const store = usePlayheadStore();
  return {
    onPointerEnter: () => { if (canHover()) setFocus({ kind, id }); },
    onPointerLeave: () => {
      const f = store.getState().focus;
      if (f && f.kind === kind && f.id === id) setFocus(null);
    },
  };
}

function PumpCard({ incident: a, snapshot }: { incident: Incident; snapshot: Snapshot }) {
  const now = snapshot.nowUnix;
  const cd = pumpCountdown(a, snapshot);
  const saved = savings(a);
  const dq = a.dataQuality && a.dataQuality.quality !== "VALID" ? a.dataQuality : undefined;
  const hover = useFocusHandlers("facility", a.facilityId);
  const urgent = cd.kind === "counting" && cd.hours < 2;
  const word = cd.kind === "shut_in" ? "Shut in" : cd.kind === "repair_first" ? "Repair first" : cd.kind === "not_filling" ? "Not filling" : "Unknown";
  return (
    <article className="ov-card" {...hover} aria-label={`${facilityTitle(a.facilityId)}, ${categoryLabel[a.category]}`}>
      <header className="ov-card-h">
        <h3>{facilityTitle(a.facilityId)}</h3>
        <span className="pill" data-tone="red"><i className="ov-dot" aria-hidden="true" />Pump down</span>
      </header>
      <p className="ov-sub">{downSince(a, now)}</p>

      <div className="ov-count" data-urgent={urgent || undefined}>
        {cd.kind === "counting" ? <span className="ov-count-v">{duration(cd.hours)}</span> : <span className="ov-count-w">{word}</span>}
      </div>
      <p className="ov-sub">
        {cd.kind === "counting" ? `until the tank reaches shutdown at ${clockFrom(cd.at, now)}`
          : cd.kind === "shut_in" ? "Wells are offline until the repair"
          : cd.kind === "repair_first" ? `Repair due ${clockFrom(cd.repairAt, now)}, before the tank fills`
          : cd.kind === "not_filling" ? "The tank is not filling"
          : "Not enough readings to estimate"}
      </p>
      {cd.kind === "counting" && (
        <>
          <Band c={cd} nowUnix={now} />
          <p className="ov-fine">Likely between {clockFrom(cd.p10At, now)} and {clockFrom(cd.p90At, now)}</p>
        </>
      )}
      {dq && <p className="ov-fine">{humanize(dq.reasons[0] ?? (dq.quality === "HELD" ? "Readings held" : "Readings missing"))}</p>}

      {a.plan ? (
        <div className="ov-plan">
          <div>
            <span className="ov-fine">Recommended</span>
            <p className="ov-plan-t">{planText(a.plan.label, now)}</p>
          </div>
          <p className="ov-plan-c">
            <span className="num">{money(a.plan.cost)}</span>
            {saved != null && <span className="ov-saves">saves {money(saved)} vs doing nothing</span>}
          </p>
        </div>
      ) : <p className="ov-fine">No plan available yet</p>}
      <Approve incident={a} snapshot={snapshot} />
    </article>
  );
}

function InspectRow({ incident: a }: { incident: Incident }) {
  const hover = useFocusHandlers("facility", a.facilityId);
  const est = a.estLeakBblPerDay != null ? `about ${num(a.estLeakBblPerDay)} bpd lost` : a.capacityLossPct != null ? `${num(a.capacityLossPct, 1)}% less water` : "";
  return (
    <li className="ov-row" {...hover}>
      <span className="pill" data-tone="magenta"><i className="ov-hatch" aria-hidden="true" />{a.category === "pipeline_leak" ? "Leak" : "Worn pump"}</span>
      <span className="ov-row-m">
        <b>{facilityName(a.facilityId)}</b> <span className="muted">{humanize(a.assetId)}</span>
      </span>
      {est && <span className="ov-row-r num">{est}</span>}
    </li>
  );
}

function SensorRow({ facility: f }: { facility: ReturnType<typeof missingFacilities>[number] }) {
  const hover = useFocusHandlers("facility", f.id);
  const reasons = f.dataQuality.reasons;
  const why = reasons[0] ? humanize(reasons[0]) : f.dataQuality.quality === "HELD" ? "Readings held" : f.dataQuality.quality === "INVALID" ? "Some readings unreadable" : "Sensor readings missing";
  return (
    <li className="ov-row" {...hover}>
      <span className="pill" data-tone="dither">No data</span>
      <span className="ov-row-m">
        <b>{facilityName(f.id)}</b> <span className="muted">{why}{reasons.length > 1 ? ` (+${reasons.length - 1} more)` : ""}</span>
      </span>
    </li>
  );
}

function SystemRowView({ row }: { row: ReturnType<typeof systemRows>[number] }) {
  const hover = useFocusHandlers("system", row.id);
  return (
    <li className="ov-sys" {...hover}>
      <span className="ov-sys-n"><i className="ov-sdot" data-tone={row.tone} aria-hidden="true" />{row.name}</span>
      <span className="ov-sys-w" data-tone={row.tone}>{row.word}</span>
      <span className="ov-sys-r num">{row.facilities} {row.facilities === 1 ? "facility" : "facilities"}</span>
      <span className="ov-sys-r num">{row.trucksFree} of {row.fleetSize} {row.fleetSize === 1 ? "truck" : "trucks"} free</span>
    </li>
  );
}

/** Three lines with a soft fade; "Read more" opens it over 200ms ease-out (instant when opened by keyboard). */
function Handoff({ runId }: { runId: string }) {
  const a = useAnalysis(runId);
  const text = a.record?.handoff.trim() ?? "";
  const body = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [instant, setInstant] = useState(false);
  const [heights, setHeights] = useState({ full: 0, short: 0 });
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const measure = () => {
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 21;
      setHeights({ full: el.scrollHeight, short: Math.round(lh * 3) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);
  const long = heights.full > heights.short + 2;
  const prov = a.record ? (provenanceOf(a.record) === "MODEL-WRITTEN" ? "Model written" : "Deterministic draft") : null;
  return (
    <section className="ov-sec" aria-label="Shift handoff">
      <div className="ov-sec-h">
        <h2>Shift handoff</h2>
        {prov && <span className="pill" data-tone={prov === "Model written" ? undefined : "dither"}>{prov}</span>}
      </div>
      {a.status === "loading" && <div className="ov-skel" aria-label="Reading the network"><i /><i /><i style={{ width: "62%" }} /></div>}
      {a.status === "error" && <p className="ov-sub">The handoff note is unavailable. Everything else still works.</p>}
      {a.status === "ready" && (
        <>
          <div
            className="ov-clamp"
            data-open={open}
            data-fade={long && !open}
            data-instant={instant}
            style={long ? { height: open ? heights.full : heights.short } : undefined}
          >
            <p ref={body} className="ov-handoff">{text || "No handoff note was written."}</p>
          </div>
          {long && (
            <button
              type="button"
              className="ov-more press"
              aria-expanded={open}
              onClick={(e) => { setInstant(e.detail === 0); setOpen((o) => !o); }}
            >
              {open ? "Show less" : "Read more"}
            </button>
          )}
          {a.record?.model && prov === "Model written" && <p className="ov-fine">Written by {a.record.model}</p>}
        </>
      )}
    </section>
  );
}

export function OverviewPanel({ snapshot }: { snapshot: Snapshot }) {
  const incidents = useMemo(() => latestIncidents(snapshot), [snapshot]);
  const failures = pumpFailures(incidents);
  const inspect = inspections(incidents);
  const missing = useMemo(() => missingFacilities(snapshot), [snapshot]);
  const stats = useMemo(() => overviewStats(snapshot), [snapshot]);
  const headline = useMemo(() => overviewHeadline(snapshot), [snapshot]);
  const offline = useMemo(() => detectionUnavailable(snapshot), [snapshot]);
  const systems = useMemo(() => systemRows(snapshot), [snapshot]);
  const label = datasetLabel(snapshot.dataset?.label);

  return (
    <aside className="ov" aria-label="Overview">
      <header className="ov-head">
        <h1>Water network</h1>
        <p className="ov-when">{readingStamp(snapshot.nowUnix)}</p>
        {label && <p className="ov-fine">{label}</p>}
        <p className="ov-lede">{headline}</p>
      </header>

      <div className="ov-stats">
        <Stat label="Pumps down" tone={stats.pumpsDown > 0 ? "red" : undefined}><NumberFlow value={stats.pumpsDown} format={{ useGrouping: false }} /></Stat>
        <Stat label="First shutdown" tone={stats.firstShutdown.kind === "clock" || stats.firstShutdown.kind === "shut" ? "red" : undefined}>{firstShutdownView(stats.firstShutdown, snapshot.nowUnix)}</Stat>
        <Stat label="Plan cost"><Money value={stats.planCost} /></Stat>
        <Stat label="If nobody acts"><Money value={stats.ifNobodyActs} /></Stat>
      </div>

      <hr className="ov-rule" />

      <section className="ov-sec" aria-label="Pumps down">
        <div className="ov-sec-h">
          <h2>Pumps down</h2>
          {failures.length > 1 && <span className="ov-fine">Soonest shutdown first</span>}
        </div>
        {failures.length ? (
          <div className="ov-cards">{failures.map((a) => <PumpCard key={a.id} incident={a} snapshot={snapshot} />)}</div>
        ) : (
          <p className="ov-sub">{missing.length ? "No pumps are reported down. Some facilities have no recent readings, see Check sensors." : "No pumps are down. Every tank is cycling normally."}</p>
        )}
      </section>

      <section className="ov-sec" aria-label="Send an inspector">
        <div className="ov-sec-h"><h2>Send an inspector</h2>{offline && inspect.length === 0 && <span className="ov-unavail">Unavailable</span>}</div>
        {inspect.length ? (
          <ul className="ov-list">{inspect.map((a) => <InspectRow key={a.id} incident={a} />)}</ul>
        ) : !offline ? <p className="ov-sub">Nothing needs an inspector.</p> : null}
      </section>

      {missing.length > 0 && (
        <section className="ov-sec" aria-label="Check sensors">
          <div className="ov-sec-h"><h2>Check sensors</h2><span className="ov-fine">Missing readings are never shown as healthy</span></div>
          <ul className="ov-list">{missing.map((f) => <SensorRow key={f.id} facility={f} />)}</ul>
        </section>
      )}

      {offline && (
        <p className="ov-note" role="note"><i className="ov-dot" aria-hidden="true" />{DETECTION_NOTE}</p>
      )}

      <section className="ov-sec" aria-label="Systems">
        <div className="ov-sec-h"><h2>Systems</h2></div>
        <ul className="ov-list">{systems.map((r) => <SystemRowView key={r.id} row={r} />)}</ul>
      </section>

      <Handoff runId={snapshot.runId} />
    </aside>
  );
}
