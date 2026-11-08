"use client";
// Transport (brief 2.5, softened): primary row = play/pause, step, time, scrubber, speed segmented control, Live, plus a
// dataset pill and a "..." menu (runtime, upload, sound, command palette). It is always rendered, so it also mounts the global keyboard hook, the audio cues and the palette.
import "./transport.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { RuntimeMode } from "@hackutd/contracts";
import type { Snapshot } from "@/lib/engine/types";
import type { RunControls } from "@/lib/v4/use-run";
import { inWindow, isLive, isProjected, localWindow } from "@/lib/v4/derive";
import { usePlayhead, usePlayheadActions, SPEEDS } from "@/lib/v4/store";
import { toggleOverview } from "@/lib/v4/layout-state";
import { stamp, systemNum } from "@/lib/v4/format";
import { useGlobalKeyboard, useReverseSpeed } from "@/lib/v4/keyboard";
import type { Command } from "@/lib/v4/keyboard-commands";
import { pipeViewCommand } from "@/lib/v4/pipeview-camera";
import { useAudioCues } from "@/lib/v4/audio";
import { MiniScrubber } from "./scrubber";
import { CommandPalette } from "./command-palette";
import { UploadPopover } from "./upload-popover";

const I = {
  play: <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 1.5v9l7-4.5z" fill="currentColor" /></svg>,
  pause: <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2.5 1.5h2.6v9H2.5zM6.9 1.5h2.6v9H6.9z" fill="currentColor" /></svg>,
  back: <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2 1.5h1.6v9H2zM10 1.5v9L4.6 6z" fill="currentColor" /></svg>,
  fwd: <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M8.4 1.5H10v9H8.4zM2 1.5v9L7.4 6z" fill="currentColor" /></svg>,
};
const RUNTIMES: { id: RuntimeMode; label: string }[] = [{ id: "auto", label: "Auto" }, { id: "software", label: "Software" }, { id: "fpga", label: "FPGA" }];

