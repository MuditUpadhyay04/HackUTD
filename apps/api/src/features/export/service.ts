import type { Snapshot } from "@hackutd/contracts";

export function exportEvents(snapshot: Snapshot) {
  return [...snapshot.alerts, ...snapshot.history].map(i => {
    const actions: Record<string, unknown>[] = [];
    if (i.category !== "pump_failure") actions.push({ type: "field_inspection", asset_id: i.assetId });
    else {
      if (i.plan?.trucks) actions.push({ type: "dispatch_truck", facility_id: i.facilityId, trucks: i.plan.trucks, trips_per_truck: i.plan.tripsPerTruck });
      for (const s of i.plan?.shutIns ?? []) actions.push({ type: "shut_in_wells", wells: [s.wellId], start_after_min: s.startAfterMin });
      if (!actions.length) actions.push({ type: "none" });
    }
    return { event_id: i.id, system_id: i.systemId, facility_id: i.facilityId, asset_id: i.assetId,
      category: i.category, status: i.status, onset_ts: new Date(i.onsetUnix * 1000).toISOString(), onset_unix: i.onsetUnix,
      end_ts: i.endUnix === null ? null : new Date(i.endUnix * 1000).toISOString(), end_unix: i.endUnix,
      ...(i.confidence === null ? {} : { confidence: i.confidence }), evidence: i.evidence, level_pct: i.levelPct,
      hours_to_limit: i.category === "pump_failure" && i.status === "ongoing" ? i.hoursToLimit ?? null : null,
      recommended_actions: actions, ...(i.plan ? { est_cost: i.plan.cost } : {}) };
  });
}
