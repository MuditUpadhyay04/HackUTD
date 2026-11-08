"use client";

import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Widgets the operator can put in their own order by dragging the arc in a widget's bottom-right corner (or with the
 * arrow keys on it). Reorder only, never resize. The default order is the layout as designed; a new order is kept in
 * this browser.
 */
export type Widget = { id: string; label: string; node: ReactNode; className?: string };

const listeners = new Set<() => void>();
const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, ids: string[]) => { try { localStorage.setItem(key, JSON.stringify(ids)); } catch {} listeners.forEach((l) => l()); };
const subscribe = (l: () => void) => {
  listeners.add(l);
  const onStorage = () => l();
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(l); window.removeEventListener("storage", onStorage); };
};

/** Saved order, keeping only widgets that still exist and adding new ones where the design puts them. */
function arrange(saved: string | null, ids: string[]) {
  let order: string[] = [];
  try { const v: unknown = saved ? JSON.parse(saved) : null; if (Array.isArray(v)) order = v.filter((x): x is string => typeof x === "string" && ids.includes(x)); } catch {}
  ids.forEach((id, i) => { if (!order.includes(id)) order.splice(Math.min(i, order.length), 0, id); });
  return order;
}

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function Rearrange({ storageKey, widgets, className }: { storageKey: string; widgets: Widget[]; className?: string }) {
  const saved = useSyncExternalStore(subscribe, () => read(storageKey), () => null);
  const ids = widgets.map((w) => w.id);
  const order = arrange(saved, ids);
  const byId = new Map(widgets.map((w) => [w.id, w]));
  const els = useRef(new Map<string, HTMLDivElement>());
  const before = useRef<Map<string, DOMRect> | null>(null);
  const drag = useRef<{ id: string; x: number; y: number; rects: Map<string, DOMRect> } | null>(null);
  const [dragging, setDragging] = useState<{ id: string; dx: number; dy: number; target: string | null } | null>(null);

  // Glide every widget from where it was to its new place (FLIP), after a drop or a keyboard move.
  useLayoutEffect(() => {
    const prev = before.current; before.current = null;
    if (!prev || reduced()) return;
    els.current.forEach((el, id) => {
      const a = prev.get(id), b = el.getBoundingClientRect();
      if (!a || (a.left === b.left && a.top === b.top)) return;
      el.animate([{ transform: `translate(${a.left - b.left}px, ${a.top - b.top}px)` }, { transform: "none" }], { duration: 240, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
    });
  }, [saved]);

  const move = (id: string, to: number) => {
    const from = order.indexOf(id);
    if (from < 0 || to < 0 || to >= order.length || to === from) return;
    before.current = new Map([...els.current].map(([k, el]) => [k, el.getBoundingClientRect()]));
    const next = [...order]; next.splice(from, 1); next.splice(to, 0, id);
    write(storageKey, next);
  };

  const targetAt = (x: number, y: number, self: string, rects: Map<string, DOMRect>) => {
    for (const [id, r] of rects) if (id !== self && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return id;
    return null;
  };

  return (
    <div className={className}>
      {order.map((id) => {
        const w = byId.get(id)!;
        const lifted = dragging?.id === id;
        return (
          <div key={id} ref={(el) => { if (el) els.current.set(id, el); else els.current.delete(id); }}
            className={cn("group/widget relative grid min-w-0", w.className, lifted && "z-30", dragging?.target === id && "rounded-[18px] outline-2 outline-offset-2 outline-[var(--water)] outline-dashed")}
            style={lifted ? { transform: `translate(${dragging.dx}px, ${dragging.dy}px) scale(1.01)`, filter: "drop-shadow(0 18px 30px rgba(20,30,50,0.22))", transition: "none", cursor: "grabbing" } : undefined}>
            {w.node}
            <button type="button" aria-label={`Move ${w.label}. Drag, or use the arrow keys`} title="Drag to move"
              className={cn("absolute right-0 bottom-0 z-10 grid size-8 touch-none place-items-center rounded-br-[18px] text-faint opacity-60 transition-opacity outline-offset-[-2px]",
                "group-hover/widget:opacity-100 hover:text-muted-foreground focus-visible:opacity-100", lifted ? "cursor-grabbing opacity-100 text-water" : "cursor-grab")}
              onKeyDown={(e) => {
                const step = e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : 0;
                if (!step) return;
                e.preventDefault();
                move(id, order.indexOf(id) + step);
                requestAnimationFrame(() => els.current.get(id)?.querySelector<HTMLButtonElement>(":scope > button")?.focus());
              }}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                drag.current = { id, x: e.clientX, y: e.clientY, rects: new Map([...els.current].map(([k, el]) => [k, el.getBoundingClientRect()])) };
                setDragging({ id, dx: 0, dy: 0, target: null });
              }}
              onPointerMove={(e) => {
                const d = drag.current; if (!d) return;
                setDragging({ id, dx: e.clientX - d.x, dy: e.clientY - d.y, target: targetAt(e.clientX, e.clientY, id, d.rects) });
              }}
              onPointerUp={(e) => {
                const d = drag.current; drag.current = null;
                if (!d) return;
                const target = targetAt(e.clientX, e.clientY, id, d.rects);
                setDragging(null);
                if (target) move(id, order.indexOf(target));
              }}
              onPointerCancel={() => { drag.current = null; setDragging(null); }}>
              {/* the corner arc: follows the widget's rounded corner, like a window's grab corner */}
              <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden>
                <path d="M24.8 15.9 A11 11 0 0 1 15.9 24.8" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}
