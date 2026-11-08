// Pure audio cue detection. The engine (audio.ts) subscribes to the playhead store, probes the derived state at the
// playhead, and diffs it against the previous probe; no React re-render is involved.
import { countdownAt, incidentsAt, isProjected, type Approved, type Snapshot } from "./derive";

const STEP = 300;
/** A forward jump of more than this many 5-minute steps in one update is a seek, not playback: no cues. */
export const JUMP_STEPS = 4;

export interface AudioProbe {
  /** floor(t / 5 min) */
  step: number;
  /** Active pump_failure incident ids. */
  failing: string[];
  /** Pump failures whose countdown is counting with p50 remaining below 1 hour. */
  underHour: string[];
  /** Pump failures whose PROJECTED tank has reached the shutdown limit (empty outside the projection). */
  tripped: string[];
}

export function probeAt(snapshot: Snapshot, t: number, approved: Approved = []): AudioProbe {
  const failing: string[] = [];
  const underHour: string[] = [];
  const tripped: string[] = [];
  const projected = isProjected(snapshot, t);
  for (const inc of incidentsAt(snapshot, t)) {
    if (inc.category !== "pump_failure") continue;
    failing.push(inc.id);
    const c = countdownAt(inc, snapshot, t, approved);
    if (projected && c.kind === "shut") tripped.push(inc.id);
    if (c.kind === "counting" && c.remainingHours && c.remainingHours.p50 < 1) underHour.push(inc.id);
  }
  return { step: Math.floor(t / STEP), failing, underHour, tripped };
}

export interface Cues { tick: boolean; alert: boolean; /** a projected tank tripped (distinct cue, plays instead of alert) */ trip: boolean }
const NONE: Cues = { tick: false, alert: false, trip: false };

/**
 * Cues for a playhead move prev -> next. Only while playing and moving forward by at most JUMP_STEPS steps
 * (scrubs, seeks and steps are silent). alert = a pump failure became active or a countdown dropped below 1 h;
 * trip = a projected tank reached the shutdown limit during forward play. The caller plays trip over alert over tick.
 */
export function diffCues(prev: AudioProbe | null, next: AudioProbe, playing: boolean): Cues {
  if (!prev || !playing) return NONE;
  const d = next.step - prev.step;
  if (d < 0 || d > JUMP_STEPS) return NONE;
  const fresh = (a: string[], b: string[]) => a.some((id) => !b.includes(id));
  const alert = fresh(next.failing, prev.failing) || fresh(next.underHour, prev.underHour);
  const trip = fresh(next.tripped, prev.tripped);
  return { tick: d >= 1, alert, trip };
}
