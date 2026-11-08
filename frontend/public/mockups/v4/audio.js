// Generated WebAudio cues, no files. Muted by default; the first unmute creates the context (user gesture).
let ctx = null, muted = true, lastTick = 0;
export const isMuted = () => muted;
export function setMuted(m) {
  muted = m;
  if (!m) { ctx = ctx || new (window.AudioContext || window.webkitAudioContext)(); ctx.resume(); }
}
function beep(freq, dur, when, vol, type) {
  if (muted || !ctx) return;
  const t = ctx.currentTime + when, o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + dur + 0.02);
}
/** Soft tick per replayed step while playing (rate limited so 16x does not buzz). */
export function tick() {
  const n = performance.now();
  if (n - lastTick < 70) return;
  lastTick = n; beep(1600, 0.025, 0, 0.025, 'square');
}
/** Distinct two-tone: pump failed, or a countdown dropped below one hour. */
export function twoTone() { beep(660, 0.14, 0, 0.06, 'triangle'); beep(440, 0.22, 0.16, 0.06, 'triangle'); }
