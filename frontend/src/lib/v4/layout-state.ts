"use client";
// Overview panel visibility (docs/ui-v4-balance.md). Wide viewports (1280px and up): a collapsible column, remembered
// per viewer in localStorage. Narrower viewports: an overlay sheet that starts closed and is not remembered.
// Keyboard-initiated toggles (command palette) flag `instant` so the sheet never animates for them.
import { useSyncExternalStore } from "react";

export const OVERVIEW_KEY = "v4.overview.open";
export const NARROW_QUERY = "(max-width: 1279px)";

interface LayoutState { wide: boolean; sheet: boolean; narrow: boolean; instant: boolean }

const read = (): boolean => {
  try { return window.localStorage.getItem(OVERVIEW_KEY) !== "0"; } catch { return true; }
};
const write = (open: boolean) => {
  try { window.localStorage.setItem(OVERVIEW_KEY, open ? "1" : "0"); } catch { /* storage blocked */ }
};

let state: LayoutState = { wide: true, sheet: false, narrow: false, instant: false };
let inited = false;
let media: MediaQueryList | null = null;
const listeners = new Set<() => void>();
const emit = (patch: Partial<LayoutState>) => { state = { ...state, ...patch }; listeners.forEach((l) => l()); };

function init() {
  if (inited || typeof window === "undefined") return;
  inited = true;
  state = { ...state, wide: read() };
  if (typeof window.matchMedia === "function") {
    media = window.matchMedia(NARROW_QUERY);
    state = { ...state, narrow: media.matches };
    media.addEventListener("change", (e) => emit({ narrow: e.matches, sheet: false, instant: true }));
  }
}

const subscribe = (l: () => void) => { init(); listeners.add(l); return () => { listeners.delete(l); }; };
const getState = () => { init(); return state; };
const server: LayoutState = { wide: true, sheet: false, narrow: false, instant: false };

export function useOverviewLayout(): { open: boolean; narrow: boolean; instant: boolean } {
  const s = useSyncExternalStore(subscribe, getState, () => server);
  return { open: s.narrow ? s.sheet : s.wide, narrow: s.narrow, instant: s.instant };
}

/** Opens or closes the overview (column when wide, sheet when narrow). Pass instant for keyboard-initiated changes. */
export function setOverviewOpen(open: boolean, instant = false) {
  init();
  if (state.narrow) emit({ sheet: open, instant });
  else { write(open); emit({ wide: open, instant }); }
}

export function toggleOverview(instant = false) {
  init();
  setOverviewOpen(!(state.narrow ? state.sheet : state.wide), instant);
}
