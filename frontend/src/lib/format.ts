const usd0 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

export const money = (n: number) => usd0.format(Math.round(n));

export const num = (n: number | null, digits = 0) =>
  n == null || !Number.isFinite(n) ? "Unknown" : n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

/** 1.42 h -> "1h 25m"; 0.3 -> "18m" */
export function duration(hours: number) {
  if (!Number.isFinite(hours)) return "unknown";
  const total = Math.max(0, Math.round(hours * 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

export const minutes = (min: number) => duration(min / 60);

const dayFmt = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const timeFmt = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

/** Nearest whole minute: every clock in the app rounds the same way (never truncates seconds). */
const toMinute = (unix: number) => Math.round(unix / 60) * 60;
export const clock = (unix: number) => timeFmt.format(new Date(toMinute(unix) * 1000));
export const day = (unix: number) => dayFmt.format(new Date(unix * 1000));

/** "S13" or "s13" -> "13", for "System 13" labels. */
export const systemNum = (id: string) => id.replace(/^s/i, "");

/** "S2_FACILITY_B" -> "S2 B"; "S13_FACILITY_NORTH_RIDGE" -> "S13 NORTH_RIDGE" */
export function facilityName(id: string) {
  const m = /^([^_]+)_FACILITY_(.+)$/i.exec(id);
  if (m) return `${m[1].toUpperCase()} ${m[2]}`;
  const [sys, , rest] = id.split("_");
  return `${sys} ${rest ?? ""}`.trim();
}
export function assetName(id: string) {
  const parts = id.split("_");
  if (parts.length < 3) return id;
  const kind = parts[1].toLowerCase();
  return `${kind[0].toUpperCase()}${kind.slice(1)} ${parts.slice(2).join(" ")}`;
}

export const categoryLabel = {
  pump_failure: "Pump down",
  pipeline_leak: "Pipeline leak",
  pump_degradation: "Pump wearing out",
  facility_shut_in: "Facility shut in",
} as const;

/**
 * Make engine text readable for anyone: "Shut in well S2_WELL_C1" -> "Shut in well C1",
 * "Pump S2_PUMP_C reporting" -> "Pump C reporting", bare "S5_PIPELINE_B" -> "S5 pipeline B".
 */
export function humanize(text: string) {
  return text.replace(/\s+—\s+/g, ", ").replace(
    /\b(wells? |pumps? |pipelines? |tanks? )?(S\d+)_(WELL|PUMP|PIPELINE|TANK|FACILITY)_([A-Za-z0-9]+(?:_[A-Za-z0-9]+)*)\b/gi,
    (_m, prefix: string | undefined, sys: string, kind: string, code: string) =>
      prefix ? `${prefix}${code}` : `${sys} ${kind.toLowerCase()} ${code}`,
    )
    // "wells A1, S1 well A2" -> "wells A1, A2"
    .replace(/(\b(?:wells|pumps|pipelines|tanks) [A-Za-z0-9_]+)((?:, (?:and )?S\d+ (?:well|pump|pipeline|tank) [A-Za-z0-9_]+)+)/gi, (_m, head: string, rest: string) =>
      head + rest.replace(/S\d+ (?:well|pump|pipeline|tank) /gi, ""),
    );
}

const shortDay = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" });
/** "Tue 12:15", for axes that span more than a day. */
export const dayClock = (unix: number) => `${shortDay.format(new Date(toMinute(unix) * 1000))} ${clock(unix)}`;

/** Clock time, with the weekday added when it isn't the same day as `ref`. */
export function clockFrom(unix: number, ref: number) {
  const sameDay = Math.floor(toMinute(unix) / 86400) === Math.floor(ref / 86400);
  return sameDay ? clock(unix) : dayClock(unix);
}

/** Interpret a failure's countdown: is the tank really heading for shutdown before the repair? */
export function countdownState(a: { countdown?: import("@hackutd/contracts").CountdownState; repairEndsUnix?: number }, nowUnix: number) {
  const status = a.countdown?.status;
  if (status === "not_filling") return { kind: "not_filling" as const };
  if (status === "at_limit") return { kind: "shut_in" as const };
  if (status !== "available") return { kind: "unknown" as const };
  const h = a.countdown?.hours?.p50;
  if (h == null || !Number.isFinite(h)) return { kind: "unknown" as const };
  if (h <= 0) return { kind: "shut_in" as const };
  const at = nowUnix + h * 3600;
  if (a.repairEndsUnix && at >= a.repairEndsUnix) return { kind: "repair_first" as const, at, repairAt: a.repairEndsUnix };
  return { kind: "counting" as const, hours: h, at };
}

/** Plan text as an operator reads it: "Send 1 truck now, shut in well A2 at 13:51". */
export function planText(label: string, nowUnix: number) {
  return humanize(label)
    .replace(/\s\+\s/g, ", ")
    .replace(/\bin (?:(\d+)h\s?)?(\d+)m\b/g, (_m, h: string | undefined, m: string) =>
      `at ${clockFrom(nowUnix + (Number(h ?? 0) * 60 + Number(m)) * 60, nowUnix)}`,
    );
}

/** Naming rule (one name per thing): titles use facilityTitle ("S4, Facility A"); sentences, lists and
 *  compact labels use facilityName ("S4 A"); assets use humanize ("S4 pump A", "well A2"). */
export function facilityTitle(id: string) {
  return facilityName(id).replace(" ", ", Facility ");
}
