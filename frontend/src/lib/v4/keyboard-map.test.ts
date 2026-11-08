import { describe, expect, test } from "bun:test";
import { isTypingTarget, keyToAction, nextScrub, type KeyInfo } from "./keyboard-map";
import { filterCommands } from "./keyboard-commands";

const k = (key: string, over: Partial<KeyInfo> = {}): KeyInfo => ({
  key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, targetTag: "BODY", targetEditable: false, targetIgnored: false, ...over,
});

describe("keyToAction", () => {
  test("transport keys", () => {
    expect(keyToAction(k(" "))).toEqual({ kind: "toggle-play" });
    expect(keyToAction(k("ArrowLeft"))).toEqual({ kind: "step", dir: -1 });
    expect(keyToAction(k("ArrowRight"))).toEqual({ kind: "step", dir: 1 });
    expect(keyToAction(k("j"))).toEqual({ kind: "scrub", dir: -1 });
    expect(keyToAction(k("K"))).toEqual({ kind: "stop" });
    expect(keyToAction(k("l"))).toEqual({ kind: "scrub", dir: 1 });
    expect(keyToAction(k("m"))).toEqual({ kind: "toggle-sound" });
  });
  test("cmd/ctrl+k opens the palette, even while typing", () => {
    expect(keyToAction(k("k", { metaKey: true }))).toEqual({ kind: "palette" });
    expect(keyToAction(k("k", { ctrlKey: true, targetTag: "INPUT" }))).toEqual({ kind: "palette" });
  });
  test("ignores keys while typing in inputs, selects, textareas, contenteditable and ignored regions", () => {
    for (const over of [{ targetTag: "INPUT" }, { targetTag: "SELECT" }, { targetTag: "TEXTAREA" }, { targetEditable: true }, { targetIgnored: true }]) {
      expect(keyToAction(k(" ", over))).toBeNull();
      expect(keyToAction(k("m", over))).toBeNull();
      expect(isTypingTarget({ targetTag: "BODY", targetEditable: false, targetIgnored: false, ...over })).toBe(true);
    }
  });
  test("does not own digits, plus or minus (Pipe View does) or modified plain keys", () => {
    for (const key of ["0", "1", "9", "+", "-", "=", "a"]) expect(keyToAction(k(key))).toBeNull();
    expect(keyToAction(k("m", { metaKey: true }))).toBeNull();
    expect(keyToAction(k("ArrowLeft", { altKey: true }))).toBeNull();
  });
});

describe("nextScrub", () => {
  test("same direction speeds up and caps", () => {
    let s = nextScrub({ dir: 0, speedIdx: 0 }, 1);
    expect(s).toEqual({ dir: 1, speedIdx: 0 });
    s = nextScrub(s, 1); expect(s.speedIdx).toBe(1);
    s = nextScrub(s, 1); expect(s.speedIdx).toBe(2);
    s = nextScrub(s, 1); expect(s.speedIdx).toBe(2);
  });
  test("reversing direction restarts at 1x", () => {
    expect(nextScrub({ dir: 1, speedIdx: 2 }, -1)).toEqual({ dir: -1, speedIdx: 0 });
    expect(nextScrub({ dir: -1, speedIdx: 1 }, -1)).toEqual({ dir: -1, speedIdx: 2 });
  });
});

describe("filterCommands", () => {
  const cmds = [
    { group: "TIME", label: "JUMP TO LIVE" },
    { group: "SPEED", label: "SET SPEED 4X" },
    { group: "NAVIGATE", label: "GO TO CLASSIC CONSOLE" },
  ];
  test("empty query keeps all in order", () => expect(filterCommands(cmds, "  ")).toEqual(cmds));
  test("all tokens must match, case-insensitive", () => {
    expect(filterCommands(cmds, "speed 4")).toEqual([cmds[1]]);
    expect(filterCommands(cmds, "go classic")).toEqual([cmds[2]]);
    expect(filterCommands(cmds, "zzz")).toEqual([]);
  });
});
