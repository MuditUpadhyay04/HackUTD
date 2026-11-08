// Pure helpers for the Nemotron annotation track (hard rules 12 and 13: say what is model-written and what is a draft).
import type { AnalysisRecord } from "@hackutd/contracts";

export type Provenance = "MODEL-WRITTEN" | "DETERMINISTIC DRAFT";

/**
 * AnalysisRecord.source: "nemotron" = Nemotron coordinator, "ai-sdk" = fallback runtime (a model, named in `model`),
 * "draft" = deterministic text from the plan solver. Anything unclear is a draft.
 */
export function provenanceOf(r: Pick<AnalysisRecord, "source" | "model" | "state">): Provenance {
  if (r.state !== "completed") return "DETERMINISTIC DRAFT";
  if (r.source === "nemotron") return "MODEL-WRITTEN";
  if (r.source === "ai-sdk" && r.model) return "MODEL-WRITTEN";
  return "DETERMINISTIC DRAFT";
}

/** "PLANNER_AGENT" or "planner" to "Planner agent": sentence case for display. */
export function sentenceCase(s: string): string {
  const t = s.replace(/[_-]+/g, " ").trim().toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export interface NoteStep { agent: string; model: string; text: string }
export interface NoteView {
  id: string;
  /** Unix seconds the note is pinned to. The record carries no time, so this is snapshot.nowUnix. */
  unix: number;
  title: string;
  text: string;
  provenance: Provenance;
  model: string | null;
  steps: NoteStep[];
}

/** The handoff note, then one note per agent step. Empty until the analysis is completed. */
export function notesFromAnalysis(r: AnalysisRecord | null | undefined, nowUnix: number): NoteView[] {
  if (!r || r.state !== "completed") return [];
  const provenance = provenanceOf(r);
  const model = r.model ?? null;
  const out: NoteView[] = [];
  if (r.handoff.trim()) out.push({ id: `${r.id}:handoff`, unix: nowUnix, title: "Handoff", text: r.handoff, provenance, model, steps: r.steps });
  r.steps.forEach((s, i) => {
    if (s.text.trim()) out.push({ id: `${r.id}:step${i}`, unix: nowUnix, title: sentenceCase(s.agent), text: s.text, provenance, model: s.model || model, steps: [] });
  });
  return out;
}

export interface PlacedNote<T> { item: T; row: number; left: number; width: number }

/**
 * Greedy sub-row packing so note text never overlaps: each note occupies [x, x + width] in px (width includes a
 * gap). Notes that would need more than maxRows rows are returned in `hidden` (render them as a "+N" chip).
 */
export function stackNotes<T extends { unix: number }>(
  items: T[], xOf: (item: T) => number, widthOf: (item: T) => number, maxRows: number, gap = 6,
): { placed: PlacedNote<T>[]; hidden: T[] } {
  const rowEnd: number[] = [];
  const placed: PlacedNote<T>[] = [];
  const hidden: T[] = [];
  for (const item of [...items].sort((a, b) => a.unix - b.unix)) {
    const left = xOf(item);
    const width = widthOf(item);
    let row = rowEnd.findIndex((end) => end + gap <= left);
    if (row < 0) row = rowEnd.length;
    if (row >= maxRows) { hidden.push(item); continue; }
    rowEnd[row] = left + width;
    placed.push({ item, row, left, width });
  }
  return { placed, hidden };
}
