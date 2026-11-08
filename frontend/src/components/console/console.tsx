"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { BoardStatus, DatasetInfo, FleetState, Incident, Snapshot, SystemState } from "@/lib/engine/types";
import { clockFrom, countdownState, money, systemNum } from "@/lib/format";
import { cn } from "@/lib/utils";
import { api, commandKey, unwrap } from "@/lib/api";
import { boardFacility } from "./cards";
import { NetworkCard } from "./network";
import { AlertsTable, KpiStrip, NetworkGraph } from "./ops-board";
import { isTestWeights } from "@/lib/live/board";
import { Sidebar, Toolbar, Window, type SystemStatus, type View } from "./chrome";
import { SimulationPanel } from "./simulation";
import { FacilitySheet, IncidentSheet } from "./detail-sheets";
import { NemotronBrief } from "./nemotron";
import { AgentsPanel, agentLines, useAgentRun } from "./agents";
import { Timeline } from "./timeline";
import { Rearrange } from "./rearrange";

const longDay = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
const words = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
const count = (n: number) => words[n] ?? String(n);

function trucksFree(system: SystemState, fleet: FleetState | undefined, nowUnix: number) {
  const busy = new Set((fleet?.assignments ?? []).filter((a) => a.toUnix > nowUnix).map((a) => a.truck)).size;
  return Math.max(0, system.fleetSize - busy);
}

