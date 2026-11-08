"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { DatasetInfo, LiveEvent, RunRecord, RuntimeMode } from "@hackutd/contracts";
import type { BoardStatus, Snapshot } from "@/lib/engine/types";
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

  // ---- Board feed: the backend reports whether listen.py results are arriving (BOARD_JSONL), from the FPGA or the
  // software board, with which weights and up to which telemetry time. On "Now", the console follows that time.
  const [feed, setFeed] = useState<BoardFeed | null>(null);
  const [boardAt, setBoardAt] = useState<number | undefined>(undefined);
  const lastStep = useRef(0);
  const explicitTime = atProp != null || (atParam != null && atParam !== "");
  const selectedNow = datasetProp ?? datasets.find((d) => d.id === datasetId) ?? (!datasetId ? datasets[0] : undefined);
  const range = useRef<{ id?: string; start: number; end: number }>({ start: 0, end: 0 });
  range.current = { id: selectedNow?.id, start: selectedNow?.startUnix ?? 0, end: selectedNow?.nowUnix ?? 0 };
  useEffect(() => {
    let live = true;
    const poll = async () => {
      try {
        const r = await api.api.board.get();
        if (!live || r.error || !r.data) return;
        const f = r.data as unknown as BoardFeed;
        setFeed(f);
        const ts = f.lastTsUnix;
        const { start, end } = range.current;
        // Follow the board only on "Now", only while it is sending, and only inside the dataset on screen.
        // At most one new run every 4 s so a fast replay doesn't flood the API.
        if (!explicitTime && f.online && ts != null && ts >= start && ts <= end && Date.now() - lastStep.current >= 4000) {
          setBoardAt((cur) => {
            if (cur === ts) return cur;
            lastStep.current = Date.now();
            return ts;
          });
        }
      } catch { /* the chip shows the board as offline */ }
    };
    void poll();
    const t = setInterval(poll, 2000);
    return () => { live = false; clearInterval(t); };
  }, [explicitTime]);
  // A different dataset on screen: stop following the old board time.
  const [followedFor, setFollowedFor] = useState(selectedNow?.id);
  if (followedFor !== selectedNow?.id) {
    setFollowedFor(selectedNow?.id);
    setBoardAt(undefined);
  }

  // ---- New data: a dataset uploaded elsewhere (e.g. the judges' "test" folder) is picked up within 10 s. If the
  // operator didn't choose a dataset in the URL, the console switches to the new default and says so.
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const list = await loadDatasets();
        if (datasetId) return;
        const next = defaultDataset(list);
        if (next && range.current.id && next.id !== range.current.id) {
          setNotice(`New dataset "${next.label}" detected; showing it now.`);
          router.refresh();
        }
      } catch { /* try again next tick */ }
    }, 10000);
    return () => clearInterval(t);
  }, [datasetId, loadDatasets, router]);
  const shown = useRef<string | null>(null); // dataset+runtime of the snapshot on screen

  useEffect(() => {
    const abort = new AbortController();
    async function start() {
      // Following the board only moves the time: keep the current screen until the newer run is ready.
      const same = shown.current === JSON.stringify([datasetProp?.id ?? datasetId, runtime]);
      if (!same) setSnapshot(null);
      setError("");
      const list = await loadDatasets();
      if (abort.signal.aborted) return;
      // Props take precedence over URL params
      const selected = datasetProp ?? list.find((d) => d.id === datasetId) ?? (!datasetId ? list[0] : undefined);
      if (!selected) { setStatus(datasetId ? "Dataset not found. Select or upload a dataset." : "Upload a dataset to begin."); return; }
      const time = atProp ?? (atParam && Number.isFinite(Number(atParam)) ? Number(atParam) : undefined) ?? boardAt;
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
      shown.current = JSON.stringify([datasetProp?.id ?? datasetId, runtime]);
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
        } catch (e) {
          // The run is gone (the API restarted in memory mode): stop retrying and say how to recover.
          if (e instanceof Error && /not found|\(404\)/i.test(e.message)) {
            sessionStorage.removeItem(storageKey);
            throw new Error("This analysis run no longer exists on the server. Reload the page to start a new one.");
          }
        }
      }
    }
    start().catch((e: Error) => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
    // Keyed on the dataset id: the page re-renders (LiveRefresh) pass a new object each time,
    // which used to start a new backend run every 3 seconds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetProp?.id, atProp, runtime, loadDatasets, boardAt]);

  const navigate = (patch: Record<string, string | null>) => {
    const q = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(patch)) value == null ? q.delete(key) : q.set(key, value);
    router.push(`/?${q}`);
  };
  const runtimeSelect = (
    <label className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">Checks run on</span>
      <select value={runtime} onChange={(e) => navigate({ runtime: e.target.value })} className="rounded-md bg-white px-2 py-1 text-text shadow-[0_0_0_0.5px_rgba(0,0,0,0.12)]">
        <option value="auto">Automatic</option><option value="software">Software</option><option value="fpga">FPGA board</option>
      </select>
    </label>
  );
  const upload = <Upload onUploaded={async (d) => { await loadDatasets(); navigate({ dataset: d.id, at: null }); }} />;
  return <>
    {error && <p role="alert" className="mx-auto max-w-[1344px] px-4 pt-3 text-crit">{error}</p>}
    {snapshot ? (
      <Console key={snapshot.dataset.id + runtime} snapshot={{ ...snapshot, board: boardFromFeed(feed, snapshot.dataset) }} datasets={datasets} followsBoard={boardAt != null && !explicitTime} notice={notice} onDismissNotice={() => setNotice(null)} controls={<div className="grid gap-2.5 text-[12.5px]">{runtimeSelect}{upload}</div>} />
    ) : (
      <main className="mx-auto grid max-w-[480px] gap-3 p-8 text-sm text-muted-foreground">
        <p>{status}</p>
        {datasets.length > 0 && <label className="flex items-center justify-between gap-3">Dataset <select value={datasetId ?? datasets[0].id} onChange={(e) => navigate({ dataset: e.target.value, at: null })} className="rounded-md bg-white px-2 py-1">{datasets.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}</select></label>}
        {runtimeSelect}
        {upload}
      </main>
    )}
  </>;
}

