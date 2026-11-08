// WebAudio cues, generated (no files). Muted by default (store.sound = false). The AudioContext is created lazily on the
// first user gesture (browsers refuse to start it earlier). Cues check the store's sound flag at the moment they fire.
import { useEffect } from "react";
import type { Snapshot } from "./derive";
import { usePlayheadStore } from "./store";
import { diffCues, probeAt, type AudioProbe } from "./audio-events";

let ctx: AudioContext | null = null;
let lastTick = 0;

/** Create (or resume) the context. Must be called from a user gesture handler. */
export function unlockAudio(): void {
  if (typeof window === "undefined") return;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    ctx = new Ctor();
  }
  if (ctx.state === "suspended") void ctx.resume();
}

function tone(freq: number, dur: number, when: number, vol: number, type: OscillatorType) {
  if (!ctx) return;
  const t = ctx.currentTime + when;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

/** Soft, short tick per 5 minute step. Rate limited so 16x does not buzz. */
export function playTick(): void {
  const n = performance.now();
  if (n - lastTick < 70) return;
  lastTick = n;
  tone(1300, 0.03, 0, 0.03, "triangle");
}

/** Distinct falling two-tone: a pump failed, or a countdown dropped below one hour. */
export function playAlert(): void {
  tone(660, 0.14, 0, 0.06, "triangle");
  tone(440, 0.22, 0.16, 0.06, "triangle");
}

/** Projected tank trip: a low three-note descent, distinct from the failure alert. */
export function playTrip(): void {
  tone(520, 0.12, 0, 0.07, "square");
  tone(390, 0.12, 0.13, 0.07, "square");
  tone(260, 0.3, 0.26, 0.07, "square");
}

/** Mount once (Transport does). Diffs derived state on playhead changes; no re-render. */
export function useAudioCues(snapshot: Snapshot): void {
  const store = usePlayheadStore();
  useEffect(() => {
    // First gesture unlocks audio so the very first sound-on or cue can play.
    const gesture = () => {
      unlockAudio();
      window.removeEventListener("pointerdown", gesture, true);
      window.removeEventListener("keydown", gesture, true);
    };
    window.addEventListener("pointerdown", gesture, true);
    window.addEventListener("keydown", gesture, true);

    const init = store.getState();
    let prev: AudioProbe | null = probeAt(snapshot, init.t, init.approved);
    let approved = init.approved;
    let minute = Math.floor(init.t / 60);
    let wasPlaying = init.playing;
    let wasSound = init.sound;
    const off = store.subscribe(() => {
      const s = store.getState();
      if (s.sound !== wasSound) {
        wasSound = s.sound;
        if (s.sound) { unlockAudio(); playTick(); } // audible confirmation, inside the toggle's gesture
      }
      if (s.approved !== approved) { // approval changes the followed curve: re-baseline silently
        approved = s.approved;
        prev = probeAt(snapshot, s.t, approved);
      }
      const m = Math.floor(s.t / 60);
      if (m === minute && s.playing === wasPlaying) return; // steps change on minute boundaries only
      minute = m;
      wasPlaying = s.playing;
      const next = probeAt(snapshot, s.t, s.approved);
      const cues = diffCues(prev, next, s.playing);
      prev = next;
      if (!s.sound) return;
      if (cues.trip) playTrip();
      else if (cues.alert) playAlert();
      else if (cues.tick) playTick();
    });
    return () => {
      off();
      window.removeEventListener("pointerdown", gesture, true);
      window.removeEventListener("keydown", gesture, true);
    };
  }, [snapshot, store]);
}
