// Motion helpers for the Pipe View: reduced motion, keyboard-initiated detection, once-per-session intro flag.
export const reducedMotion = (): boolean => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

let lastKey = 0;
/** Install once; returns a disposer. Keyboard input marks following state changes as instant (Emil rule). */
export function trackInputModality(): () => void {
  const key = () => { lastKey = performance.now(); };
  const ptr = () => { lastKey = 0; };
  window.addEventListener("keydown", key, true);
  window.addEventListener("pointerdown", ptr, true);
  window.addEventListener("wheel", ptr, true);
  return () => {
    window.removeEventListener("keydown", key, true);
    window.removeEventListener("pointerdown", ptr, true);
    window.removeEventListener("wheel", ptr, true);
  };
}
export const keyboardRecent = (ms = 300): boolean => lastKey > 0 && performance.now() - lastKey < ms;

const INTRO_KEY = "pv4-intro";
export function introSeen(): boolean {
  try { return sessionStorage.getItem(INTRO_KEY) === "1"; } catch { return true; }
}
export function markIntroSeen(): void {
  try { sessionStorage.setItem(INTRO_KEY, "1"); } catch { /* ignore */ }
}

// Playhead discontinuities (the auto-play loop wrapping to its start, a seek): state changes caused by a jump switch
// instantly, with no dissolve and no onset pulse. A forward step of at most JUMP_FORWARD_S per notification is play.
const JUMP_BACK_S = 60;
const JUMP_FORWARD_S = 3600;
let lastJump = 0;
/** Feed every playhead time change; returns true (and marks a jump) when t did not move like normal playback. */
export function noteTime(prev: number, next: number): boolean {
  const d = next - prev;
  const jumped = d < -JUMP_BACK_S || d > JUMP_FORWARD_S;
  if (jumped) lastJump = performance.now();
  return jumped;
}
export const jumpRecent = (ms = 400): boolean => lastJump > 0 && performance.now() - lastJump < ms;

/** Onset pulses (3 pulses, then steady): at most one run per facility every PULSE_COOLDOWN_MS. */
export const PULSE_COOLDOWN_MS = 4000;
