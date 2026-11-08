"use client";
// Run lifecycle for the v4 shell. Same behaviour as the v3 Workspace (idempotent run creation, polling until ready,
// SSE with snapshot resync, stale-snapshot guards), driven by the URL (?dataset, ?at, ?runtime) on the current pathname (/lab).
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { DatasetInfo, LiveEvent, RunRecord, RuntimeMode } from "@hackutd/contracts";
import type { Snapshot } from "@/lib/engine/types";
import { api, commandKey, defaultDataset, unwrap } from "@/lib/api";

export interface UploadFiles { network: File; ops: File; telemetry: File; label?: string }

export interface RunControls {
  datasets: DatasetInfo[];
  /** The selected dataset, null until the list has loaded or when the URL names an unknown one. */
  dataset: DatasetInfo | null;
  /** Latest coherent snapshot. Kept while the next run loads (check `loading`). */
  snapshot: Snapshot | null;
  /** Human readable progress ("Starting analysis run...") while there is no snapshot or `loading`. */
  status: string;
  error: string;
  runtime: RuntimeMode;
  /** True while a new run (dataset, runtime or `at` changed) is being created. */
  loading: boolean;
  /** The committed `?at=` (unix seconds) or null for LIVE. */
  at: number | null;
  /** Load a run at unix time `t`; null (or t at/after the dataset's end) = LIVE. Replaces history, stays on the current path. */
  commitAt(unix: number | null): void;
  setDataset(id: string): void;
  setRuntime(mode: RuntimeMode): void;
  /** Uploads and validates a dataset, then selects it. Rejects with the API's message. */
  upload(files: UploadFiles): Promise<DatasetInfo>;
}

const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const cancel = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, ms);
  if (signal.aborted) cancel(); else signal.addEventListener("abort", cancel, { once: true });
});

export function useRun(): RunControls {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const datasetId = params.get("dataset");
  const atParam = params.get("at");
  const mode = params.get("runtime");
  const runtime: RuntimeMode = mode === "software" || mode === "fpga" ? mode : "auto";
  const at = atParam && atParam.trim() !== "" && Number.isFinite(Number(atParam)) ? Number(atParam) : null;

  const [datasets, setDatasets] = useState<DatasetInfo[]>([]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [status, setStatus] = useState("Loading datasets");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const parent = useRef<{ id: string; dataset: string } | null>(null);
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const loadDatasets = useCallback(async () => {
    const list = unwrap(await api.api.datasets.get());
    setDatasets(list);
    return list;
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    async function start() {
      setError(""); setLoading(true);
      const list = await loadDatasets();
      if (abort.signal.aborted) return;
      const selected = list.find((d) => d.id === datasetId) ?? (!datasetId ? defaultDataset(list) : undefined);
      if (!selected) {
        setLoading(false);
        setStatus(datasetId ? "Dataset not found. Select or upload a dataset." : "Upload a dataset to begin.");
        return;
      }
      const time = at ?? undefined;
      const parentRunId = parent.current && parent.current.dataset === selected.id ? parent.current.id : null;
      const selection = JSON.stringify([selected.id, time ?? null, runtime, parentRunId]);
      const storageKey = `operator-run:${selection}`;
      let key = sessionStorage.getItem(storageKey);
      if (!key) { key = commandKey(); sessionStorage.setItem(storageKey, key); }
      setStatus("Starting analysis run");
      let run: RunRecord;
      try {
        run = unwrap(await api.api.runs.post({ datasetId: selected.id, ...(time !== undefined ? { at: time } : {}), runtime, ...(parentRunId ? { parentRunId } : {}) }, { headers: { "idempotency-key": key }, fetch: { signal: abort.signal } }));
      } catch (e) { if (!abort.signal.aborted) sessionStorage.removeItem(storageKey); throw e; }
      while (!abort.signal.aborted && run.status !== "ready") {
        if (run.status === "failed" || run.status === "cancelled") { sessionStorage.removeItem(storageKey); throw new Error(run.error || `Run ${run.status}`); }
        setStatus(`Run ${run.status}`);
        await delay(800, abort.signal);
        run = unwrap(await api.api.runs({ id: run.id }).get({ fetch: { signal: abort.signal } }));
      }
      if (abort.signal.aborted) return;
      parent.current = { id: run.id, dataset: selected.id };
      let current = run.snapshot ?? unwrap(await api.api.runs({ id: run.id }).snapshot.get({ fetch: { signal: abort.signal } }));
      if (abort.signal.aborted) return;
      setSnapshot(current);
      setLoading(false);
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
    start().catch((e: Error) => { if (!abort.signal.aborted) { setError(e.message); setLoading(false); } });
    return () => abort.abort();
  }, [datasetId, atParam, runtime, loadDatasets]); // eslint-disable-line react-hooks/exhaustive-deps -- `at` derives from atParam

  const navigate = useCallback((patch: Record<string, string | null>, replace = false) => {
    const q = new URLSearchParams(paramsRef.current.toString());
    for (const [key, value] of Object.entries(patch)) { if (value == null) q.delete(key); else q.set(key, value); }
    const qs = q.toString();
    const url = qs ? `${pathname}?${qs}` : pathname;
    if (replace) router.replace(url, { scroll: false }); else router.push(url, { scroll: false });
  }, [router, pathname]);

  const dataset = datasets.find((d) => d.id === datasetId) ?? (!datasetId ? defaultDataset(datasets) ?? null : null);

  const commitAt = useCallback((unix: number | null) => {
    const end = dataset?.nowUnix;
    const live = unix == null || !Number.isFinite(unix) || (end != null && unix >= end);
    navigate({ at: live ? null : String(Math.round(unix / 300) * 300) }, true);
  }, [navigate, dataset?.nowUnix]);

  const setDataset = useCallback((id: string) => navigate({ dataset: id, at: null }), [navigate]);
  const setRuntime = useCallback((m: RuntimeMode) => navigate({ runtime: m === "auto" ? null : m }), [navigate]);
  const upload = useCallback(async (files: UploadFiles) => {
    const created = unwrap(await api.api.datasets.post({ network: files.network, ops: files.ops, telemetry: files.telemetry, ...(files.label ? { label: files.label } : {}) }));
    await loadDatasets();
    navigate({ dataset: created.id, at: null });
    return created;
  }, [loadDatasets, navigate]);

  return { datasets, dataset, snapshot, status, error, runtime, loading, at, commitAt, setDataset, setRuntime, upload };
}
