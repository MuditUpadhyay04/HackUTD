/**
 * Grounded prose checks shared by every agent role. Not a vocabulary list: numbers, identifiers and names in model
 * prose must come from the scoped facts, and completed physical actions are never claimed (global_plan.md rule 12).
 * lintProse is separate: it never rejects, it only scores readability (the prompt critic's targets).
 */
export interface Grounding {
  /** Exact IDs the prose may use (incidents, facilities, systems, assets, plans). */
  entities: string[];
  /** Enum-like labels (categories, statuses, plan kinds). */
  labels: string[];
  /** Incident categories present in scope, for category-word grounding. */
  categories: string[];
  /** Everything the agent was shown; numbers and tokens in it are grounded. */
  data: unknown;
}

// "Shut-in" is also a plan kind, so only a claim that something was or has been shut in or down is rejected.
const COMPLETED_ACTION = /\b(?:dispatched|deployed|sent|completed|repaired|fixed|resolved|activated|approved|executed)\b|\b(?:was|were|been|is|are|got|has|have|had)\s+(?:\w+\s+)?shut[\s-]+(?:down|in)\b/i;
/** Short all-caps words (FPGA, ID) are allowed mid-sentence; longer capitalized words must be snapshot names. */
const ACRONYM = /^[A-Z]{2,5}s?$/;
const TOKEN = /[\p{L}\p{N}]+(?:[_-][\p{L}\p{N}]+)*/gu;

function escapeRegExp(text: string) { return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function collect(data: unknown) {
  const numbers: number[] = [];
  const tokens = new Set<string>();
  const walk = (value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value)) numbers.push(value);
    else if (typeof value === "string") {
      for (const m of value.matchAll(/\d[\d,]*(?:\.\d+)?/g)) numbers.push(Number(m[0].replaceAll(",", "")));
      for (const m of value.matchAll(TOKEN)) tokens.add(m[0].toLowerCase());
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(data);
  return { numbers, tokens };
}

/** A number token is grounded if some fact rounds to it at the token's precision (85% may also be the fact 0.85). */
function groundedNumber(token: string, numbers: number[]): boolean {
  const percent = token.endsWith("%");
  const clean = token.replace(/[$%,]/g, "");
  const value = Number(clean);
  if (!Number.isFinite(value)) return false;
  const decimals = clean.includes(".") ? clean.split(".")[1]!.length : 0;
  const near = (x: number) => Math.abs(Number(x.toFixed(decimals)) - value) < 1e-9;
  return numbers.some((x) => near(x) || (percent && near(x * 100)));
}

/** Throws with a message naming what to fix; returns the trimmed prose. */
export function checkProse(ground: Grounding, input: unknown, options: { field?: string; maxLength?: number } = {}): string {
  const field = options.field ?? "text", max = options.maxLength ?? 1200;
  if (typeof input !== "string" || !input.trim() || input.length > max || /[\r\n<>`]/.test(input)) throw new Error(`Invalid ${field} prose: one paragraph, at most ${max} characters, no markdown or line breaks`);
  const claim = COMPLETED_ACTION.exec(input);
  if (claim) throw new Error(`Completed-action claim "${claim[0]}" in ${field}: remove that word; plans are advice and the operator decides (for an incident whose status is resolved, write "no longer active")`);
  const entities = new Set(ground.entities.filter(Boolean));
  const labels = new Set(ground.labels.filter(Boolean).map((l) => l.toLowerCase()));
  const { numbers, tokens } = collect(ground.data);
  const nameParts = new Set([...entities, ...labels, ...tokens].flatMap((e) => e.toLowerCase().split(/[^\p{L}\p{N}]+/u)).filter(Boolean));
  let text = input.trim();
  // Exact IDs may contain digits and separators; remove them before checking what is left.
  for (const entity of [...entities].sort((a, b) => b.length - a.length)) {
    text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeRegExp(entity)}(?![\\p{L}\\p{N}_-])`, "gu"), " ");
  }
  const lowerEntities = new Set([...entities].map((e) => e.toLowerCase()));
  for (const m of text.matchAll(TOKEN)) {
    const token = m[0], lower = token.toLowerCase();
    const idLike = token.includes("_") || (/\p{L}/u.test(token) && /\p{N}/u.test(token));
    if (idLike && !labels.has(lower) && !lowerEntities.has(lower) && !tokens.has(lower)) throw new Error(`Ungrounded identifier "${token}" in ${field}: use IDs and values exactly as the tools return them`);
  }
  for (const m of text.matchAll(/(?<![\p{L}\p{N}_])\$?\d[\d,]*(?:\.\d+)?%?/gu)) {
    const token = m[0].replace(/,$/, "");
    if (!groundedNumber(token, numbers)) throw new Error(`Ungrounded number "${token}" in ${field}: use only numbers from the tool results`);
  }
  for (const m of text.matchAll(/\b\p{Lu}[\p{L}]*\b/gu)) {
    const before = text.slice(0, m.index).trimEnd();
    if (!before || /[.!?:;]$/.test(before) || m[0] === "I" || ACRONYM.test(m[0]) || nameParts.has(m[0].toLowerCase())) continue;
    throw new Error(`Ungrounded name "${m[0]}" in ${field}: name only facilities, systems and assets from the snapshot`);
  }
  for (const category of ["leak", "failure", "degradation"] as const) {
    if (new RegExp(`\\b${category}s?\\b`, "i").test(text) && !ground.categories.some((c) => c.includes(category))) throw new Error(`Ungrounded incident category "${category}" in ${field}: no such incident in scope`);
  }
  return input.trim();
}

export interface ProseLint { rawTimes: number; ids: number; snakeLabels: number; chars: number }

/** Readability issues that pass grounding but hurt the operator: raw unix times, long IDs, snake_case labels. */
export function lintProse(text: string): ProseLint {
  return {
    rawTimes: (text.match(/\b1[5-9]\d{8}\b/g) ?? []).length,
    ids: (text.match(/\b(?:option|plan|run|analysis)[:-][0-9a-f-]{8,}|\b[0-9a-f]{16,}\b|:evidence:\d+/gi) ?? []).length,
    snakeLabels: (text.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []).length,
    chars: text.length,
  };
}
