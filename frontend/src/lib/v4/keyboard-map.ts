// Pure keyboard mapping for the v4 transport (no React, no DOM). The hook in keyboard.ts feeds it KeyInfo.
// 0-9 and +/- are deliberately NOT mapped: Pipe View owns them when focused.

export interface KeyInfo {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /** event.target.tagName (upper case) or "" */
  targetTag: string;
  targetEditable: boolean;
  /** True when the target sits inside a [data-kbd="off"] region (palette, popovers). */
  targetIgnored: boolean;
}

export type KeyAction =
  | { kind: "toggle-play" }
  | { kind: "step"; dir: 1 | -1 }
  | { kind: "scrub"; dir: 1 | -1 }
  | { kind: "stop" }
  | { kind: "toggle-sound" }
  | { kind: "palette" };

/** Typing in a field (or inside an ignored region) swallows plain keys. */
export function isTypingTarget(k: Pick<KeyInfo, "targetTag" | "targetEditable" | "targetIgnored">): boolean {
  return k.targetEditable || k.targetIgnored || k.targetTag === "INPUT" || k.targetTag === "TEXTAREA" || k.targetTag === "SELECT";
}

export function keyToAction(k: KeyInfo): KeyAction | null {
  const key = k.key.length === 1 ? k.key.toLowerCase() : k.key;
  // Command palette works everywhere, even while typing.
  if ((k.metaKey || k.ctrlKey) && !k.altKey && key === "k") return { kind: "palette" };
  if (isTypingTarget(k)) return null;
  if (k.metaKey || k.ctrlKey || k.altKey) return null;
  switch (key) {
    case " ":
    case "Spacebar": return { kind: "toggle-play" };
    case "ArrowLeft": return { kind: "step", dir: -1 };
    case "ArrowRight": return { kind: "step", dir: 1 };
    case "j": return { kind: "scrub", dir: -1 };
    case "k": return { kind: "stop" };
    case "l": return { kind: "scrub", dir: 1 };
    case "m": return { kind: "toggle-sound" };
    default: return null;
  }
}

export interface ScrubState {
  /** 0 = stopped. */
  dir: -1 | 0 | 1;
  /** Index into the speed ladder (1x, 4x, 16x). */
  speedIdx: number;
}

/** Video-player J/L: pressing the same direction again speeds up (capped); the other direction restarts at 1x. */
export function nextScrub(cur: ScrubState, press: 1 | -1, maxIdx = 2): ScrubState {
  if (cur.dir === press) return { dir: press, speedIdx: Math.min(maxIdx, cur.speedIdx + 1) };
  return { dir: press, speedIdx: 0 };
}
