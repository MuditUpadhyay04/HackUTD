"use client";
// Ticker (brief 2.1, softened). Five soft stat chips plus a More popover, from tickerAt(snapshot, t). Digits roll via NumberFlow when a value
// changes; the changed cell gets an amber underline that fades over 600ms. Alarms are display-only (hard rule 8);
// the BOARD cell carries provenance (hard rule 11); unknown values read Unknown in a dithered chip (hard rule 9).
import "./ticker.css";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import NumberFlow from "@number-flow/react";
import type { Snapshot } from "@/lib/engine/types";
import { tickerAt, tickerText, type TickerItem } from "@/lib/v4/derive";
import { usePlayhead } from "@/lib/v4/store";

/** The five primary chips; everything else lives behind the "More" chip (docs/ui-v4-soften.md section 4). */
const PRIMARY = ["now", "pumpsDown", "firstShutdown", "plan", "trucksFree"];
/** Higher numbers hide first at narrow widths (see ticker.css). Now and Pumps down always stay. */
const PRIORITY: Record<string, 0 | 1 | 2> = { now: 0, pumpsDown: 0, firstShutdown: 1, plan: 1, trucksFree: 2 };

/** Display-only softening of engine strings ("NONE", "UNAVAILABLE") into sentence case. */
function soft(text: string): string {
  if (text === text.toUpperCase() && /[A-Z]{2}/.test(text) && !/^FPGA/.test(text)) return text.charAt(0) + text.slice(1).toLowerCase();
  if (text.startsWith("SOFTWARE")) return "Software, not bit-exact";
  return text;
}

/** Splits "Oct 8, 12:00" into text and digit runs; each digit run rolls on its own. */
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
  if (item.projected && typeof v === "string") return <span className="tk-proj">{soft(text)}</span>;
  if (v == null) return <span className="tk-unknown">Unknown</span>;
  if (typeof v === "number" && item.unit === "count") return <NumberFlow value={v} format={{ useGrouping: false }} />;
  if (typeof v === "number" && item.unit === "usd") return <NumberFlow value={Math.round(v)} prefix="$" format={{ maximumFractionDigits: 0 }} />;
  return <Rolling text={soft(text)} />;
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
    <div className="tk-c" data-unknown={item.value == null ? "true" : undefined} data-k={item.key} data-p={PRIORITY[item.key] ?? 1} data-hot={hot} data-projected={item.projected ? "true" : undefined} title={item.projected ? "Projection, not recorded: a what-if simulation past the last reading" : title}>
      <span className="tk-l">{item.label}</span>
      <span className="tk-v"><Value item={item} text={text} /></span>
      <i className="tk-ul" ref={ul} />
    </div>
  );
});

function More({ items }: { items: TickerItem[] }) {
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
  // Attention dot when something behind More needs a look (never color alone: the popover rows carry the text).
  const alert = items.some((i) => (i.key === "inspect" || i.key === "noData" || i.key === "alarms") && typeof i.value === "number" && i.value > 0);
  return (
    <div className="tk-more" ref={root}>
      <button
        type="button"
        className="tk-c tk-chip press"
        aria-expanded={open}
        aria-haspopup="true"
        // detail is 0 for keyboard-initiated clicks: those open instantly (Emil rule).
        onClick={(e) => { setInstant(e.detail === 0); setOpen((o) => !o); }}
      >
        <span className="tk-l">More</span>
        {alert && <i className="tk-dot" aria-hidden="true" />}
      </button>
      {open && (
        <div className="tk-pop" role="group" aria-label="More status" data-instant={instant}>
          {items.map((it) => (
            <div key={it.key} className="tk-row2" data-k={it.key} data-unknown={it.value == null ? "true" : undefined}>
              <span className="tk-l">{it.label}</span>
              <span className="tk-v"><Value item={it} text={tickerText(it)} /></span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Ticker({ snapshot }: { snapshot: Snapshot }) {
  // Select a primitive (the minute); an array selector would change identity on every store notification.
  const minute = usePlayhead((s) => Math.round(s.t / 60));
  const approved = usePlayhead((s) => s.approved);
  const items = useMemo(() => tickerAt(snapshot, minute * 60, approved), [snapshot, minute, approved]);
  const primary = PRIMARY.map((k) => items.find((i) => i.key === k)).filter((i): i is TickerItem => i != null);
  const rest = items.filter((i) => !PRIMARY.includes(i.key));
  return (
    <div className="tk" role="group" aria-label="Status ticker">
      <div className="tk-row">
        {primary.map((it) => <Cell key={it.key} item={it} />)}
        <More items={rest} />
      </div>
    </div>
  );
}
