"use client";
// STUB (Phase A). B1 replaces the body; keep the export signature.
import type { Snapshot } from "@/lib/engine/types";

export function PipeView({ snapshot }: { snapshot: Snapshot }) {
  const n = snapshot.systems.reduce((s, x) => s + x.facilities.length, 0);
  return (
    <div className="stub">
      <span className="label">PIPE VIEW STUB, {snapshot.systems.length} SYSTEMS, {n} FACILITIES</span>
    </div>
  );
}
