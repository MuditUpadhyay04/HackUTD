"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { BoardStatus, DatasetInfo, FleetState, Incident, OperatorAction, Snapshot, SystemState } from "@/lib/engine/types";
import { api, commandKey, unwrap } from "@/lib/api";
import { clockFrom, countdownState, money, systemNum } from "@/lib/format";
import { cn } from "@/lib/utils";
import { getBoard } from "@/lib/live/board";
import { boardFacility, InspectorRows, PumpCard, SensorRows, StatCard, SystemCard } from "./cards";
import { NetworkCard } from "./network";
import { Sidebar, Toolbar, Window, type SystemStatus, type View } from "./chrome";
import { FacilitySheet, IncidentSheet } from "./detail-sheets";
import { NemotronBrief } from "./nemotron";
import { Timeline } from "./timeline";

const longDay = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
const words = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
const count = (n: number) => words[n] ?? String(n);

function trucksFree(system: SystemState, fleet: FleetState | undefined, nowUnix: number) {
  const busy = new Set((fleet?.assignments ?? []).filter((a) => a.toUnix > nowUnix).map((a) => a.truck)).size;
  return Math.max(0, system.fleetSize - busy);
}

export function Console({ snapshot, datasets }: { snapshot: Snapshot; datasets: DatasetInfo[] }) {
  const s = snapshot;
  const live = s.nowUnix >= s.dataset.nowUnix;
  const router = useRouter();
  const params = useSearchParams();
  const [view, setView] = useState<View>(live ? "overview" : "replay");
  // Browser Back/Forward can move between live and past URLs without remounting: a past
  // snapshot must never sit under the "Now" overview.
  const [prevLive, setPrevLive] = useState(live);
  if (prevLive !== live) {
    setPrevLive(live);
    if (!live && view !== "handoff") setView("replay");
  }
  const [incident, setIncident] = useState<Incident | null>(null);
  const [facilityId, setFacilityId] = useState<string | null>(null);
  const [approved, setApproved] = useState<Record<string, number>>({});
  const [tickets, setTickets] = useState<Record<string, number>>({});
  const [flash, setFlash] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const adviceReady = s.recommendation.state === "ready" && s.recommendation.inputRevision === s.recommendation.currentRevision;
  const [board, setBoard] = useState<BoardStatus | null>(null);
  useEffect(() => {
    void getBoard(s).then((b) => setBoard(b ?? null));
  }, [s.runId, s.revision, s.nowUnix]);
  useEffect(() => {
    const abort = new AbortController();
    api.api.runs({ id: s.runId }).actions.get({ fetch: { signal: abort.signal } }).then(unwrap).then((actions) => {
      const current = actions.filter((a) => a.revision === s.revision);
      setApproved(Object.fromEntries(current.filter((a) => a.kind === "acknowledge_advice").map((a) => [a.incidentId, s.nowUnix])));
      setTickets(Object.fromEntries(current.filter((a) => a.kind === "inspection_ticket").map((a) => [a.incidentId, s.nowUnix])));
    }).catch((e: Error) => { if (!abort.signal.aborted) setActionError(e.message); });
    return () => abort.abort();
  }, [s.runId, s.revision, s.nowUnix]);
  async function act(a: Incident, kind: OperatorAction["kind"]) {
    if (!adviceReady || (kind === "acknowledge_advice" && (!a.plan || a.plan.inputRevision !== s.revision))) return;
    try {
      const keyName = `operator-action:${s.runId}:${s.revision}:${a.id}:${kind}`;
      let key = sessionStorage.getItem(keyName);
      if (!key) { key = commandKey(); sessionStorage.setItem(keyName, key); }
      unwrap(await api.api.runs({ id: s.runId }).actions.post({ incidentId: a.id, ...(kind === "acknowledge_advice" ? { planId: a.plan!.systemPlanId } : {}), revision: s.revision, kind }, { headers: { "idempotency-key": key } }));
      if (kind === "acknowledge_advice") setApproved((p) => ({ ...p, [a.id]: s.nowUnix }));
      else setTickets((p) => ({ ...p, [a.id]: s.nowUnix }));
      setActionError(""); setIncident(null);
    } catch (e) { setActionError(e instanceof Error ? e.message : "Action failed"); }
  }

  // Approvals and tickets only count at or after the replay time they were made.
  const approvedAt = (id: string) => (approved[id] !== undefined && approved[id] <= s.nowUnix ? approved[id] : undefined);
  const ticketsNow = Object.fromEntries(Object.entries(tickets).filter(([, t]) => t <= s.nowUnix));

  const facilities = s.systems.flatMap((x) => x.facilities);
  const currentIncident = incident ? s.alerts.find((a) => a.id === incident.id) ?? null : null;
  const failures = s.alerts.filter((a) => a.category === "pump_failure");
  const inspections = s.alerts.filter((a) => a.category !== "pump_failure");

  const statusOf = (sys: SystemState): SystemStatus =>
    failures.some((a) => a.systemId === sys.id)
      ? "crit"
      : inspections.some((a) => a.systemId === sys.id)
        ? "warn"
        : sys.facilities.some((f) => f.health === "no_data" || f.health === "unknown")
          ? "nodata"
          : "ok";

  const goSystem = (id: string) => {
    if (view === "handoff") setView(live ? "overview" : "replay");
    requestAnimationFrame(() => {
      document.getElementById(`system-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      setFlash(id);
      window.setTimeout(() => setFlash((f) => (f === id ? null : f)), 1400);
    });
  };

  // Keep the approved 5-across tank grid for up to 5 systems of up to 5 tanks; larger networks get 3 wider columns.
  const wideTanks = s.systems.length > 5 || s.systems.some((x) => x.facilities.length > 5);

  // Summary numbers
  const states = failures.map((a) => countdownState(a, s.nowUnix));
  const next = states.find((c) => c.kind === "counting");
  const allShut = failures.length > 0 && states.every((c) => c.kind === "shut_in");
  const planCost = failures.reduce((t, a) => t + (a.plan?.cost ?? 0), 0);
  const nothingCost = failures.reduce((t, a) => t + (a.options?.find((o) => o.kind === "do_nothing")?.cost ?? 0), 0);

  const sysWithFailures = [...new Set(failures.map((a) => a.systemId))];
  const noData = facilities.filter((f) => f.health === "no_data" || f.health === "unknown");
  let headline: string;
  if (failures.length === 0) headline = "No pumps are reported down.";
  else if (sysWithFailures.length === 1) {
    const fleet = s.systems.find((x) => x.id === sysWithFailures[0])?.fleetSize ?? 0;
    const fleetClause = fleet === 0 ? "have no emergency trucks" : `share ${fleet === 1 ? "one truck" : `${count(fleet).toLowerCase()} trucks`}`;
    headline =
      failures.length === 1
        ? `One pump in System ${systemNum(sysWithFailures[0])} is down.`
        : `${count(failures.length)} pumps in System ${systemNum(sysWithFailures[0])} are down and ${fleetClause}.`;
  } else headline = `${count(failures.length)} pumps are down across ${count(sysWithFailures.length).toLowerCase()} systems.`;
  if (noData.length)
    headline += ` ${count(noData.length)} ${noData.length === 1 ? "facility has" : "facilities have"} no recent readings.`;
  if (inspections.length) headline += ` ${count(inspections.length)} ${inspections.length === 1 ? "problem needs" : "problems need"} an inspector.`;

  const onView = (v: View) => {
    setView(v);
    if (v === "overview" && !live) {
      // Overview always means the latest reading.
      const q = new URLSearchParams(params.toString()); q.set("dataset", s.dataset.id); q.delete("at");
      router.push(`/?${q}`);
    }
  };

  return (
    <Window
      sidebar={
        <Sidebar
          view={view}
          onView={onView}
          systems={s.systems}
          statusOf={statusOf}
          alertCount={s.alerts.length}
          onSystem={goSystem}
        />
      }
    >
      <Toolbar
        datasets={datasets}
        current={s.dataset}
        replay={!live || view === "replay"}
        onReplay={(on) => onView(on ? "replay" : "overview")}
        atUnix={undefined}
        board={board}
      />

      <main className="px-4 pt-7 pb-10 sm:px-7">
        <div className="glass mb-4 px-4 py-3 text-[13px] text-muted-foreground" role="status">
          Runtime: requested {s.runtime.requested}, effective {s.runtime.effective}, {s.runtime.state}. {s.runtime.scoresAvailable ? `Model scores available${s.runtime.modelVersion ? ` (${s.runtime.modelVersion})` : ""}.` : "Model scores unavailable."} Coverage: {s.coverage.received} of {s.coverage.expected}. Recommendation: {s.recommendation.state}.
          {s.runtime.reasons.length > 0 && <span> {s.runtime.reasons.join("; ")}</span>}
          {!adviceReady && <span> Advice is not current; actions are disabled.</span>}
        </div>
        {actionError && <p role="alert" className="mb-3 text-crit">{actionError}</p>}
        <header>
          <h1 className="tracking-display font-display text-[30px] leading-[1.1] font-bold sm:text-[34px]">
            {view === "handoff" ? "Shift handoff" : "Avon water network"}
          </h1>
          <p className="mt-1.5 text-[15px] text-muted-foreground">
            {longDay.format(new Date(s.nowUnix * 1000))}, {clockFrom(s.nowUnix, s.nowUnix)} UTC.{" "}
            {view === "handoff" ? "What the next operator needs to know." : headline}
          </p>
        </header>

        {view === "replay" && (
          <div className="mt-5">
            <Timeline
              dataset={s.dataset.id}
              startUnix={s.dataset.startUnix}
              endUnix={s.dataset.nowUnix}
              atUnix={s.nowUnix}
              events={[...s.history, ...s.alerts]}
            />
          </div>
        )}

        {view === "handoff" ? (
          <div className="mt-6 grid max-w-[760px] gap-4">
            <NemotronBrief runId={s.runId} expanded />
            <a
              href={`/api/backend/api/runs/${encodeURIComponent(s.runId)}/export`}
              className="w-fit text-[14px] font-medium text-water hover:underline"
            >
              Download events.json
            </a>
          </div>
        ) : (
          <>
            {(() => { const b = board; return b && (b.mode === "AUTONOMOUS" || b.replayedAlerts > 0) && <BoardBanner board={b} nowUnix={s.nowUnix} />; })()}
            <div className="mt-[22px] grid grid-cols-2 gap-3.5 xl:grid-cols-4">
              <StatCard label="Pumps down" value={String(failures.length)} tone={failures.length ? "crit" : undefined} />
              <StatCard
                label="First shutdown"
                value={next?.kind === "counting" ? clockFrom(next.at, s.nowUnix) : allShut ? "At limit" : failures.length ? "Unknown" : "None"}
                tone={next || allShut ? "crit" : undefined}
              />
              <StatCard label="Recommended plan" value={failures.some((a) => !a.plan) || !adviceReady ? "Unavailable" : money(planCost)} />
              <StatCard label="If nobody acts" value={failures.some((a) => !a.options?.some((o) => o.kind === "do_nothing")) || !adviceReady ? "Unavailable" : money(nothingCost)} />
            </div>

            <SectionTitle title="Pumps down" note={failures.length > 1 ? "Soonest shutdown first" : undefined} />
            {failures.length ? (
              <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2 xl:grid-cols-3">
                {failures.map((a) => (
                  <PumpCard key={a.id} incident={a} nowUnix={s.nowUnix} limits={s.limits} approvedAt={approvedAt(a.id)} onOpen={() => setIncident(a)} board={s.board} />
                ))}
              </div>
            ) : (
              <div className="glass px-5 py-4 text-[15px] text-muted-foreground">No pumps are reported down.{noData.length ? " Some facilities have unknown or missing readings; see Check sensors." : ""}</div>
            )}

            {noData.length > 0 && (
              <>
                <SectionTitle title="Check sensors" note="Missing readings are never shown as healthy" />
                <SensorRows items={noData} onOpen={(f) => setFacilityId(f.id)} />
              </>
            )}

            {inspections.length > 0 && (
              <>
                <SectionTitle title="Send an inspector" />
                <InspectorRows
                  items={inspections}
                  tickets={ticketsNow}
                  disabled={!adviceReady}
                  onOpen={setIncident}
                  onTicket={(a) => void act(a, "inspection_ticket")}
                />
              </>
            )}

            <SectionTitle title="Network" note="Water from the wells, through each pump, to the disposal site. Flows in bpd (barrels per day)" />
            <NetworkCard systems={s.systems} alerts={s.alerts} onFacility={(f) => setFacilityId(f.id)} board={s.board} nowUnix={s.nowUnix} />

            <SectionTitle title="Tanks" note={`Red line is shutdown at ${s.limits.shutdownPct}%`} />
            <div className={cn("grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3", wideTanks ? "xl:grid-cols-3" : "xl:grid-cols-5")}>
              {s.systems.map((sys) => (
                <SystemCard
                  key={sys.id}
                  system={sys}
                  trucksFree={trucksFree(sys, s.fleets.find((f) => f.systemId === sys.id), s.nowUnix)}
                  limits={s.limits}
                  highlight={flash === sys.id}
                  onTank={(f) => setFacilityId(f.id)}
                />
              ))}
            </div>
          </>
        )}
      </main>

      <IncidentSheet
        incident={currentIncident}
        facility={facilities.find((f) => f.id === currentIncident?.facilityId)}
        nowUnix={s.nowUnix}
        limits={s.limits}
        approvedAt={currentIncident ? approvedAt(currentIncident.id) : undefined}
        disabled={!adviceReady || (!!currentIncident?.plan && currentIncident.plan.inputRevision !== s.revision)}
        onApprove={(a) => void act(a, "acknowledge_advice")}
        onClose={() => setIncident(null)}
      />
      <FacilitySheet
        facility={facilities.find((f) => f.id === facilityId) ?? null}
        incident={s.alerts.find((a) => a.facilityId === facilityId)}
        boardFacility={facilityId ? boardFacility(s.board, facilityId) : undefined}
        boardSource={s.board?.source}
        nowUnix={s.nowUnix}
        limits={s.limits}
        onClose={() => setFacilityId(null)}
        onOpenIncident={(a) => {
          setFacilityId(null);
          setIncident(a);
        }}
      />
    </Window>
  );
}

function SectionTitle({ title, note }: { title: string; note?: string }) {
  return (
    <h2 className="mt-[34px] tracking-[-0.015em] mb-3 flex items-baseline gap-2.5 font-display text-[20px] font-bold">
      {title}
      {note && <small className="text-[13px] font-normal tracking-normal text-faint">{note}</small>}
    </h2>
  );
}

/** One sentence when the board ran without the server or replayed buffered alerts. */
function BoardBanner({ board, nowUnix }: { board: BoardStatus | null; nowUnix: number }) {
  if (!board) return null;
  const own = board.mode === "AUTONOMOUS";
  const since = board.autonomousSinceUnix != null ? ` at ${clockFrom(board.autonomousSinceUnix, nowUnix)}` : "";
  const n = board.replayedAlerts;
  const alerts = `${n === 1 ? "1 alert was" : `${n} alerts were`} replayed`;
  const text = own
    ? `Board lost the server${since} and is watching on its own.${n > 0 ? ` ${alerts} from its buffer.` : ""}`
    : board.autonomousSinceUnix != null
      ? `Board lost the server${since} and kept watching. ${alerts} when it reconnected.`
      : `${alerts[0].toUpperCase()}${alerts.slice(1)} from the board when it reconnected.`;
  return (
    <div role="status" className="glass mt-5 flex flex-wrap items-center gap-x-2.5 gap-y-1 px-[18px] py-3 text-[14px]">
      <span className={cn("size-2 shrink-0 rounded-full", own ? "bg-warn-fill" : "bg-water")} aria-hidden />
      <span className="min-w-0 flex-1 basis-64">{text}</span>
      {board.source === "simulated" && <span className="text-[12.5px] font-medium text-warn">Simulated board</span>}
    </div>
  );
}
