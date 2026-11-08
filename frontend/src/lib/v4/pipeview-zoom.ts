// Tiny external store for the camera zoom, so lines can pick a label variant per zoom without a React render per
// camera frame: each line subscribes through useSyncExternalStore with a selector that returns a short string, so it
// re-renders only when that string (its label plan) actually changes.
export interface ZoomStore {
  get(): number;
  set(z: number): void;
  subscribe(listener: () => void): () => void;
}

/** Starts at 0 (nothing drawn at zoom 0): lines render no labels until the first fit sets the real zoom. */
export function createZoomStore(initial = 0): ZoomStore {
  let z = initial;
  const ls = new Set<() => void>();
  return {
    get: () => z,
    set: (next) => { if (Math.abs(next - z) < 1e-6) return; z = next; ls.forEach((l) => l()); },
    subscribe: (l) => { ls.add(l); return () => { ls.delete(l); }; },
  };
}
