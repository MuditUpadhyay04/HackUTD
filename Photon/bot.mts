// Throwaway Photon test bot for Beat the Shutdown. Nothing permanent: delete this folder to remove it.
// Text the project's line: "status" (default), "alerts", or "help". Replies come from the console's own API.
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

const CONSOLE = (process.env.CONSOLE_URL || "http://localhost:3100").replace(/\/$/, "");
const DATASET = process.env.DATASET?.trim() || "";
const q = DATASET ? `?dataset=${encodeURIComponent(DATASET)}` : "";

if (!process.env.SPECTRUM_PROJECT_ID || !process.env.SPECTRUM_PROJECT_SECRET) {
  console.error("Missing SPECTRUM_PROJECT_ID / SPECTRUM_PROJECT_SECRET in .env (copy them from Photon > Configure).");
  process.exit(1);
}

const HELP = [
  "Beat the Shutdown test line.",
  "status: the shift handoff note",
  "alerts: pumps down with countdown and plan, plus leaks",
  "help: this list",
].join("\n");

async function getJson(path: string) {
  const res = await fetch(`${CONSOLE}${path}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`console answered ${res.status}`);
  return res.json();
}

const label: Record<string, string> = {
  pump_failure: "Pump down",
  pipeline_leak: "Pipeline leak",
  pump_degradation: "Pump wearing out",
};
const fac = (id: string) => id.replace(/^([^_]+)_FACILITY_(.+)$/i, "$1 $2");
const hm = (h: number) => {
  const m = Math.max(0, Math.round(h * 60));
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
};

async function status() {
  const b = await getJson(`/api/brief${q}`);
  const who = b.source === "nemotron" ? `(written by ${b.model ?? "Nemotron"})` : "(draft from the plan solver)";
  return `${b.handoff}\n${who}`;
}

type Ev = {
  status: string;
  category: string;
  facility_id: string;
  hours_to_limit?: { p50: number } | null;
  est_cost?: number;
  recommended_actions?: { type: string; trucks?: number; wells?: string[]; start_after_min?: number }[];
};

async function alerts() {
  const events: Ev[] = await getJson(`/api/events${q}`);
  const open = events.filter((e) => e.status === "ongoing");
  if (!open.length) return "No open problems right now.";
  const order = (e: Ev) => (e.category === "pump_failure" ? (e.hours_to_limit?.p50 ?? 999) : 10_000);
  return open
    .sort((a, b) => order(a) - order(b))
    .slice(0, 6)
    .map((e) => {
      const head = `${label[e.category] ?? e.category} at ${fac(e.facility_id)}`;
      if (e.category !== "pump_failure") return `${head}: send an inspector.`;
      const h = e.hours_to_limit?.p50;
      const when = h == null ? "not filling" : h <= 0 ? "already shut in" : `shuts in in ${hm(h)}`;
      const cost = typeof e.est_cost === "number" ? `, about $${Math.round(e.est_cost).toLocaleString("en-US")}` : "";
      const acts = (e.recommended_actions ?? [])
        .map((a) =>
          a.type === "dispatch_truck"
            ? `send ${a.trucks} truck${(a.trucks ?? 1) > 1 ? "s" : ""}`
            : a.type === "shut_in_wells"
              ? `shut in ${(a.wells ?? []).map((w) => w.split("_").pop()).join(", ")}${a.start_after_min ? ` in ${hm(a.start_after_min / 60)}` : " now"}`
              : a.type === "none"
                ? "no action needed"
                : a.type,
        )
        .join(" + ");
      return `${head}: ${when}. Plan: ${acts || "none"}${cost}.`;
    })
    .join("\n\n");
}

const app = await Spectrum({ providers: [imessage.config()] });
console.log(`Bot running. Console: ${CONSOLE}${DATASET ? `, dataset ${DATASET}` : ""}. Text the line "help".`);

for await (const [space, message] of app.messages) {
  if (message.content.type !== "text") continue;
  const text = message.content.text.trim().toLowerCase();
  console.log(`[in] ${text.slice(0, 40)}`);
  let reply: string;
  try {
    reply = text.startsWith("help") ? HELP : text.startsWith("alert") ? await alerts() : await status();
  } catch (e) {
    reply = `The console isn't answering right now (${e instanceof Error ? e.message : "error"}).`;
  }
  await space.send(reply);
}
