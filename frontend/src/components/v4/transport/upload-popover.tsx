"use client";
// Compact dataset upload: network.json, ops.json, telemetry.csv and an optional label. Calls run.upload.
import { useEffect, useRef, useState } from "react";
import type { RunControls } from "@/lib/v4/use-run";

const FIELDS = [
  { key: "network", label: "network.json", accept: ".json,application/json" },
  { key: "ops", label: "ops.json", accept: ".json,application/json" },
  { key: "telemetry", label: "telemetry.csv", accept: ".csv,text/csv" },
] as const;
type Key = (typeof FIELDS)[number]["key"];

export function UploadPopover({ run, onClose }: { run: RunControls; onClose: () => void }) {
  const [files, setFiles] = useState<Partial<Record<Key, File>>>({});
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const down = (e: globalThis.PointerEvent) => { const el = e.target as Element; if (root.current && !root.current.contains(el) && !el.closest("[data-upload-toggle]")) onClose(); };
    const key = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", down, true); document.removeEventListener("keydown", key); };
  }, [onClose]);

  const ready = files.network && files.ops && files.telemetry;
  const submit = async () => {
    if (!files.network || !files.ops || !files.telemetry || busy) return;
    setBusy(true); setError("");
    try {
      await run.upload({ network: files.network, ops: files.ops, telemetry: files.telemetry, ...(label.trim() ? { label: label.trim() } : {}) });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
      setBusy(false);
    }
  };

  return (
    <div className="pop" ref={root} role="dialog" aria-label="Upload dataset" data-kbd="off">
      <div className="label pop-title">Upload dataset</div>
      {FIELDS.map((f) => (
        <label key={f.key} className="pop-file" data-empty={!files[f.key]}>
          <span className="label">{f.label}</span>
          <span>{files[f.key]?.name ?? "Choose file"}</span>
          <input type="file" accept={f.accept} aria-label={f.label} onChange={(e) => { const file = e.target.files?.[0]; setFiles((p) => ({ ...p, [f.key]: file })); }} />
        </label>
      ))}
      <input className="pop-label" type="text" placeholder="Label (optional)" aria-label="Dataset label" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} />
      {error && <p className="pop-err" role="alert">{error}</p>}
      <div className="pop-row">
        <button type="button" className="tx-btn press" onClick={onClose}>Cancel</button>
        <button type="button" className="tx-btn press" data-on={!!ready} disabled={!ready || busy} onClick={submit}>{busy ? "Uploading" : "Upload"}</button>
      </div>
    </div>
  );
}
