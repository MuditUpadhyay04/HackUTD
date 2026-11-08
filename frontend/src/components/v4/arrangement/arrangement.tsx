"use client";
// STUB (Phase A). B2 replaces the body; keep the export signature.
import type { Snapshot } from "@/lib/engine/types";

export function Arrangement({ snapshot }: { snapshot: Snapshot }) {
  return (
    <div className="stub">
      <span className="label">ARRANGEMENT STUB, {snapshot.alerts.length} ACTIVE, {snapshot.history.length} RESOLVED</span>
    </div>
  );
}
