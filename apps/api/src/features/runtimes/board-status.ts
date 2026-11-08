import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import type { BoardSource } from "./board";

/**
 * Live status of the board feed for the console: is listen.py writing results (BOARD_JSONL), from which source,
 * with which weights, and up to which telemetry time. Read-only and incremental (only new bytes are parsed), so
 * polling it every couple of seconds is cheap. Detections themselves still come from readBoardIndex per run.
 */
export interface BoardFeedStatus {
  configured: boolean;            // BOARD_JSONL is set
  online: boolean;                // the file grew in the last ONLINE_MS
  source: BoardSource | null;     // "fpga", "fakeboard" or "unverified" (from the lines, else BOARD_SOURCE)
  weightsVersion: number | null;  // weights_ver of the latest result
  lastTsUnix: number | null;      // newest telemetry timestamp the board has answered for
  firstTsUnix: number | null;
  results: number;                // result lines read so far
  facilities: number;             // distinct facilities seen
  updatedAt: string | null;       // when the file last changed (ISO)
  alarms: { facility: string; kind: string; tsUnix: number }[]; // latest raised Night Shift / E-STOP per facility, still raised
}

const ONLINE_MS = 15_000;

export class BoardFeed {
  private offset = 0;
  private rest = "";
  private state = { results: 0, first: null as number | null, last: null as number | null, source: null as BoardSource | null, weights: null as number | null, facilities: new Set<string>(), alarms: new Map<string, { kind: string; tsUnix: number }>() };
  private mtimeMs = 0;

  constructor(private readonly path: string | undefined, private readonly fallback: BoardSource | undefined) {}

  private reset() {
    this.offset = 0; this.rest = "";
    this.state = { results: 0, first: null, last: null, source: null, weights: null, facilities: new Set(), alarms: new Map() };
  }

  private readNew() {
    if (!this.path || !existsSync(this.path)) { this.reset(); this.mtimeMs = 0; return; }
    const st = statSync(this.path);
    if (st.size < this.offset) this.reset(); // file was truncated or replaced: start over
    this.mtimeMs = st.mtimeMs;
    if (st.size === this.offset) return;
    const fd = openSync(this.path, "r");
    try {
      const buf = Buffer.alloc(st.size - this.offset);
      readSync(fd, buf, 0, buf.length, this.offset);
      this.offset = st.size;
      const lines = (this.rest + buf.toString("utf8")).split("\n");
      this.rest = lines.pop() ?? ""; // keep a partly written last line for the next read
      for (const line of lines) this.take(line);
    } finally { closeSync(fd); }
  }

  private take(line: string) {
    if (!line.trim()) return;
    let o: Record<string, unknown>;
    try { o = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    const ts = typeof o.ts_unix === "number" ? o.ts_unix : null;
    const fac = typeof o.facility === "string" ? o.facility : null;
    if (o.type === "result" && ts != null) {
      this.state.results++;
      if (fac) this.state.facilities.add(fac);
      if (this.state.first == null || ts < this.state.first) this.state.first = ts;
      if (this.state.last == null || ts >= this.state.last) {
        this.state.last = ts;
        if (typeof o.weights_ver === "number") this.state.weights = o.weights_ver;
      }
      if (o.source === "fpga" || o.source === "fakeboard") this.state.source = o.source;
    } else if (o.type === "alert" && fac && ts != null) {
      const kind = String(o.kind ?? "");
      if (kind === "night_shift_raised" || kind === "estop_raised") this.state.alarms.set(fac, { kind: kind === "estop_raised" ? "e_stop" : "night_shift", tsUnix: ts });
      else if (kind === "cleared") this.state.alarms.delete(fac);
    }
  }

  status(): BoardFeedStatus {
    this.readNew();
    const s = this.state;
    return {
      configured: !!this.path,
      online: this.mtimeMs > 0 && Date.now() - this.mtimeMs < ONLINE_MS,
      source: s.source ?? (s.results ? this.fallback ?? "unverified" : null),
      weightsVersion: s.weights,
      lastTsUnix: s.last,
      firstTsUnix: s.first,
      results: s.results,
      facilities: s.facilities.size,
      updatedAt: this.mtimeMs ? new Date(this.mtimeMs).toISOString() : null,
      alarms: [...s.alarms].map(([facility, a]) => ({ facility, ...a })),
    };
  }
}
