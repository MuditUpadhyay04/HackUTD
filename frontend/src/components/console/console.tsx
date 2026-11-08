"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { DatasetInfo, FleetState, Incident, Snapshot, SystemState } from "@/lib/engine/types";
import { clockFrom, countdownState, money, systemNum } from "@/lib/format";
import { InspectorRows, PumpCard, SensorRows, StatCard, SystemCard } from "./cards";
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
  const at = live ? undefined : s.nowUnix;
  const router = useRouter();
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
        : sys.facilities.some((f) => f.health === "no_data")
          ? "nodata"
          : "ok";

  const goSystem = (id: string) => {
    if (view === "handoff") setView(live ? "overview" : "replay");
    requestAnimationFrame(() => {
      document.getElementById(`system-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      setFlash(id);
      window.setTimeout(() => setFlash(null), 1400);
    });
  };

  // Summary numbers
  const states = failures.map((a) => countdownState(a, s.nowUnix));
  const next = states.find((c) => c.kind === "counting");
  const allShut = failures.length > 0 && states.every((c) => c.kind === "shut_in");
  const planCost = failures.reduce((t, a) => t + (a.plan?.cost ?? 0), 0);
  const nothingCost = failures.reduce((t, a) => t + (a.options?.find((o) => o.kind === "do_nothing")?.cost ?? 0), 0);

  const sysWithFailures = [...new Set(failures.map((a) => a.systemId))];
  const noData = facilities.filter((f) => f.health === "no_data");
  let headline: string;
  if (failures.length === 0) headline = noData.length ? "No pumps are reported down." : "Every pump is running.";
  else if (sysWithFailures.length === 1) {
    const sys = s.systems.find((x) => x.id === sysWithFailures[0]);
    headline =
      failures.length === 1
        ? `One pump in System ${systemNum(sysWithFailures[0])} is down.`
        : `${count(failures.length)} pumps in System ${systemNum(sysWithFailures[0])} are down and share ${count(sys?.fleetSize ?? 0).toLowerCase()} trucks.`;
  } else headline = `${count(failures.length)} pumps are down across ${count(sysWithFailures.length).toLowerCase()} systems.`;
  if (noData.length)
    headline += ` ${count(noData.length)} ${noData.length === 1 ? "facility has" : "facilities have"} no recent readings.`;
  if (inspections.length) headline += ` ${count(inspections.length)} ${inspections.length === 1 ? "problem needs" : "problems need"} an inspector.`;

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
        />
      }
    >
      <Toolbar
        datasets={datasets}
        current={s.dataset}
        replay={!live || view === "replay"}
        onReplay={(on) => onView(on ? "replay" : "overview")}
      />

      <main className="px-4 pt-7 pb-10 sm:px-7">
        <header>
          <h1 className="tracking-display font-display text-[30px] leading-tight font-bold sm:text-[34px]">
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
            <NemotronBrief dataset={s.dataset.id} at={at} expanded />
            <a
              href={`/api/events?dataset=${encodeURIComponent(s.dataset.id)}${at ? `&at=${at}` : ""}`}
              className="w-fit text-[14px] font-medium text-water hover:underline"
            >
              Download events.json
            </a>
          </div>
        ) : (
          <>
            <div className="mt-[22px] grid grid-cols-2 gap-3.5 xl:grid-cols-4">
              <StatCard label="Pumps down" value={String(failures.length)} tone={failures.length ? "crit" : undefined} />
              <StatCard
                label="First shutdown"
                value={next?.kind === "counting" ? clockFrom(next.at, s.nowUnix) : allShut ? "Shut in" : "None"}
                tone={next || allShut ? "crit" : undefined}
              />
              <StatCard label="Recommended plan" value={money(planCost)} />
              <StatCard label="If nobody acts" value={money(nothingCost)} />
            </div>

            <SectionTitle title="Pumps down" note={failures.length > 1 ? "Soonest shutdown first" : undefined} />
            {failures.length ? (
              <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2 xl:grid-cols-3">
                {failures.map((a) => (
                  <PumpCard key={a.id} incident={a} nowUnix={s.nowUnix} limits={s.limits} approvedAt={approvedAt(a.id)} onOpen={() => setIncident(a)} />
                ))}
              </div>
            ) : (
              <div className="glass px-5 py-4 text-[15px] text-muted-foreground">{noData.length ? "No pumps are reported down. Some facilities have no recent readings; see Check sensors." : "No pumps are down. Every tank is cycling normally."}</div>
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
                  onOpen={setIncident}
                  onTicket={(a) => setTickets((t) => ({ ...t, [a.id]: s.nowUnix }))}
                />
              </>
            )}

            <SectionTitle title="Network" note="Water from the wells, through each pump, to the disposal site" />
            <NetworkCard systems={s.systems} alerts={s.alerts} onFacility={(f) => setFacilityId(f.id)} />

            <SectionTitle title="Tanks" note={`Red line is shutdown at ${s.limits.shutdownPct}%`} />
            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
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
        incident={incident}
        facility={facilities.find((f) => f.id === incident?.facilityId)}
        nowUnix={s.nowUnix}
        limits={s.limits}
        approvedAt={incident ? approvedAt(incident.id) : undefined}
        onApprove={(a) => {
          setApproved((p) => ({ ...p, [a.id]: s.nowUnix }));
          setIncident(null);
        }}
        onClose={() => setIncident(null)}
      />
      <FacilitySheet
        facility={facilities.find((f) => f.id === facilityId) ?? null}
        incident={s.alerts.find((a) => a.facilityId === facilityId)}
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
    <h2 className="tracking-display mt-[34px] mb-3 flex items-baseline gap-2.5 font-display text-[20px] font-bold">
      {title}
      {note && <small className="text-[13px] font-normal tracking-normal text-faint">{note}</small>}
    </h2>
  );
}