export function Transport({ snapshot, run }: { snapshot: Snapshot; run: RunControls }) {
  const router = useRouter();
  const a = usePlayheadActions();
  const minute = usePlayhead((s) => Math.floor(s.t / 60) * 60);
  const playing = usePlayhead((s) => s.playing);
  const speed = usePlayhead((s) => s.speed);
  const sound = usePlayhead((s) => s.sound);
  const autoplay = usePlayhead((s) => s.autoplay);
  const reverse = useReverseSpeed();
  const [palette, setPalette] = useState(false);
  const [upload, setUpload] = useState(false);

  const win = useMemo(() => localWindow(snapshot), [snapshot]);
  const projected = isProjected(snapshot, minute);
  const live = isLive(snapshot) && minute >= snapshot.nowUnix - 60 && !projected;
  const loaded = projected || inWindow(win, minute);
  const goLive = useCallback(() => { if (isLive(snapshot)) a.seek(snapshot.nowUnix); else run.commitAt(null); }, [snapshot, a, run]);

  useGlobalKeyboard({ onPalette: () => setPalette((o) => !o) });
  useAudioCues(snapshot);

  const { datasets, setDataset, setRuntime } = run;
  const commands = useMemo<Command[]>(() => [
    { id: "live", group: "Time", label: "Jump to live", run: goLive },
    { id: "play", group: "Time", label: "Play or pause", hint: "Space", run: a.toggle },
    ...SPEEDS.map<Command>((s) => ({ id: `speed-${s}`, group: "Speed", label: `Set speed ${s}x`, run: () => a.setSpeed(s) })),
    { id: "sound", group: "Sound", label: sound ? "Turn sound off" : "Turn sound on", hint: "M", run: a.toggleSound },
    { id: "overview", group: "View", label: "Toggle overview panel", run: () => toggleOverview(true) },
    { id: "classic", group: "Go to", label: "Go to classic console", hint: "/", run: () => router.push("/") },
    { id: "how", group: "Go to", label: "Go to how it works", hint: "/how-it-works", run: () => router.push("/how-it-works") },
    ...datasets.map<Command>((d) => ({ id: `ds-${d.id}`, group: "Dataset", label: `Select dataset ${d.label}`, run: () => setDataset(d.id) })),
    ...RUNTIMES.map<Command>((r) => ({ id: `rt-${r.id}`, group: "Runtime", label: `Select runtime ${r.label}`, run: () => setRuntime(r.id) })),
    { id: "pv-fit", group: "View", label: "Fit network", run: () => pipeViewCommand({ action: "fit" }) },
    ...snapshot.systems.map<Command>((s, i) => ({ id: `pv-frame-${s.id}`, group: "View", label: `Frame system ${systemNum(s.id)}`, run: () => { a.setFocus({ kind: "system", id: s.id }); pipeViewCommand({ action: "frame", index: i + 1 }); } })),
    ...snapshot.systems.map<Command>((s) => ({ id: `focus-${s.id}`, group: "Focus", label: `Focus system ${s.id}`, run: () => a.setFocus({ kind: "system", id: s.id }) })),
    { id: "focus-clear", group: "Focus", label: "Clear focus", run: () => a.setFocus(null) },
  ], [a, goLive, sound, router, datasets, setDataset, setRuntime, snapshot.systems]);

  const speedIdx = reverse == null ? SPEEDS.indexOf(speed) : -1;
  const status = reverse != null ? `Reverse ${reverse}x` : projected ? "Projection, not recorded" : !loaded ? "Not loaded" : live ? "Last reading" : "Replay";

  return (
    <div className="tx">
      {autoplay && (
        <div className="tx-auto" role="status">
          <i aria-hidden="true" />
          <span>{autoplay.projection ? "Auto-playing the last 12 hours and the projection" : "Auto-playing the last 12 hours"}</span>
          <button type="button" className="press" onClick={a.stopAutoplay}>Stop</button>
        </div>
      )}
      <button type="button" className="tx-btn tx-round press" onClick={() => a.step(-1)} aria-label="Step back 5 minutes" title="Step back 5 minutes (Left)">{I.back}</button>
      <button type="button" className="tx-btn tx-round tx-play press" onClick={a.toggle} aria-pressed={playing} aria-label={playing ? "Pause" : "Play"} title="Play or pause (Space)">{playing ? I.pause : I.play}</button>
      <button type="button" className="tx-btn tx-round press" onClick={() => a.step(1)} aria-label="Step forward 5 minutes" title="Step forward 5 minutes (Right)">{I.fwd}</button>
      <div className="tx-time" aria-live="off">
        <b>{stamp(minute)}</b>
        <span data-warn={!loaded || reverse != null || projected} data-projected={projected}>{status}</span>
      </div>
      <MiniScrubber snapshot={snapshot} />
      <div className="tx-seg" role="group" aria-label="Speed">
        <i className="tx-thumb" aria-hidden="true" data-on={speedIdx >= 0} style={{ transform: `translateX(${Math.max(0, speedIdx) * 100}%)`, }} />
        {SPEEDS.map((s) => <button key={s} type="button" className="tx-seg-b press" aria-pressed={reverse == null && s === speed} onClick={() => a.setSpeed(s)} title={`${s * 5} minutes of data per second`}>{s}x</button>)}
      </div>
      <button type="button" className="tx-btn press" onClick={goLive} data-on={live} aria-pressed={live} title="Jump to the last reading">Live</button>
      {run.loading && <span className="tx-run" role="status"><i aria-hidden="true" />{run.status ? run.status : "Loading run"}</span>}
      <select className="tx-pill" aria-label="Dataset" value={run.dataset?.id ?? ""} onChange={(e) => run.setDataset(e.target.value)}>
        {run.dataset == null && <option value="">No dataset</option>}
        {run.datasets.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
      </select>
      <MoreMenu
        sound={sound}
        runtime={run.runtime}
        onRuntime={run.setRuntime}
        onSound={a.toggleSound}
        onUpload={() => setUpload((o) => !o)}
        onPalette={() => setPalette(true)}
      />
      {upload && <UploadPopover run={run} onClose={() => setUpload(false)} />}
      {palette && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}
    </div>
  );
}

/** The "..." menu: runtime, upload, sound, command palette. Pointer-opened menus animate; keyboard-opened ones are instant. */
function MoreMenu({ sound, runtime, onRuntime, onSound, onUpload, onPalette }: {
  sound: boolean; runtime: RuntimeMode; onRuntime: (r: RuntimeMode) => void; onSound: () => void; onUpload: () => void; onPalette: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [instant, setInstant] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: globalThis.PointerEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", down, true); document.removeEventListener("keydown", key); };
  }, [open]);
  const pick = (fn: () => void) => () => { setOpen(false); fn(); };
  return (
    <div className="tx-menu-wrap" ref={root}>
      <button type="button" className="tx-btn tx-round press" aria-label="More options" aria-haspopup="menu" aria-expanded={open} data-upload-toggle="" onClick={(e) => { setInstant(e.detail === 0); setOpen((o) => !o); }}>
        <svg viewBox="0 0 16 4" width="16" height="4" aria-hidden="true"><circle cx="2" cy="2" r="1.5" fill="currentColor" /><circle cx="8" cy="2" r="1.5" fill="currentColor" /><circle cx="14" cy="2" r="1.5" fill="currentColor" /></svg>
      </button>
      {open && (
        <div className="tx-menu" role="menu" aria-label="More options" data-instant={instant}>
          <div className="tx-menu-h">Runtime</div>
          {RUNTIMES.map((r) => (
            <button key={r.id} type="button" role="menuitemradio" aria-checked={r.id === runtime} className="tx-mi" onClick={pick(() => onRuntime(r.id))}>
              <span>{r.label}</span>{r.id === runtime && <i className="tx-check" aria-hidden="true" />}
            </button>
          ))}
          <div className="tx-menu-sep" role="separator" />
          <button type="button" role="menuitem" className="tx-mi" onClick={pick(onUpload)}><span>Upload dataset</span></button>
          <button type="button" role="menuitemcheckbox" aria-checked={sound} className="tx-mi" onClick={pick(onSound)}><span>{sound ? "Sound on" : "Sound off"}</span><kbd>M</kbd></button>
          <button type="button" role="menuitem" className="tx-mi" onClick={pick(onPalette)}><span>Command palette</span><kbd>Cmd K</kbd></button>
        </div>
      )}
    </div>
  );
}