function Upload({ onUploaded }: { onUploaded: (dataset: DatasetInfo) => Promise<void> }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  return <details><summary className="cursor-pointer font-medium text-water">Upload a dataset</summary>
    <form className="mt-2 grid gap-2.5 rounded-lg bg-white p-3 text-[12.5px] shadow-[0_0_0_0.5px_rgba(0,0,0,0.12)]" onSubmit={async (event) => {
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

/** What the backend's GET /api/board returns (apps/api/src/features/runtimes/board-status.ts). */
type BoardFeed = {
  configured: boolean; online: boolean; source: "fpga" | "fakeboard" | "unverified" | null; weightsVersion: number | null;
  lastTsUnix: number | null; firstTsUnix: number | null; results: number; facilities: number; updatedAt: string | null;
  alarms: { facility: string; kind: string; tsUnix: number }[];
};

/** The toolbar chip and sidebar read the board from the snapshot shape; null = no board results for the dataset on
 *  screen (shows offline). A board replaying a different dataset doesn't count as connected to this one. */
function boardFromFeed(f: BoardFeed | null, d: { startUnix: number; nowUnix: number }): BoardStatus | null {
  if (!f || !f.configured || !f.results || f.lastTsUnix == null) return null;
  if (f.lastTsUnix < d.startUnix || f.lastTsUnix > d.nowUnix) return null;
  return {
    source: "live",
    provenance: f.source === "fpga" ? "fpga" : "software",
    online: f.online,
    mode: "NORMAL",
    lastSeenUnix: f.lastTsUnix,
    weightsVersion: f.weightsVersion,
    autonomousSinceUnix: null,
    replayedAlerts: 0,
    facilities: [],
  };
}
