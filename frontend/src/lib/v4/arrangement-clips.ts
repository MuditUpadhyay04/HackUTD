// Clip extraction: incident spans and no-data spans per facility (pure).
import type { FacilityState, Incident, Quality, Snapshot } from "@/lib/engine/types";
import { seriesGaps, type Gap } from "./arrangement-paths";

export type ClipKind = "pump_failure" | "leak" | "degradation" | "shut_in" | "nodata";
export interface Clip {
  id: string;
  kind: ClipKind;
  start: number;
  end: number;
  label: string;
  incidentId: string | null;
  /** no-data clips only: drives dither density (HELD 25, INVALID 50, DROPPED 75). */
  quality?: Quality;
}

const KIND: Record<Incident["category"], { kind: ClipKind; label: string }> = {
  pump_failure: { kind: "pump_failure", label: "Pump down" },
  pipeline_leak: { kind: "leak", label: "Inspect leak" },
  pump_degradation: { kind: "degradation", label: "Inspect worn pump" },
  facility_shut_in: { kind: "shut_in", label: "Shut in" },
};

/** Union of overlapping or touching intervals, sorted. */
export function mergeGaps(gaps: readonly Gap[]): Gap[] {
  const sorted = [...gaps].sort((a, b) => a.t0 - b.t0);
  const out: Gap[] = [];
  for (const g of sorted) {
    const last = out[out.length - 1];
    if (last && g.t0 <= last.t1) last.t1 = Math.max(last.t1, g.t1);
    else out.push({ ...g });
  }
  return out;
}

/** Incident clips (alerts and history, onset to end or now) for one facility, onset order. */
export function incidentClips(snapshot: Snapshot, facilityId: string): Clip[] {
  const seen = new Set<string>();
  const out: Clip[] = [];
  for (const inc of [...snapshot.alerts, ...snapshot.history]) {
    if (inc.facilityId !== facilityId || seen.has(inc.id)) continue;
    seen.add(inc.id);
    const k = KIND[inc.category];
    out.push({ id: inc.id, kind: k.kind, start: inc.onsetUnix, end: inc.endUnix ?? snapshot.nowUnix, label: k.label, incidentId: inc.id });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * No-data spans: where the level or the pump flow (the key channels) has no usable sample, inside the loaded window.
 * Plus the final step when the snapshot itself reports HELD, INVALID or DROPPED for the facility.
 */
export function nodataClips(snapshot: Snapshot, facility: FacilityState, window: { start: number; end: number }): Clip[] {
  const gaps = mergeGaps([
    ...seriesGaps(facility.series.level, window),
    ...seriesGaps(facility.series.pumpFlow, window),
  ]);
  const out: Clip[] = gaps.map((g, i) => ({ id: `${facility.id}:nodata:${i}`, kind: "nodata", start: g.t0, end: g.t1, label: "No data", incidentId: null, quality: "DROPPED" }));
  const q = facility.dataQuality.quality;
  if (q !== "VALID") {
    const s = snapshot.nowUnix - 300;
    if (!out.some((c) => c.start <= s && c.end >= snapshot.nowUnix)) {
      out.push({ id: `${facility.id}:quality`, kind: "nodata", start: s, end: snapshot.nowUnix, label: q === "HELD" ? "Held" : q === "INVALID" ? "Invalid" : "No data", incidentId: null, quality: q });
    }
  }
  return out;
}

/** All clips of a facility: incidents then no-data spans. */
export function facilityClips(snapshot: Snapshot, facility: FacilityState, window: { start: number; end: number }): Clip[] {
  return [...incidentClips(snapshot, facility.id), ...nodataClips(snapshot, facility, window)];
}
