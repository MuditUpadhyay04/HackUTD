// Mono-friendly formatters for the v4 UI. No middle dots or em dashes in any string.
export { money, num, duration, minutes, clock, day, dayClock, clockFrom, systemNum, facilityName, assetName, facilityTitle, humanize, planText, categoryLabel } from "@/lib/format";

export const UNKNOWN = "UNKNOWN";

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const pad = (n: number) => String(n).padStart(2, "0");
const fin = (n: number | null | undefined): n is number => n != null && Number.isFinite(n);

/** "12:05" (UTC, nearest minute, same rounding as the rest of the app). */
export function hhmm(unix: number): string {
  const d = new Date(Math.round(unix / 60) * 60 * 1000);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
/** "OCT 08 12:00" */
export function stamp(unix: number): string {
  const d = new Date(Math.round(unix / 60) * 60 * 1000);
  return `${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
/** Remaining hours as a countdown "13:51" (h:mm) or "1d 02:10" past 24h. */
export function countdownText(hours: number | null | undefined): string {
  if (!fin(hours)) return UNKNOWN;
  const total = Math.max(0, Math.round(hours * 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h >= 24) return `${Math.floor(h / 24)}d ${pad(h % 24)}:${pad(m)}`;
  return `${pad(h)}:${pad(m)}`;
}
/** "$41,200"; null stays UNKNOWN, never "$0". */
export function usd(n: number | null | undefined): string {
  return fin(n) ? `$${Math.round(n).toLocaleString("en-US")}` : UNKNOWN;
}
/** "1,240 bpd" */
export function bpd(n: number | null | undefined): string {
  return fin(n) ? `${Math.round(n).toLocaleString("en-US")} bpd` : UNKNOWN;
}
/** "57.3%" */
export function pct(n: number | null | undefined, digits = 0): string {
  return fin(n) ? `${n.toFixed(digits)}%` : UNKNOWN;
}
/** "+5 min" / "-5 min" */
export function signedMin(min: number): string {
  return `${min > 0 ? "+" : min < 0 ? "-" : ""}${Math.abs(min)} min`;
}
