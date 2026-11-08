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
