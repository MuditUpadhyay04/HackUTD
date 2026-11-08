// Reads the operator API (apps/api) and turns it into short text messages. No Photon code here, so it can be
// tested without the phone line: `npm run check`.

const API = (process.env.API_URL || "http://127.0.0.1:3001").replace(/\/$/, "");
const TOKEN = process.env.API_TOKEN?.trim();
const RUNTIME = (["auto", "software", "fpga"] as const).find((r) => r === process.env.RUNTIME) ?? "auto";
export const CONSOLE_URL = process.env.CONSOLE_URL?.trim().replace(/\/$/, "") || "";

// ---------------------------------------------------------------------------------------------------------------
// API

async function call<T>(path: string, init: RequestInit = {}, timeoutMs = 15000): Promise<T> {
  const headers = new Headers(init.headers);
  if (TOKEN) headers.set("authorization", `Bearer ${TOKEN}`);
  if (init.body) headers.set("content-type", "application/json");
  const res = await fetch(`${API}/api${path}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    let why = `${res.status}`;
    try { const j = (await res.json()) as { error?: string }; if (j.error) why = j.error; } catch { /* not json */ }
    throw new Error(why);
  }
  return (await res.json()) as T;
}

type Dataset = { id: string; label: string; nowUnix: number; createdAt: string };
type Run = { id: string; status: "pending" | "running" | "ready" | "failed" | "cancelled"; error: string | null };
type Plan = { label: string; cost: number; kind: string };
export type Incident = {
  id: string; category: string; status: string; facilityId: string; systemId: string; onsetUnix: number;
  countdown?: { status: string; hours?: { p50: number } | null }; repairEndsUnix?: number; plan?: Plan; options?: Plan[];
};
export type Snapshot = {
  runId: string; revision: number; nowUnix: number; dataset: { id: string; label: string };
  alerts: Incident[]; systems: { id: string; fleetSize: number }[];
  runtime?: { scoresAvailable: boolean; effective: string };
};
type AgentRun = { id: string; status: "running" | "done" | "failed"; error: string | null; trace: { outputs?: { handoff?: { handoff: string } | null } } | null };

/** Same default as the console (frontend/src/lib/api.ts defaultDataset), so the phone and the screen agree:
 *  the newest upload labelled "test" (the judges' folder), then the mock test, then the first upload. */
export function pickDataset(list: Dataset[]): Dataset | undefined {
  const wanted = process.env.DATASET?.trim();
  if (wanted) return list.find((d) => d.id === wanted || d.label === wanted);
  const tests = list.filter((d) => d.id === "test" || d.label === "test").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return tests[0] ?? list.find((d) => d.id.startsWith("mock_test") || d.label.startsWith("mock_test")) ?? list[0];
}

const attempts = new Map<string, number>();

/** The current snapshot: the operator run for the chosen dataset (created once, then reused by idempotency key). */
export async function currentSnapshot(): Promise<Snapshot> {
  const datasets = await call<Dataset[]>("/datasets");
  const d = pickDataset(datasets);
  if (!d) throw new Error("no dataset uploaded yet");
  // One run per dataset, reused by idempotency key. A failed or cancelled run, or a conflict (e.g. the model changed),
  // would otherwise come back forever under the same key, so those move on to a fresh key once.
  const keyFor = () => `photon:${d.id}:${RUNTIME}:${attempts.get(d.id) ?? 0}`;
  const post = () => call<Run>("/runs", { method: "POST", body: JSON.stringify({ datasetId: d.id, runtime: RUNTIME }), headers: { "idempotency-key": keyFor() } });
  let run: Run;
  try { run = await post(); }
  catch (e) {
    if (!/409|conflict/i.test((e as Error).message)) throw e;
    attempts.set(d.id, (attempts.get(d.id) ?? 0) + 1);
    run = await post();
  }
  if (run.status === "failed" || run.status === "cancelled") {
    attempts.set(d.id, (attempts.get(d.id) ?? 0) + 1);
    run = await post();
  }
  for (let i = 0; run.status !== "ready" && i < 60; i++) {
    if (run.status === "failed" || run.status === "cancelled") {
      attempts.set(d.id, (attempts.get(d.id) ?? 0) + 1); // next text starts a fresh run
      throw new Error(run.error || `run ${run.status}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
    run = await call<Run>(`/runs/${encodeURIComponent(run.id)}`);
  }
  if (run.status !== "ready") throw new Error("the analysis is still running, try again in a minute");
  return call<Snapshot>(`/runs/${encodeURIComponent(run.id)}/snapshot`);
}

