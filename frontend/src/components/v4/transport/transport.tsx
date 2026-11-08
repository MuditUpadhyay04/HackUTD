"use client";
// Transport (brief 2.5): play/pause, step, speed, time, LIVE, mini scrubber, run status, sound, upload, runtime and
// dataset selects. It is always rendered, so it also mounts the global keyboard hook, the audio cues and the palette.
import "./transport.css";
import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { RuntimeMode } from "@hackutd/contracts";
import type { Snapshot } from "@/lib/engine/types";
import type { RunControls } from "@/lib/v4/use-run";
import { inWindow, isLive, isProjected, localWindow } from "@/lib/v4/derive";
import { usePlayhead, usePlayheadActions, SPEEDS } from "@/lib/v4/store";
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
const RUNTIMES: { id: RuntimeMode; label: string }[] = [{ id: "auto", label: "AUTO" }, { id: "software", label: "SOFTWARE" }, { id: "fpga", label: "FPGA" }];

export function Transport({ snapshot, run }: { snapshot: Snapshot; run: RunControls }) {
  const router = useRouter();
  const a = usePlayheadActions();
  const minute = usePlayhead((s) => Math.floor(s.t / 60) * 60);
  const playing = usePlayhead((s) => s.playing);
  const speed = usePlayhead((s) => s.speed);
  const sound = usePlayhead((s) => s.sound);
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
    { id: "live", group: "TIME", label: "JUMP TO LIVE", run: goLive },
    { id: "play", group: "TIME", label: "PLAY OR PAUSE", hint: "SPACE", run: a.toggle },
    ...SPEEDS.map<Command>((s) => ({ id: `speed-${s}`, group: "SPEED", label: `SET SPEED ${s}X`, run: () => a.setSpeed(s) })),
    { id: "sound", group: "SOUND", label: sound ? "TURN SOUND OFF" : "TURN SOUND ON", hint: "M", run: a.toggleSound },
    { id: "classic", group: "GO TO", label: "GO TO CLASSIC CONSOLE", hint: "/CLASSIC", run: () => router.push("/classic") },
    { id: "how", group: "GO TO", label: "GO TO HOW IT WORKS", hint: "/HOW-IT-WORKS", run: () => router.push("/how-it-works") },
    ...datasets.map<Command>((d) => ({ id: `ds-${d.id}`, group: "DATASET", label: `SELECT DATASET ${d.label}`, run: () => setDataset(d.id) })),
    ...RUNTIMES.map<Command>((r) => ({ id: `rt-${r.id}`, group: "RUNTIME", label: `SELECT RUNTIME ${r.label}`, run: () => setRuntime(r.id) })),
    { id: "pv-fit", group: "VIEW", label: "FIT NETWORK", run: () => pipeViewCommand({ action: "fit" }) },
    ...snapshot.systems.map<Command>((s, i) => ({ id: `pv-frame-${s.id}`, group: "VIEW", label: `FRAME SYSTEM ${systemNum(s.id)}`, run: () => { a.setFocus({ kind: "system", id: s.id }); pipeViewCommand({ action: "frame", index: i + 1 }); } })),
    ...snapshot.systems.map<Command>((s) => ({ id: `focus-${s.id}`, group: "FOCUS", label: `FOCUS SYSTEM ${s.id}`, run: () => a.setFocus({ kind: "system", id: s.id }) })),
    { id: "focus-clear", group: "FOCUS", label: "CLEAR FOCUS", run: () => a.setFocus(null) },
  ], [a, goLive, sound, router, datasets, setDataset, setRuntime, snapshot.systems]);

  return (
    <div className="tx">
      <button type="button" className="tx-btn press" onClick={() => a.step(-1)} aria-label="Step back 5 minutes" title="Step back 5 minutes (Left)">{I.back}</button>
      <button type="button" className="tx-btn tx-play press" onClick={a.toggle} aria-pressed={playing} aria-label={playing ? "Pause" : "Play"} title="Play or pause (Space)">{playing ? I.pause : I.play}</button>
      <button type="button" className="tx-btn press" onClick={() => a.step(1)} aria-label="Step forward 5 minutes" title="Step forward 5 minutes (Right)">{I.fwd}</button>
      <div className="tx-time" aria-live="off">
        <b>{stamp(minute)}</b>
        <span data-warn={!loaded || reverse != null || projected} data-projected={projected}>{reverse != null ? `REVERSE ${reverse}X` : projected ? "PROJECTED" : !loaded ? "NOT LOADED" : live ? "LAST READING" : "REPLAY"}</span>
      </div>
      <div className="tx-seg" role="group" aria-label="Speed">
        {SPEEDS.map((s) => <button key={s} type="button" className="tx-btn press" aria-pressed={reverse == null && s === speed} onClick={() => a.setSpeed(s)} title={`${s * 5} minutes of data per second`}>{s}X</button>)}
      </div>
      <button type="button" className="tx-btn press" onClick={goLive} data-on={live} aria-pressed={live} title="Jump to the last reading">LIVE</button>
      <MiniScrubber snapshot={snapshot} />
      {run.loading && <span className="tx-run" role="status"><i aria-hidden="true" />{run.status ? run.status : "LOADING RUN"}</span>}
      <button type="button" className="tx-btn press" onClick={a.toggleSound} aria-pressed={sound} title="Toggle sound (M)">{sound ? "SOUND ON" : "SOUND OFF"}</button>
      <button type="button" className="tx-btn press tx-hide-s" onClick={() => setPalette(true)} title="Command palette (Ctrl or Cmd K)" aria-haspopup="dialog">CMD K</button>
      <button type="button" className="tx-btn press" onClick={() => setUpload((o) => !o)} aria-expanded={upload} aria-haspopup="dialog" data-upload-toggle="">UPLOAD</button>
      <select className="tx-sel tx-hide-s" aria-label="Runtime" value={run.runtime} onChange={(e) => run.setRuntime(e.target.value as RuntimeMode)}>
        {RUNTIMES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
      </select>
      <select className="tx-sel" aria-label="Dataset" value={run.dataset?.id ?? ""} onChange={(e) => run.setDataset(e.target.value)}>
        {run.dataset == null && <option value="">NO DATASET</option>}
        {run.datasets.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
      </select>
      {upload && <UploadPopover run={run} onClose={() => setUpload(false)} />}
      {palette && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}
    </div>
  );
}
