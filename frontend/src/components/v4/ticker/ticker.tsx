"use client";
// STUB (Phase A). B3 replaces the body; keep the export signature.
import type { Snapshot } from "@/lib/engine/types";
import { tickerAt, tickerText } from "@/lib/v4/derive";
import { usePlayhead } from "@/lib/v4/store";

export function Ticker({ snapshot }: { snapshot: Snapshot }) {
  const items = usePlayhead((s) => tickerAt(snapshot, s.t));
  return (
    <div style={{ display: "flex", height: "100%", alignItems: "center", gap: 0, overflow: "hidden", whiteSpace: "nowrap" }}>
      {items.map((it) => (
        <div key={it.key} style={{ display: "flex", gap: 8, padding: "0 12px", borderRight: "1px solid var(--line-2)", alignItems: "baseline" }}>
          <span className="label">{it.label}</span>
          <span className={`mono ${it.value == null ? "dither-25" : ""}`} style={{ fontSize: "var(--fs-2)", fontWeight: 500 }}>{tickerText(it)}</span>
        </div>
      ))}
    </div>
  );
}
