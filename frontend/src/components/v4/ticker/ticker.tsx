"use client";
// Ticker (brief 2.1). Static strip of mono KV cells from tickerAt(snapshot, t). Digits roll via NumberFlow when a value
// changes; the changed cell gets an amber underline that fades over 600ms. Alarms are display-only (hard rule 8);
// the BOARD cell carries provenance (hard rule 11); unknown values read UNKNOWN in a dithered cell (hard rule 9).
import "./ticker.css";
import { memo, useEffect, useMemo, useRef } from "react";
import NumberFlow from "@number-flow/react";
import type { Snapshot } from "@/lib/engine/types";
import { tickerAt, tickerText, type TickerItem } from "@/lib/v4/derive";
import { usePlayhead } from "@/lib/v4/store";

/** 0 keeps its place at every width; higher numbers hide first (see ticker.css). */
const PRIORITY: Record<string, 0 | 1 | 2> = {
  now: 0, pumpsDown: 0, firstShutdown: 0, plan: 0,
  ifNobodyActs: 1, trucksFree: 1, board: 1,
  inspect: 2, noData: 2, alarms: 2,
};

/** Splits "OCT 08 12:00" into text and digit runs; each digit run rolls on its own. */
function Rolling({ text }: { text: string }) {
  const parts = text.split(/(\d+)/).filter((p) => p !== "");
  return (
    <>
      <span aria-hidden="true">
        {parts.map((p, i) => /^\d+$/.test(p)
          ? <NumberFlow key={i} value={Number(p)} format={{ minimumIntegerDigits: p.length, useGrouping: false }} />
          : <span key={i}>{p}</span>)}
      </span>
      <span className="tk-sr">{text}</span>
    </>
  );
}

function Value({ item, text }: { item: TickerItem; text: string }) {
  const v = item.value;
  if (item.projected && typeof v === "string") return <span className="tk-proj">{text}</span>;
  if (v == null) return <span className="tk-unknown">UNKNOWN</span>;
  if (typeof v === "number" && item.unit === "count") return <NumberFlow value={v} format={{ useGrouping: false }} />;
  if (typeof v === "number" && item.unit === "usd") return <NumberFlow value={Math.round(v)} prefix="$" format={{ maximumFractionDigits: 0 }} />;
  return <Rolling text={text} />;
}

const Cell = memo(function Cell({ item }: { item: TickerItem }) {
  const text = tickerText(item);
  const ul = useRef<HTMLElement>(null);
  const prev = useRef<string | null>(null);
  useEffect(() => {
    const was = prev.current;
    prev.current = text;
    const el = ul.current;
    // NOW changes by definition of the playhead; every other cell flashes when its value changes.
    if (was === null || was === text || item.key === "now" || !el) return;
    el.style.transition = "none";
    el.style.opacity = "1";
    void el.offsetWidth; // commit the instant "on" state so the fade restarts every time
    el.style.transition = "";
    el.style.opacity = "";
  }, [text, item.key]);
  const hot = item.key === "pumpsDown" && typeof item.value === "number" && item.value > 0;
  const title = item.key === "alarms" ? "Board alarms (E-STOP, Night Shift), display only" : item.key === "board" ? "Board provenance" : undefined;
  return (
    <div className="tk-c" data-k={item.key} data-p={PRIORITY[item.key] ?? 1} data-hot={hot} data-projected={item.projected ? "true" : undefined} title={item.projected ? "PROJECTED: a what-if simulation past the last reading, not recorded telemetry" : title}>
      <span className="label">{item.label}</span>
      <span className="tk-v"><Value item={item} text={text} /></span>
      <i className="tk-ul" ref={ul} />
    </div>
  );
});

export function Ticker({ snapshot }: { snapshot: Snapshot }) {
  // Select a primitive (the minute); an array selector would change identity on every store notification.
  const minute = usePlayhead((s) => Math.round(s.t / 60));
  const approved = usePlayhead((s) => s.approved);
  const items = useMemo(() => tickerAt(snapshot, minute * 60, approved), [snapshot, minute, approved]);
  return (
    <div className="tk" role="group" aria-label="Status ticker">
      <div className="tk-row">
        {items.map((it) => <Cell key={it.key} item={it} />)}
      </div>
    </div>
  );
}