export function Console({
  snapshot,
  datasets,
  followsBoard = false,
  controls,
  notice,
  onDismissNotice,
}: {
  /** One-line message from the workspace, e.g. a newly detected dataset. */
  notice?: string | null;
  onDismissNotice?: () => void;
  /** Runtime and dataset upload, shown at the bottom of the sidebar. */
  controls?: ReactNode;
  snapshot: Snapshot;
  datasets: DatasetInfo[];
  /** "Now" is the newest board timestamp (live board feed), so this is live, not a replay of the past. */
  followsBoard?: boolean;
}) {
  const s = snapshot;
  const live = followsBoard || s.nowUnix >= s.dataset.nowUnix;
  // Brief and export must describe the same moment the screen shows, including a board-driven "now".
  const at = s.nowUnix < s.dataset.nowUnix ? s.nowUnix : undefined;
  const router = useRouter();
  const [view, setView] = useState<View>(live ? "overview" : "replay");
  // Browser Back/Forward can move between live and past URLs without remounting: a past
  // snapshot must never sit under the "Now" overview.
  const [prevLive, setPrevLive] = useState(live);
  if (prevLive !== live) {
    setPrevLive(live);
    if (!live && view !== "handoff" && view !== "agents") setView("replay");
  }
  const [incident, setIncident] = useState<Incident | null>(null);
  const [facilityId, setFacilityId] = useState<string | null>(null);
  const [approved, setApproved] = useState<Record<string, number>>({});
  const [tickets, setTickets] = useState<Record<string, number>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const agents = useAgentRun(s.runId);
  const agentNote = agentLines(agents.run);
  const openIncident = (id: string) => {
    const a = [...s.alerts, ...s.history].find((x) => x.id === id);
    if (a) setIncident(a);
  };

  // Approvals and tickets are saved on the operator API against this run, so a reload keeps them.
  useEffect(() => {
    let live = true;
    api.api.runs({ id: s.runId }).actions.get().then((r) => {
      if (!live || r.error || !Array.isArray(r.data)) return;
      const ack: Record<string, number> = {}, tix: Record<string, number> = {};
      for (const a of r.data) (a.kind === "acknowledge_advice" ? ack : tix)[a.incidentId] = s.nowUnix;
      setApproved((p) => ({ ...ack, ...p }));
      setTickets((p) => ({ ...tix, ...p }));
    }).catch(() => {});
    return () => { live = false; };
  }, [s.runId, s.nowUnix]);

  const saveAction = async (a: Incident, kind: "acknowledge_advice" | "inspection_ticket") => {
    const set = kind === "acknowledge_advice" ? setApproved : setTickets;
    set((p) => ({ ...p, [a.id]: s.nowUnix }));
    setActionError(null);
    if (s.revision == null) return; // not from the operator API (no run to save against)
    try {
      unwrap(
        await api.api.runs({ id: s.runId }).actions.post(
          { incidentId: a.id, revision: s.revision, kind, ...(kind === "acknowledge_advice" && a.plan?.systemPlanId ? { planId: a.plan.systemPlanId } : {}) },
          { headers: { "idempotency-key": commandKey() } },
        ),
      );
    } catch (e) {
      set((p) => { const n = { ...p }; delete n[a.id]; return n; });
      setActionError(`${kind === "acknowledge_advice" ? "Couldn't save the approval" : "Couldn't create the ticket"}: ${e instanceof Error ? e.message : "server error"}`);
    }
  };

  // Approvals and tickets only count at or after the replay time they were made.
  const approvedAt = (id: string) => (approved[id] !== undefined && approved[id] <= s.nowUnix ? approved[id] : undefined);
  const ticketsNow = Object.fromEntries(Object.entries(tickets).filter(([, t]) => t <= s.nowUnix));

  const facilities = s.systems.flatMap((x) => x.facilities);
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
    if (view === "handoff" || view === "agents" || view === "simulation") setView(live ? "overview" : "replay");
    requestAnimationFrame(() => {
      document.getElementById(`pipes-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };


  // Summary numbers
  const states = failures.map((a) => countdownState(a, s.nowUnix));
  const next = states.find((c) => c.kind === "counting");
  const allShut = failures.length > 0 && states.every((c) => c.kind === "shut_in");
  // A failure without a costed plan makes the total unknown; it is never summed as $0 (hard rule 9).
  const sumKnown = (xs: (number | undefined)[]) => (xs.some((x) => x == null) ? undefined : xs.reduce<number>((t, x) => t + (x as number), 0));
  const planCost = sumKnown(failures.map((a) => a.plan?.cost));
  const nothingCost = sumKnown(failures.map((a) => a.options?.find((o) => o.kind === "do_nothing")?.cost));

  const sysWithFailures = [...new Set(failures.map((a) => a.systemId))];
  // "no_data" or bad readings = a sensor problem. "unknown" with good readings = the readings are fine but the
  // leak and wear checks could not run (no model loaded). Both stay grey, never healthy (hard rule 9),
  // but only the first one is a sensor problem.
  const noData = facilities.filter((f) => f.health === "no_data" || (f.health === "unknown" && f.dataQuality.quality !== "VALID"));
  const unchecked = facilities.filter((f) => f.health === "unknown" && f.dataQuality.quality === "VALID");
  let headline: string;
  if (failures.length === 0) headline = noData.length || unchecked.length ? "No pumps are reported down." : "Every pump is running.";
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
  if (unchecked.length)
    headline +=
      s.runtime && !s.runtime.scoresAvailable
        ? " Leak and wear checks are off because no model is loaded."
        : ` ${count(unchecked.length)} ${unchecked.length === 1 ? "facility hasn't" : "facilities haven't"} been checked for leaks or wear.`;

  const onView = (v: View) => {
    setView(v);
    if (v === "overview" && !live) {
      // Overview always means the latest reading.
      router.push(`/?dataset=${encodeURIComponent(s.dataset.id)}`);
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
          footer={controls}
          systemLine={(sys) => {
            const down = failures.filter((a) => a.systemId === sys.id);
            const inspect = inspections.filter((a) => a.systemId === sys.id).length;
            const free = trucksFree(sys, s.fleets.find((f) => f.systemId === sys.id), s.nowUnix);
            if (down.length) {
              const first = down.map((a) => countdownState(a, s.nowUnix)).find((c) => c.kind === "counting");
              return { text: `${down.length} down${first?.kind === "counting" ? ` · shuts ${clockFrom(first.at, s.nowUnix)}` : ""}`, tone: "crit" };
            }
            if (inspect) return { text: `${inspect} to inspect · ${free}/${sys.fleetSize} trucks`, tone: "warn" };
            if (sys.facilities.some((f) => noData.includes(f))) return { text: "Missing readings" };
            return { text: `Pumps running · ${free}/${sys.fleetSize} trucks` };
          }}
          status={[
            { label: "Last reading", value: clockFrom(s.nowUnix, s.nowUnix) },
            {
              label: "Checks run on",
              value:
                s.board?.online && s.board.provenance === "fpga"
                  ? "FPGA board"
                  : s.board?.online
                    ? "Software board"
                    : s.runtime?.effective === "fpga"
                      ? "FPGA board"
                      : "Server software",
              tone: s.board?.online ? ("ok" as const) : undefined,
            },
            ...(s.board
              ? [{ label: "Board", value: s.board.online ? `Live, ${s.board.lastSeenUnix != null ? clockFrom(s.board.lastSeenUnix, s.nowUnix) : "now"}` : "Quiet", tone: s.board.online ? ("ok" as const) : ("warn" as const) }]
              : []),
            ...(s.runtime ? [{ label: "Leak and wear model", value: s.runtime.scoresAvailable ? (s.runtime.modelVersion ? s.runtime.modelVersion.replace(/^weights v/i, "Weights v") : "Loaded") : "Not loaded", tone: s.runtime.scoresAvailable ? undefined : ("warn" as const) }] : []),
            {
              label: "Trucks free",
              value: `${s.systems.reduce((t, sys) => t + trucksFree(sys, s.fleets.find((f) => f.systemId === sys.id), s.nowUnix), 0)} of ${s.systems.reduce((t, sys) => t + sys.fleetSize, 0)}`,
            },
            {
              label: "Agents",
              value: agents.run?.status === "running" ? "Working…" : agents.run?.trace ? `${agents.run.trace.totals.accepted} of ${agents.run.trace.totals.nodes} accepted` : agents.run?.status === "failed" ? "Last run failed" : "Not run yet",
              tone: agents.run?.status === "failed" ? "crit" : undefined,
            },
          ]}
        />
      }
    >
      <Toolbar
        datasets={datasets}
        current={s.dataset}
        replay={!live || view === "replay"}
        onReplay={(on) => onView(on ? "replay" : "overview")}
        atUnix={at}
        board={s.board}
      />

      <main className="px-4 pt-7 pb-10 sm:px-7">
        <header>
          <h1 className="tracking-display font-display text-[30px] leading-[1.1] font-bold sm:text-[34px]">
            {view === "handoff" ? "Shift handoff" : view === "agents" ? "Agents" : view === "simulation" ? "Simulation" : "Avon water network"}
          </h1>
          <p className="mt-1.5 text-[15px] text-muted-foreground">
            {view !== "simulation" && <>{longDay.format(new Date(s.nowUnix * 1000))}, {clockFrom(s.nowUnix, s.nowUnix)} UTC.{" "}</>}
            {view === "handoff" ? "What the next operator needs to know." : view === "agents" ? "Chip detects. Server plans. Nemotron explains." : view === "simulation" ? "The week as it happens: failures, trucks, money kept, and the data path to the board and back." : headline}
          </p>
        </header>
        {notice && (
          <p role="status" className="glass mt-4 flex items-center justify-between gap-3 px-4 py-2.5 text-[13.5px]">
            <span>{notice}</span>
            {onDismissNotice && (
              <button type="button" onClick={onDismissNotice} className="text-[13px] font-medium text-water hover:underline">
                Dismiss
              </button>
            )}
          </p>
        )}

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

        {view === "simulation" ? (
          <SimulationPanel datasetId={s.dataset.id} />
        ) : view === "agents" ? (
          <AgentsPanel agents={agents} nowUnix={s.nowUnix} onOpenIncident={openIncident} />
        ) : view === "handoff" ? (
          <div className="mt-6 grid gap-4">
            <NemotronBrief runId={s.runId} expanded />
            <div>
              <a
                href={`/api/backend/api/runs/${encodeURIComponent(s.runId)}/export`}
                download="events.json"
                className="inline-flex items-center rounded-md bg-white px-3 py-1.5 text-[13px] font-medium text-water shadow-[0_0_0_0.5px_rgba(0,0,0,0.12),0_1px_2px_rgba(0,0,0,0.06)] hover:bg-[#f7f9fc]"
              >
                Download events.json
              </a>
            </div>
          </div>
        ) : (
          <>
            {s.board && (s.board.mode === "AUTONOMOUS" || s.board.replayedAlerts > 0) && <BoardBanner board={s.board} nowUnix={s.nowUnix} />}
            {actionError && (
              <p role="alert" className="glass mt-4 px-5 py-3 text-[14px] text-crit">
                {actionError}
              </p>
            )}
            {/* The overview's widgets: drag the arc in a widget's corner to put them in your own order. */}
            <Rearrange
              storageKey="bts-overview-order"
              className="mt-5 grid gap-4"
              widgets={[
                { id: "summary", label: "the summary", node: (
              <KpiStrip
                items={[
                  { label: "Pumps down", value: String(failures.length), tone: failures.length ? "crit" : undefined },
                  { label: "First shutdown", value: next?.kind === "counting" ? clockFrom(next.at, s.nowUnix) : allShut ? "Shut in" : "None", tone: next || allShut ? "crit" : undefined },
                  { label: "Recommended plan", value: planCost == null ? "Unknown" : money(planCost) },
                  { label: "If nobody acts", value: nothingCost == null ? "Unknown" : money(nothingCost) },
                ]}
              />
                ) },
                { id: "network", label: "the network", node: (
              <NetworkGraph
                systems={s.systems}
                alerts={s.alerts}
                nowUnix={s.nowUnix}
                trucksFree={(sys) => trucksFree(sys, s.fleets.find((f) => f.systemId === sys.id), s.nowUnix)}
                onFacility={(f) => setFacilityId(f.id)}
              />
                ) },
                { id: "alerts", label: "alerts", node: (
              <AlertsTable
                failures={failures}
                inspections={inspections}
                noData={noData}
                nowUnix={s.nowUnix}
                approvedAt={approvedAt}
                tickets={ticketsNow}
                onIncident={setIncident}
                onTicket={(a) => void saveAction(a, "inspection_ticket")}
                onFacility={(f) => setFacilityId(f.id)}
                agentNote={agentNote}
              />
                ) },
                { id: "pipelines", label: "pipelines", node: (
              <NetworkCard allSystems systems={s.systems} alerts={s.alerts} onFacility={(f) => setFacilityId(f.id)} board={s.board} nowUnix={s.nowUnix} />
                ) },
              ]}
            />
          </>
        )}
      </main>

      <IncidentSheet
        incident={incident}
        facility={facilities.find((f) => f.id === incident?.facilityId)}
        nowUnix={s.nowUnix}
        limits={s.limits}
        approvedAt={incident ? approvedAt(incident.id) : undefined}
        boardFacility={incident ? boardFacility(s.board, incident.facilityId) : undefined}
        boardSource={s.board?.source}
        boardTestWeights={isTestWeights(s.board?.weightsVersion)}
        boardSoftware={s.board?.provenance === "software"}
        onApprove={(a) => {
          void saveAction(a, "acknowledge_advice");
          setIncident(null);
        }}
        onClose={() => setIncident(null)}
      />
      <FacilitySheet
        facility={facilities.find((f) => f.id === facilityId) ?? null}
        incident={s.alerts.find((a) => a.facilityId === facilityId)}
        boardFacility={facilityId ? boardFacility(s.board, facilityId) : undefined}
        boardSource={s.board?.source}
        boardTestWeights={isTestWeights(s.board?.weightsVersion)}
        boardSoftware={s.board?.provenance === "software"}
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

/** One sentence when the board ran without the server or replayed buffered alerts. */
function BoardBanner({ board, nowUnix }: { board: BoardStatus; nowUnix: number }) {
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