/** Newest agent run for this dataset, whether it was started from the console or by text. */
async function latestHandoff(s: Snapshot): Promise<{ text: string | null; running: boolean }> {
  const runs = await call<{ id: string; datasetId: string; status: string }[]>("/runs");
  const ids = new Set([s.runId, ...runs.filter((r) => r.datasetId === s.dataset.id && r.status === "ready").map((r) => r.id)]);
  const lists = await Promise.all([...ids].map((id) => call<{ id: string; status: string; startedAt?: string }[]>(`/runs/${encodeURIComponent(id)}/agent-runs`).catch(() => [])));
  const newest = lists.flat().sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")))[0];
  if (!newest) return { text: null, running: false };
  const run = await call<AgentRun>(`/agent-runs/${encodeURIComponent(newest.id)}`);
  return { text: run.trace?.outputs?.handoff?.handoff ?? null, running: run.status === "running" };
}

// ---------------------------------------------------------------------------------------------------------------
// Words (same wording as the console)

const fac = (id: string) => id.replace(/^([^_]+)_FACILITY_(.+)$/i, "$1 $2");
// Rounded to the nearest minute, like the console, so the phone and the screen show the same time.
const clock = (unix: number) => new Date(Math.round(unix / 60) * 60 * 1000).toISOString().slice(11, 16);
const hm = (hours: number) => {
  const m = Math.max(0, Math.round(hours * 60));
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
};
const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const label: Record<string, string> = { pump_failure: "pump down", pipeline_leak: "pipeline leak", pump_degradation: "pump wearing out", facility_shut_in: "facility shut in" };
/** "1 truck(s), 1 trip(s); shut in 2 well(s) after 40 min" -> "1 truck, 1 trip, shut in 2 wells at 16:10". */
function planWords(p: Plan, nowUnix: number) {
  if (p.kind === "do_nothing") return "no action";
  return p.label
    .replace(/(\d+) (truck|trip|well)\(s\)/g, (_m, n: string, w: string) => `${n} ${w}${n === "1" ? "" : "s"}`)
    .replace(/;\s*/g, ", ")
    .replace(/\bafter (\d+) min\b/g, (_m, min: string) => `at ${clock(nowUnix + Number(min) * 60)}`);
}
/** Prose from the agents can name raw ids; make them readable. */
const humanize = (t: string) => t.replace(/\b(S\d+)_(?:FACILITY|PUMP|TANK|PIPELINE)_([A-Z0-9]+)\b/g, "$1 $2").replace(/\bS(\d+)_WELL_([A-Z0-9]+)\b/g, "well $2");

function countdown(i: Incident, nowUnix: number) {
  const c = i.countdown;
  if (c?.status === "at_limit") return "already shut in";
  if (c?.status === "not_filling") return "tank not filling";
  const h = c?.status === "available" ? c.hours?.p50 : undefined;
  if (h == null || !Number.isFinite(h)) return "shutdown time unknown";
  if (h <= 0) return "already shut in";
  const at = nowUnix + h * 3600;
  if (i.repairEndsUnix && at >= i.repairEndsUnix) return `repair due ${clock(i.repairEndsUnix)}, before the tank fills`;
  return `tank shuts in at ${clock(at)} UTC (${hm(h)})`;
}

const failures = (s: Snapshot) => s.alerts.filter((a) => a.status === "ongoing" && a.category === "pump_failure");
const inspections = (s: Snapshot) => s.alerts.filter((a) => a.status === "ongoing" && a.category !== "pump_failure");

/** One alert as a text. Used by "alerts" and by the push when a new one appears. */
export function alertText(i: Incident, s: Snapshot) {
  const head = `${fac(i.facilityId)} ${label[i.category] ?? i.category.replace(/_/g, " ")}`;
  if (i.category !== "pump_failure") return `${head} since ${clock(i.onsetUnix)} UTC. Send an inspector.`;
  const nothing = i.options?.find((o) => o.kind === "do_nothing");
  const plan = !i.plan
    ? " No plan yet."
    : i.plan.kind === "do_nothing"
      ? ` Plan: do nothing; that is the cheapest option (${money(i.plan.cost)}).`
      : ` Plan: ${planWords(i.plan, s.nowUnix)}, ${money(i.plan.cost)}${nothing && nothing.cost > i.plan.cost ? ` (saves ${money(nothing.cost - i.plan.cost)})` : ""}.`;
  return `${head}: ${countdown(i, s.nowUnix)}.${plan}`;
}

export const HELP = [
  "Backpressure. Text:",
  "status: one-line summary",
  "alerts: pumps down and what to inspect",
  "handoff: the agents' note for the next shift",
  "agents: run the Nemotron agents now",
  "subscribe: text me when a pump goes down",
  "stop: no more texts",
].join("\n");

