"use client";
// STUB (Phase A). B3 replaces the body; keep the export signature. Renders one strip per system with an active
// pump failure at the playhead (the real component may render nothing when there are none).
import type { Snapshot } from "@/lib/engine/types";
import { incidentsAt } from "@/lib/v4/derive";
import { usePlayhead } from "@/lib/v4/store";

export function TruckRoad({ snapshot }: { snapshot: Snapshot }) {
  const key = usePlayhead((s) => [...new Set(incidentsAt(snapshot, s.t).filter((i) => i.category === "pump_failure").map((i) => i.systemId))].join(","));
  const ids = key ? key.split(",") : [];
  return (
    <>
      {ids.map((id) => (
        <div key={id} style={{ position: "relative", height: 64, borderBottom: "1px solid var(--line)" }}>
          <div className="stub"><span className="label">TRUCK ROAD STUB, SYSTEM {id}, PLANNED, NOT DISPATCHED</span></div>
        </div>
      ))}
    </>
  );
}
