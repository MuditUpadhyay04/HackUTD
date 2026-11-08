"use client";
import Link from "next/link";
import type { Snapshot } from "@/lib/engine/types";
import { systemStatusAt, type FacilityStatus } from "@/lib/v4/derive";
import { usePlayhead, usePlayheadActions } from "@/lib/v4/store";
import { systemNum } from "@/lib/v4/format";
import { pipeViewCommand } from "@/lib/v4/pipeview-camera";

const STATUS_TEXT: Record<FacilityStatus, string> = {
  flowing: "Flowing", idle: "Idle", down: "Pump down", leak: "Inspect, leak", worn: "Inspect, worn pump", shut: "Shut in", nodata: "No data",
};

const TONE: Record<FacilityStatus, string> = { flowing: "neutral", idle: "neutral", down: "red", leak: "magenta", worn: "magenta", shut: "red", nodata: "nodata" };
const SHORT: Record<FacilityStatus, string> = { flowing: "Flowing", idle: "Idle", down: "Pump down", leak: "Inspect", worn: "Inspect", shut: "Shut in", nodata: "No data" };

/** Status glyph: color AND shape (never color alone). */
export function StatusGlyph({ status, size = 12 }: { status: FacilityStatus; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 12 12", "aria-hidden": true } as const;
  switch (status) {
    case "down": // red filled triangle
      return <svg {...common}><path d="M6 1 11.5 11H.5z" fill="var(--red)" /></svg>;
    case "shut": // red filled square with bar
      return <svg {...common}><rect x="1" y="1" width="10" height="10" fill="var(--red)" /><rect x="3" y="5" width="6" height="2" fill="var(--bg)" /></svg>;
    case "leak":
    case "worn": // magenta hatched diamond
      return <svg {...common}><defs><pattern id="v4-gh" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="1.4" height="3" fill="var(--magenta)" /></pattern></defs><path d="M6 .5 11.5 6 6 11.5.5 6z" fill="url(#v4-gh)" stroke="var(--magenta)" strokeWidth="1" /></svg>;
    case "nodata": // dithered square
      return <svg {...common}><rect x=".5" y=".5" width="11" height="11" fill="none" stroke="var(--faint)" /><path d="M2 2h2v2H2zM6 2h2v2H6zM4 4h2v2H4zM8 4h2v2H8zM2 6h2v2H2zM6 6h2v2H6zM4 8h2v2H4zM8 8h2v2H8z" fill="var(--muted)" /></svg>;
    case "idle": // hollow circle
      return <svg {...common}><circle cx="6" cy="6" r="4.5" fill="none" stroke="var(--muted)" strokeWidth="1.5" /></svg>;
    default: // flowing: filled circle
      return <svg {...common}><circle cx="6" cy="6" r="4.5" fill="var(--text)" /></svg>;
  }
}

const iconProps = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

export function Rail({ snapshot, datasetId }: { snapshot: Snapshot; datasetId?: string }) {
  const keys = usePlayhead((s) => snapshot.systems.map((sys) => systemStatusAt(snapshot, sys, s.t, s.approved)).join(","));
  const focused = usePlayhead((s) => (s.focus?.kind === "system" ? s.focus.id : null));
  const { setFocus } = usePlayheadActions();
  const statuses = keys.split(",") as FacilityStatus[];
  const classic = datasetId ? `/classic?dataset=${encodeURIComponent(datasetId)}` : "/classic";
  return (
    <nav className="v4-rail" aria-label="Views and systems">
      <button type="button" className="rail-item press" data-active="true" aria-current="page" title="Pipe View">
        <svg {...iconProps}><path d="M3 6h6l3 6h9M3 18h8l2-3" /><circle cx="3" cy="6" r="1.5" /><circle cx="3" cy="18" r="1.5" /><circle cx="21" cy="12" r="2.5" /></svg>
        <span>Pipe</span>
      </button>
      <Link href={classic} className="rail-item press" title="Classic console (v3)">
        <svg {...iconProps}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M8 9v11" /></svg>
        <span>Classic</span>
      </Link>
      <Link href="/how-it-works" className="rail-item press" title="How it works">
        <svg {...iconProps}><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 1-1 1.7M12 17h.01" /></svg>
        <span>How</span>
      </Link>
      <div className="rail-sep" role="separator" />
      {snapshot.systems.map((sys, i) => {
        const st = statuses[i] ?? "nodata";
        return (
          <button
            key={sys.id}
            type="button"
            className="rail-sys press"
            data-active={focused === sys.id}
            style={{ color: focused === sys.id ? "var(--amber)" : "var(--text)" }}
            title={`System ${systemNum(sys.id)}: ${STATUS_TEXT[st]}`}
            aria-label={`System ${systemNum(sys.id)}, ${STATUS_TEXT[st]}`}
            onClick={() => {
              if (focused === sys.id) { setFocus(null); pipeViewCommand({ action: "fit" }); return; }
              setFocus({ kind: "system", id: sys.id });
              pipeViewCommand({ action: "frame", index: i + 1 });
            }}
          >
            <span className="rail-pill" data-tone={TONE[st]}>
              <StatusGlyph status={st} size={10} />
              <span>{sys.id}</span>
            </span>
            <span className="rail-st">{SHORT[st]}</span>
          </button>
        );
      })}
    </nav>
  );
}