export async function statusText() {
  const s = await currentSnapshot();
  const f = failures(s), insp = inspections(s);
  const first = f
    .map((i) => (i.countdown?.status === "available" ? i.countdown.hours?.p50 : undefined))
    .filter((h): h is number => h != null && h > 0)
    .sort((a, b) => a - b)[0];
  const sum = (xs: (number | undefined)[]) => (xs.some((x) => x == null) ? null : xs.reduce<number>((t, x) => t + (x as number), 0));
  const plan = sum(f.map((i) => i.plan?.cost));
  const nothing = sum(f.map((i) => i.options?.find((o) => o.kind === "do_nothing")?.cost));
  const parts = [
    f.length ? `${f.length} ${f.length === 1 ? "pump is" : "pumps are"} down` : "No pumps are down",
    first != null ? `first tank shuts in at ${clock(s.nowUnix + first * 3600)} UTC (${hm(first)})` : null,
    f.length && plan != null ? `plan ${money(plan)}${nothing != null ? ` vs ${money(nothing)} if nobody acts` : ""}` : null,
    insp.length ? `${insp.length} to inspect` : null,
  ].filter(Boolean);
  const model = s.runtime && !s.runtime.scoresAvailable ? " Leak and wear checks are off (no model loaded)." : "";
  return `${s.dataset.label}, ${clock(s.nowUnix)} UTC: ${parts.join("; ")}.${model}${CONSOLE_URL ? `\n${CONSOLE_URL}` : ""}`;
}

export async function alertsText() {
  const s = await currentSnapshot();
  const list = [...failures(s), ...inspections(s)].slice(0, 8);
  return list.length ? list.map((i) => alertText(i, s)).join("\n\n") : "Nothing needs action right now.";
}

export async function handoffText() {
  const s = await currentSnapshot();
  const h = await latestHandoff(s);
  if (h.running) return "The agents are working on it. Text handoff again in a minute.";
  return h.text ? humanize(h.text) : 'No agent handoff yet. Text "agents" to run them.';
}

/** Starts the Nemotron agents and waits (up to ~2 min) for their handoff. */
export async function runAgentsText() {
  const s = await currentSnapshot();
  const started = await call<{ id: string; status: string }>(`/runs/${encodeURIComponent(s.runId)}/agents`, { method: "POST" });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const run = await call<AgentRun>(`/agent-runs/${encodeURIComponent(started.id)}`);
    if (run.status === "failed") return `The agents failed: ${run.error ?? "unknown error"}.`;
    if (run.status === "done") return run.trace?.outputs?.handoff?.handoff ? humanize(run.trace.outputs.handoff.handoff) : "The agents finished without a handoff.";
  }
  return 'The agents are still working. Text "handoff" in a minute.';
}

/** Ongoing incidents keyed by facility + category, so the same problem in a new run isn't texted twice. */
export async function ongoing(): Promise<{ snapshot: Snapshot; keys: Map<string, Incident> }> {
  const snapshot = await currentSnapshot();
  const keys = new Map<string, Incident>();
  for (const i of snapshot.alerts) if (i.status === "ongoing") keys.set(`${snapshot.dataset.id}:${i.facilityId}:${i.category}`, i);
  return { snapshot, keys };
}

/** Which command a text is, if any. */
export function command(text: string): "help" | "status" | "alerts" | "handoff" | "agents" | null {
  const t = text.trim().toLowerCase().replace(/[.!?]+$/, "");
  if (!t || t.startsWith("help") || t === "?") return "help";
  if (t.startsWith("status")) return "status";
  if (t.startsWith("alert")) return "alerts";
  if (t.startsWith("handoff") || t.startsWith("note")) return "handoff";
  if (t.startsWith("agent") || t === "run agents") return "agents";
  return null;
}

/** What to do with an incoming text. Anything that isn't a command gets the status (1:1 chats only; see bot.mts). */
export async function reply(text: string): Promise<string> {
  const cmd = command(text);
  try {
    if (cmd === "help") return HELP;
    if (cmd === "alerts") return await alertsText();
    if (cmd === "handoff") return await handoffText();
    if (cmd === "agents") return await runAgentsText();
    return await statusText();
  } catch (e) {
    return `The console isn't answering right now (${e instanceof Error ? e.message : "error"}).`;
  }
}

// `npm run check`: print every reply without the phone line.
if (process.argv.includes("--check")) {
  for (const cmd of ["help", "status", "alerts", "handoff"]) console.log(`> ${cmd}\n${await reply(cmd)}\n`);
  const { keys } = await ongoing();
  console.log(`> push would track ${keys.size} ongoing incidents`);
}
