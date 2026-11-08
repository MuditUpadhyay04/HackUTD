import { getSnapshot, listDatasets } from "@/lib/engine";
import type { DatasetInfo, Incident, Snapshot } from "@/lib/engine/types";
import { clock, clockFrom, countdownState, duration, facilityName, humanize, money, planText } from "@/lib/format";

// NVIDIA's hosted endpoint is OpenAI-compatible. Set NVIDIA_API_KEY to turn Nemotron on.
const NV_URL = process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1";
const MODEL = process.env.NEMOTRON_MODEL ?? "nvidia/llama-3.3-nemotron-super-49b-v1.5";

/** Every step below is written by this route from the plan solver's output, never by the model. */
const SOLVER = "plan solver";

type Step = { agent: string; model: string; text: string };

// Same count words as the console headline (console.tsx), so the brief says "Three pumps", not "3 pumps".
const words = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
const count = (n: number) => words[n] ?? String(n);

// Same order as the console's default (page.tsx): "test", then mock_test*, then the first dataset.
// TODO: switch to defaultDataset from "@/lib/engine" once the engine exports it.
function defaultDataset(datasets: DatasetInfo[]) {
  return datasets.find((d) => d.id === "test") ?? datasets.find((d) => d.id.startsWith("mock_test")) ?? datasets[0];
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const datasets = await listDatasets();
  const id = url.searchParams.get("dataset") ?? defaultDataset(datasets)?.id;
  if (!id || !datasets.some((d) => d.id === id)) {
    return Response.json({ error: `Unknown dataset "${id}"` }, { status: 404 });
  }
  const at = url.searchParams.get("at");
  const snap = await getSnapshot(id, at ? Number(at) : undefined);
  const draft = draftBrief(snap);

  const key = process.env.NVIDIA_API_KEY;
  if (!key) return Response.json({ source: "draft", ...draft });

  try {
    const res = await fetch(`${NV_URL}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        max_tokens: 350,
        messages: [
          {
            role: "system",
            content: [
              "/no_think You write the shift handoff for a night-shift water operator. 3 short sentences, plain English, no bullet points, no dashes.",
              "Use only the facts given; never invent numbers, times or IDs.",
              "countdown means: counting = the tank reaches shutdown in hours_to_shutdown hours; repair_first = the pump is repaired before the tank fills, so no shutdown; shut_in = the tank already hit shutdown and its wells are shut in; not_filling = the tank is not rising; unknown = no estimate.",
              "Plans are recommendations waiting for the operator. Never say a truck was sent, a plan was approved or a ticket was opened.",
              "If data_quality is HELD, say the readings are held from the last report; if DROPPED or INVALID, say the readings are missing. Mention facilities_without_data the same way.",
            ].join(" "),
          },
          { role: "user", content: JSON.stringify(facts(snap)) },
        ],
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new FallbackError(`http_${res.status}`);
    const data = await res.json();
    const text: string | undefined = data.choices?.[0]?.message?.content?.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    if (!text) throw new FallbackError("empty");
    // Nemotron wrote only the handoff. The steps stay attributed to the plan solver.
    return Response.json({ source: "nemotron", model: MODEL.split("/").pop(), steps: draft.steps, handoff: text });
  } catch (err) {
    const reason =
      err instanceof FallbackError
        ? err.message
        : err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")
          ? "timeout"
          : "error";
    console.error(`[brief] Nemotron failed (${reason}), using the solver draft:`, err);
    return Response.json({ source: "draft", fallback: true, fallbackReason: reason, ...draft });
  }
}

class FallbackError extends Error {}

/** Plain-English data-quality note for one alert, or null when its readings are VALID. */
function qualityNote(a: Incident): string | null {
  const q = a.dataQuality;
  if (!q || q.quality === "VALID") return null;
  const what = q.quality === "HELD" ? "readings are held from the last report" : "readings are missing";
  return `${facilityName(a.facilityId)} ${what}${q.reasons[0] ? ` (${q.reasons[0].replace(/\.$/, "")})` : ""}.`;
}

function noDataFacilities(s: Snapshot) {
  return s.systems.flatMap((sys) => sys.facilities).filter((f) => f.health === "no_data");
}

function facts(s: Snapshot) {
  return {
    now_utc: clock(s.nowUnix),
    ongoing: s.alerts.map((a) => {
      const cd = countdownState(a, s.nowUnix);
      const failure = a.category === "pump_failure";
      return {
        // Same names and clock times the operator sees on screen, so the note can't disagree with the cards.
        facility: facilityName(a.facilityId),
        asset: humanize(a.assetId),
        problem: a.category,
        countdown: failure ? cd.kind : null,
        hours_to_shutdown: failure && cd.kind === "counting" ? Math.round(cd.hours * 100) / 100 : null,
        shutdown_at_utc: failure && cd.kind === "counting" ? clockFrom(cd.at, s.nowUnix) : null,
        repair_done_utc: a.repairEndsUnix ? clockFrom(a.repairEndsUnix, s.nowUnix) : null,
        plan: a.plan ? planText(a.plan.label, s.nowUnix) : failure ? null : "send an inspector",
        plan_cost_usd: a.plan ? Math.round(a.plan.cost) : null,
        data_quality: a.dataQuality?.quality ?? "VALID",
        data_quality_reasons: a.dataQuality?.reasons ?? [],
      };
    }),
    facilities_without_data: noDataFacilities(s).map((f) => ({
      facility: facilityName(f.id),
      data_quality: f.dataQuality.quality,
      reasons: f.dataQuality.reasons.map(humanize),
    })),
  };
}

function draftBrief(s: Snapshot): { steps: Step[]; handoff: string } {
  const failures = s.alerts.filter((a) => a.category === "pump_failure");
  const insp = s.alerts.filter((a) => a.category !== "pump_failure");
  const shown = failures.slice(0, 3);
  const noData = noDataFacilities(s);
  const steps: Step[] = [];
  const m = SOLVER;

  steps.push({
    agent: "Orchestrator",
    model: m,
    text: s.alerts.length
      ? `Found ${failures.length} pump ${failures.length === 1 ? "failure" : "failures"} and ${insp.length} inspection ${insp.length === 1 ? "job" : "jobs"}.${
          failures.length > shown.length ? ` The steps below cover the first ${shown.length}.` : ""
        }`
      : noData.length
        ? `No open problems found, but ${noData.length} ${noData.length === 1 ? "facility has" : "facilities have"} no current readings.`
        : "Checked every facility. No open problems.",
  });
  for (const a of shown) {
    const plan = a.plan;
    const label = planText(plan?.label ?? "no plan", s.nowUnix);
    const cost = plan?.cost ?? 0;
    const cd = countdownState(a, s.nowUnix);
    let text = `${facilityName(a.facilityId)}: ${label}`;
    if (cd.kind !== "shut_in" && cost > 0) text += ` for ${money(cost)}`;
    if (cd.kind === "counting") text += `, ${duration(cd.hours)} before shutdown`;
    else if (cd.kind === "shut_in" && !/already shut in/i.test(label)) text += ", already shut in";
    else if (cd.kind === "repair_first" && !/^No action needed/i.test(label)) text += ", repaired before the tank fills";
    else if (cd.kind === "not_filling") text += ", tank not filling";
    text += ".";
    const q = qualityNote(a);
    if (q) text += ` ${q}`;
    steps.push({
      agent: (plan?.trucks ?? 0) > 0 ? "Fleet planner" : (plan?.shutIns.length ?? 0) > 0 ? "Well economist" : "Plan solver",
      model: m,
      text,
    });
  }
  if (insp.length) {
    steps.push({
      agent: "Inspection agent",
      model: m,
      text: `${count(insp.length)} ${insp.length === 1 ? "problem needs" : "problems need"} an inspector: ${insp.map((a) => humanize(a.assetId)).join(", ")}.`,
    });
  }

  const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  const quality: string[] = [];
  {
    const held = new Set<string>();
    const missing = new Set<string>();
    for (const a of s.alerts) {
      const q = a.dataQuality?.quality;
      if (q === "HELD") held.add(facilityName(a.facilityId));
      else if (q === "DROPPED" || q === "INVALID") missing.add(facilityName(a.facilityId));
    }
    for (const f of noData) {
      if (f.dataQuality.quality === "HELD") held.add(facilityName(f.id));
      else missing.add(facilityName(f.id));
    }
    for (const n of missing) held.delete(n);
    if (missing.size) quality.push(`Readings are missing at ${list([...missing])}, so check ${missing.size === 1 ? "it" : "them"} by hand.`);
    if (held.size) quality.push(`Readings at ${list([...held])} are held from the last report.`);
  }

  let handoff: string;
  if (!s.alerts.length) {
    handoff = noData.length
      ? `No open problems as of ${clock(s.nowUnix)} UTC. ${quality.join(" ")}`
      : `Quiet shift as of ${clock(s.nowUnix)} UTC. All tanks are cycling normally and no trucks are out.`;
  } else {
    const parts: string[] = [];
    if (failures.length) {
      const states = failures.map((a) => ({ a, cd: countdownState(a, s.nowUnix) }));
      const next = states.find((x) => x.cd.kind === "counting");
      const shut = states.filter((x) => x.cd.kind === "shut_in").map((x) => facilityName(x.a.facilityId));
      let line = `${count(failures.length)} ${failures.length === 1 ? "pump is" : "pumps are"} down.`;
      if (shut.length) line += ` ${shut.join(" and ")} ${shut.length === 1 ? "is" : "are"} already shut in.`;
      if (next && next.cd.kind === "counting")
        line += ` ${facilityName(next.a.facilityId)} is next to reach shutdown, at about ${clockFrom(next.cd.at, s.nowUnix)}.`;
      parts.push(line);
      const act = states.filter((x) => x.cd.kind === "counting" && (x.a.plan?.cost ?? 0) > 0).map((x) => x.a);
      const safe = states.filter((x) => x.cd.kind === "repair_first").map((x) => x.a);
      if (act.length)
        parts.push(
          `Plan: ${act.map((a) => `${facilityName(a.facilityId)}, ${planText(a.plan?.label ?? "", s.nowUnix).replace(/^./, (c) => c.toLowerCase())}`).join("; ")}.`,
        );
      if (safe.length)
        parts.push(`${list(safe.map((a) => facilityName(a.facilityId)))} will be repaired before ${safe.length === 1 ? "its tank fills" : "their tanks fill"}.`);
    }
    if (insp.length) parts.push(`Send ${insp.length === 1 ? "an inspector" : "inspectors"} to ${insp.map((a) => humanize(a.assetId)).join(" and ")}.`);
    parts.push(...quality);
    handoff = parts.join(" ");
  }
  return { steps, handoff };
}
