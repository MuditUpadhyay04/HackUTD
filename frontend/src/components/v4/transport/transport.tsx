"use client";
// STUB (Phase A). B3 replaces the body; keep the export signature. Already usable: dataset, runtime, play, step, LIVE.
import type { Snapshot } from "@/lib/engine/types";
import type { RuntimeMode } from "@hackutd/contracts";
import type { RunControls } from "@/lib/v4/use-run";
import { isLive } from "@/lib/v4/derive";
import { usePlayhead, usePlayheadActions, SPEEDS } from "@/lib/v4/store";
import { stamp } from "@/lib/v4/format";

export function Transport({ snapshot, run }: { snapshot: Snapshot; run: RunControls }) {
  const t = usePlayhead((s) => Math.floor(s.t));
  const playing = usePlayhead((s) => s.playing);
  const speed = usePlayhead((s) => s.speed);
  const sound = usePlayhead((s) => s.sound);
  const a = usePlayheadActions();
  const live = isLive(snapshot) && t >= snapshot.nowUnix;
  const goLive = () => { if (isLive(snapshot)) a.seek(snapshot.nowUnix); else run.commitAt(null); };
  return (
    <div style={{ display: "flex", height: "100%", alignItems: "center", gap: 8, padding: "0 10px" }}>
      <button type="button" className="tp-btn press" onClick={() => a.step(-1)} aria-label="Step back 5 minutes">-5</button>
      <button type="button" className="tp-btn press" onClick={a.toggle} aria-pressed={playing} aria-label={playing ? "Pause" : "Play"}>{playing ? "PAUSE" : "PLAY"}</button>
      <button type="button" className="tp-btn press" onClick={() => a.step(1)} aria-label="Step forward 5 minutes">+5</button>
      <span className="mono" style={{ minWidth: 112, fontSize: "var(--fs-2)" }}>{stamp(t)}</span>
      <select className="tp-select" aria-label="Speed" value={speed} onChange={(e) => a.setSpeed(Number(e.target.value) as (typeof SPEEDS)[number])}>
        {SPEEDS.map((s) => <option key={s} value={s}>{s}x</option>)}
      </select>
      <button type="button" className="tp-btn press" onClick={goLive} data-on={live} aria-pressed={live}>LIVE</button>
      <button type="button" className="tp-btn press" onClick={a.toggleSound} aria-pressed={sound} aria-label="Sound">{sound ? "SOUND ON" : "SOUND OFF"}</button>
      <span style={{ flex: 1 }} />
      {run.loading && <span className="label">LOADING</span>}
      <select className="tp-select" aria-label="Runtime" value={run.runtime} onChange={(e) => run.setRuntime(e.target.value as RuntimeMode)}>
        <option value="auto">AUTO</option>
        <option value="software">SOFTWARE</option>
        <option value="fpga">FPGA</option>
      </select>
      <select className="tp-select" aria-label="Dataset" value={run.dataset?.id ?? ""} onChange={(e) => run.setDataset(e.target.value)}>
        {run.datasets.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
      </select>
    </div>
  );
}
