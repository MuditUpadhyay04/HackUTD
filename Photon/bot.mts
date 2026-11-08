// Beat the Shutdown on your phone (Photon / iMessage). Replies come from the operator API through console.mts.
// Text "help" for the commands. "subscribe" turns on a text whenever a new pump failure or inspection appears,
// including when a new dataset is uploaded. Advice only: nothing here approves or dispatches anything.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { CONSOLE_URL, alertText, command, ongoing, reply } from "./console.mts";

// Never let one failed send or file write take the line down.
process.on("unhandledRejection", (e) => console.error(`[unhandled] ${e instanceof Error ? e.message : String(e)}`));

if (!process.env.SPECTRUM_PROJECT_ID || !process.env.SPECTRUM_PROJECT_SECRET) {
  console.error("Missing SPECTRUM_PROJECT_ID / SPECTRUM_PROJECT_SECRET in .env (copy them from Photon > Configure).");
  process.exit(1);
}

const POLL_MS = Math.max(15, Number(process.env.POLL_SECONDS) || 60) * 1000;
const STORE = new URL("./.data/subscribers.json", import.meta.url);

// Who gets pushed alerts: conversations that texted "subscribe", plus ALERT_PHONES from .env (E.164, comma separated).
async function loadSubscribers(): Promise<Set<string>> {
  try { return new Set(JSON.parse(await readFile(STORE, "utf8")) as string[]); } catch { return new Set(); }
}
async function saveSubscribers(ids: Set<string>) {
  await mkdir(new URL("./.data/", import.meta.url), { recursive: true });
  await writeFile(STORE, JSON.stringify([...ids], null, 2));
}

const app = await Spectrum({ providers: [imessage.config()] });
const im = imessage(app);
const subscribers = await loadSubscribers();
for (const phone of (process.env.ALERT_PHONES ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
  try { subscribers.add((await im.space.create(phone)).id); } catch (e) { console.error(`Couldn't open a chat with an ALERT_PHONES number: ${(e as Error).message}`); }
}
console.log(`Bot running. ${subscribers.size} subscribed. Text the line "help".`);

// Pushed alerts: anything ongoing now that wasn't ongoing at the last check. The first check only records what's
// already open, so starting the bot never floods anyone.
let known: Set<string> | null = null;
async function check() {
  try {
    const { snapshot, keys } = await ongoing();
    const fresh = known ? [...keys].filter(([k]) => !known!.has(k)) : [];
    known = new Set(keys.keys());
    if (!fresh.length || !subscribers.size) return;
    // Pump failures first, soonest shutdown first (the order the console uses).
    fresh.sort(([, a], [, b]) => (a.category === "pump_failure" ? 0 : 1) - (b.category === "pump_failure" ? 0 : 1) || (a.countdown?.hours?.p50 ?? 999) - (b.countdown?.hours?.p50 ?? 999));
    const body = `New in ${snapshot.dataset.label}:\n${fresh.slice(0, 4).map(([, i]) => alertText(i, snapshot)).join("\n\n")}${fresh.length > 4 ? `\n\n+${fresh.length - 4} more. Text "alerts".` : ""}${CONSOLE_URL ? `\n${CONSOLE_URL}` : ""}`;
    for (const id of subscribers) {
      try { await (await im.space.get(id)).send(body); } catch (e) { console.error(`[push] ${(e as Error).message}`); }
    }
    console.log(`[push] ${fresh.length} new to ${subscribers.size}`);
  } catch (e) {
    console.error(`[check] ${(e as Error).message}`);
  }
}
void check();
setInterval(check, POLL_MS);

for await (const [space, message] of app.messages) {
  try {
    if (message.content.type !== "text") continue;
    const text = message.content.text.trim();
    const t = text.toLowerCase().replace(/[.!?]+$/, "");
    const group = (space as { type?: string }).type === "group";
    console.log(`[in] ${t.slice(0, 40)}`);
    let answer: string | null;
    if (t === "subscribe" || t === "start") {
      subscribers.add(space.id);
      await saveSubscribers(subscribers);
      answer = "Subscribed. I'll text you when a pump goes down or something needs an inspector. Text stop to end.";
    } else if (t === "stop" || t === "unsubscribe") {
      subscribers.delete(space.id);
      await saveSubscribers(subscribers);
      answer = "Stopped. No more alert texts. Text subscribe to turn them back on.";
    } else if (group && !command(text)) {
      answer = null; // group chats: only answer commands, not every message
    } else if (command(text) === "agents") {
      await space.send("Running the agents. This takes up to a minute…");
      answer = await reply(text);
    } else {
      answer = await reply(text);
    }
    if (answer) await space.send(answer);
  } catch (e) {
    console.error(`[in] ${(e as Error).message}`);
  }
}
