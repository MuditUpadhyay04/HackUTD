// Global transport keyboard (mounted from Transport). Mapping is pure (keyboard-map.ts); this hook applies it to the
// playhead store. Keyboard-initiated actions never animate: the store just jumps.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { SECONDS_PER_REAL_SECOND, SPEEDS, usePlayheadStore, type Speed } from "./store";
import { keyToAction, nextScrub, type KeyInfo, type ScrubState } from "./keyboard-map";

// Reverse scrub (J) is a keyboard-local loop because the store only plays forward.
let reverseIdx: number | null = null;
const listeners = new Set<() => void>();
const setReverse = (idx: number | null) => { reverseIdx = idx; listeners.forEach((l) => l()); };
const subscribeReverse = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** Current reverse scrub speed (1, 4, 16) or null when not scrubbing backwards. For the transport readout. */
export function useReverseSpeed(): Speed | null {
  const idx = useSyncExternalStore(subscribeReverse, () => reverseIdx, () => null);
  return idx == null ? null : SPEEDS[idx];
}

function info(e: KeyboardEvent): KeyInfo {
  const el = e.target instanceof HTMLElement ? e.target : null;
  return {
    key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey,
    targetTag: el?.tagName ?? "",
    targetEditable: !!el?.isContentEditable,
    targetIgnored: !!el?.closest('[data-kbd="off"]'),
  };
}

export function useGlobalKeyboard(opts: { onPalette: () => void }): void {
  const store = usePlayheadStore();
  const palette = useRef(opts.onPalette);
  useEffect(() => { palette.current = opts.onPalette; });

  useEffect(() => {
    const a = store.actions;
    let raf = 0;
    let last = 0;
    let expected = 0;

    const stopReverse = () => {
      if (reverseIdx == null) return;
      cancelAnimationFrame(raf);
      raf = 0;
      setReverse(null);
    };
    const frame = (now: number) => {
      if (reverseIdx == null) return;
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      const s = store.getState();
      // Someone else moved the playhead or started playback: yield.
      if (s.playing || Math.abs(s.t - expected) > 1e-6) { stopReverse(); return; }
      if (!document.hidden) {
        a.seek(s.t - dt * SECONDS_PER_REAL_SECOND * SPEEDS[reverseIdx]);
        const after = store.getState().t;
        if (after === s.t) { stopReverse(); return; } // hit the start of the dataset
        expected = after;
      }
      raf = requestAnimationFrame(frame);
    };
    const startReverse = (idx: number) => {
      const was = reverseIdx;
      a.pause();
      expected = store.getState().t;
      setReverse(idx);
      if (was == null) { last = performance.now(); raf = requestAnimationFrame(frame); }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return; // another surface (e.g. Pipe View) already handled it
      const act = keyToAction(info(e));
      if (!act) return;
      e.preventDefault();
      if (act.kind === "palette") { palette.current(); return; }
      if (e.repeat && act.kind !== "step") return;
      switch (act.kind) {
        case "toggle-play": stopReverse(); a.toggle(); break;
        case "step": stopReverse(); a.step(act.dir); break;
        case "stop": stopReverse(); a.pause(); break;
        case "toggle-sound": a.toggleSound(); break;
        case "scrub": {
          const s = store.getState();
          const cur: ScrubState = reverseIdx != null ? { dir: -1, speedIdx: reverseIdx }
            : s.playing ? { dir: 1, speedIdx: Math.max(0, SPEEDS.indexOf(s.speed)) }
            : { dir: 0, speedIdx: 0 };
          const next = nextScrub(cur, act.dir, SPEEDS.length - 1);
          if (next.dir === 1) { stopReverse(); a.setSpeed(SPEEDS[next.speedIdx]); a.play(); }
          else startReverse(next.speedIdx);
          break;
        }
      }
    };
    // Space on a focused button would also click it on key release; swallow that when we handled the keydown.
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === " " && keyToAction({ ...info(e), key: " " })) e.preventDefault();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      stopReverse();
    };
  }, [store]);
}
