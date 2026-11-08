"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { DatasetInfo, LiveEvent, RunRecord, RuntimeMode } from "@hackutd/contracts";
import type { Snapshot } from "@/lib/engine/types";
import { api, commandKey, defaultDataset, unwrap } from "@/lib/api";
import { Console } from "./console";

const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const cancel = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, ms);
  if (signal.aborted) cancel(); else signal.addEventListener("abort", cancel, { once: true });
});

export function Workspace({
  dataset: datasetProp,
  at: atProp,
  boardNow: boardNowProp,
}: {
  dataset?: DatasetInfo;
  at?: number;
  boardNow?: number;
} = {}) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const datasetId = params.get("dataset");
  const atParam = params.get("at");
  const mode = params.get("runtime");
  const runtime: RuntimeMode = mode === "software" || mode === "fpga" ? mode : "auto";
  const [datasets, setDatasets] = useState<DatasetInfo[]>([]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [status, setStatus] = useState("Loading datasets…");
  const [error, setError] = useState("");
  const parent = useRef<string | null>(null);
  const loadDatasets = useCallback(async () => {
    const list = unwrap(await api.api.datasets.get());
    setDatasets(list);
    return list;
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    setSnapshot(null); setError("");
    async function start() {
      const list = await loadDatasets();
      if (abort.signal.aborted) return;
      // Props take precedence over URL params
      const selected = datasetProp ?? list.find((d) => d.id === datasetId) ?? (!datasetId ? defaultDataset(list) : undefined);
      if (!selected) { setStatus(datasetId ? "Dataset not found. Select or upload a dataset." : "Upload a dataset to begin."); return; }
      const time = atProp ?? (atParam && Number.isFinite(Number(atParam)) ? Number(atParam) : undefined);
      const selection = JSON.stringify([selected.id, time ?? null, runtime, parent.current]);
      const storageKey = `operator-run:${selection}`;
      let key = sessionStorage.getItem(storageKey);
      if (!key) { key = commandKey(); sessionStorage.setItem(storageKey, key); }
      setStatus("Starting analysis run…");
      let run: RunRecord;
      try {
        run = unwrap(await api.api.runs.post({ datasetId: selected.id, ...(time !== undefined ? { at: time } : {}), runtime, ...(parent.current ? { parentRunId: parent.current } : {}) }, { headers: { "idempotency-key": key }, fetch: { signal: abort.signal } }));
      } catch (e) { if (!abort.signal.aborted) sessionStorage.removeItem(storageKey); throw e; }
      while (!abort.signal.aborted && run.status !== "ready") {
        if (run.status === "failed" || run.status === "cancelled") { sessionStorage.removeItem(storageKey); throw new Error(run.error || `Run ${run.status}`); }
        setStatus(`Run ${run.status}…`);
        await delay(800, abort.signal);
        run = unwrap(await api.api.runs({ id: run.id }).get({ fetch: { signal: abort.signal } }));
      }
      if (abort.signal.aborted) return;
      parent.current = run.id;
      let current = run.snapshot ?? unwrap(await api.api.runs({ id: run.id }).snapshot.get({ fetch: { signal: abort.signal } }));
      if (abort.signal.aborted) return;
      setSnapshot(current);
      // The stream starts after the cursor read atomically with the snapshot. On any
      // disconnect, resync the snapshot before resubscribing, including expired cursors.
      while (!abort.signal.aborted) {
        try {
          const response = await fetch(`/api/backend/api/runs/${encodeURIComponent(run.id)}/events?after=${current.cursor}`, { signal: abort.signal, headers: { accept: "text/event-stream" } });
          if (!response.ok || !response.body) throw new Error("Stream unavailable");
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = "";
          for (;;) {
            const part = await reader.read(); if (part.done) break;
            buffer = (buffer + part.value).replace(/\r\n/g, "\n");
            let boundary: number;
            while ((boundary = buffer.indexOf("\n\n")) >= 0) {
              const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
              const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
              if (!data) continue;
              let event: LiveEvent;
              try { event = JSON.parse(data) as LiveEvent; } catch { continue; }
              if (event.runId !== run.id || !Number.isSafeInteger(event.cursor) || event.cursor <= current.cursor) continue;
              // Fetch a coherent snapshot; never apply a partial event as state.
              const fresh = unwrap(await api.api.runs({ id: run.id }).snapshot.get({ fetch: { signal: abort.signal } }));
              if (fresh.runId === run.id && fresh.cursor >= current.cursor && fresh.revision >= current.revision) { current = fresh; setSnapshot(fresh); }
            }
          }
        } catch { if (abort.signal.aborted) return; }
        await delay(1500, abort.signal);
        try {
          const fresh = unwrap(await api.api.runs({ id: run.id }).snapshot.get({ fetch: { signal: abort.signal } }));
          if (fresh.runId === run.id && fresh.cursor >= current.cursor && fresh.revision >= current.revision) { current = fresh; setSnapshot(fresh); }
        } catch { /* retry on the next connection */ }
      }
    }
    start().catch((e: Error) => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [datasetProp, atProp, runtime, loadDatasets]);

  const navigate = (patch: Record<string, string | null>) => {
    const q = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(patch)) value == null ? q.delete(key) : q.set(key, value);
    router.push(`${pathname}?${q}`);
  };
  return <>
    <div className="mx-auto flex max-w-[1344px] flex-wrap items-center gap-3 px-4 pt-4 text-sm">
      <label>Runtime <select value={runtime} onChange={(e) => navigate({ runtime: e.target.value })} className="rounded-lg bg-white px-2 py-1"><option value="auto">Automatic</option><option value="software">Software</option><option value="fpga">FPGA</option></select></label>
      {!snapshot && datasets.length > 0 && <label>Dataset <select value={datasetId ?? datasets[0].id} onChange={(e) => navigate({ dataset: e.target.value, at: null })} className="rounded-lg bg-white px-2 py-1">{datasets.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}</select></label>}
      <Upload onUploaded={async (d) => { await loadDatasets(); navigate({ dataset: d.id, at: null }); }} />
    </div>
    {error && <p role="alert" className="mx-auto max-w-[1344px] px-4 pt-3 text-crit">{error}</p>}
    {snapshot ? <Console key={snapshot.runId} snapshot={snapshot} datasets={datasets} /> : <main className="mx-auto max-w-[1344px] p-8 text-muted-foreground">{status}</main>}
  </>;
}

function Upload({ onUploaded }: { onUploaded: (dataset: DatasetInfo) => Promise<void> }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  return <details className="relative"><summary className="cursor-pointer font-medium text-water">Upload dataset</summary>
    <form className="glass absolute z-30 mt-2 grid w-80 gap-3 p-4" onSubmit={async (event) => {
      event.preventDefault(); setBusy(true); setMessage("Uploading and validating…");
      const form = event.currentTarget;
      try {
        const files = new FormData(form);
        const network = files.get("network"), ops = files.get("ops"), telemetry = files.get("telemetry"), label = files.get("label");
        if (!(network instanceof File) || !(ops instanceof File) || !(telemetry instanceof File)) throw new Error("Select all three files.");
        const dataset = unwrap(await api.api.datasets.post({ network, ops, telemetry, ...(typeof label === "string" && label ? { label } : {}) }));
        setMessage("Dataset ready."); form.reset(); await onUploaded(dataset);
      }
      catch (e) { setMessage(e instanceof Error ? e.message : "Upload failed"); }
      finally { setBusy(false); }
    }}>
      {([ ["network", "network.json"], ["ops", "ops.json"], ["telemetry", "telemetry.csv"] ] as const).map(([name, label]) => <label key={name}>{label}<input required type="file" name={name} accept={name === "telemetry" ? ".csv,text/csv" : ".json,application/json"} className="block w-full text-xs" /></label>)}
      <label>Label (optional)<input name="label" className="block w-full rounded border border-line bg-white p-1" /></label>
      <button disabled={busy} className="rounded-lg bg-water px-3 py-2 text-white disabled:opacity-50">{busy ? "Uploading…" : "Upload"}</button>
      {message && <p role="status" className="break-words text-xs">{message}</p>}
    </form>
  </details>;
}
