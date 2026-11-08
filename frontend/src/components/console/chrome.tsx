"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSyncExternalStore, useTransition, type ReactNode } from "react";
import type { BoardStatus, DatasetInfo, SystemState } from "@/lib/engine/types";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { systemNum } from "@/lib/format";
import { ThemeToggle } from "./theme-toggle";
import { cn } from "@/lib/utils";
import { DemoModeSwitch } from "./demo-mode";
import { NemotronMark } from "./nemotron";

export type View = "overview" | "replay" | "simulation" | "handoff" | "agents";
export type SystemStatus = "ok" | "warn" | "crit" | "nodata";

// Sidebar shown or hidden with the toolbar's sidebar button; remembered in this browser.
const SIDEBAR_KEY = "bts-sidebar";
const sidebarListeners = new Set<() => void>();
const sidebarOpen = () => { try { return localStorage.getItem(SIDEBAR_KEY) !== "closed"; } catch { return true; } };
function useSidebarOpen() {
  return useSyncExternalStore((cb) => { sidebarListeners.add(cb); return () => { sidebarListeners.delete(cb); }; }, sidebarOpen, () => true);
}
function setSidebarOpen(open: boolean) {
  try { localStorage.setItem(SIDEBAR_KEY, open ? "open" : "closed"); } catch {}
  sidebarListeners.forEach((cb) => cb());
}

/** The macOS sidebar button: hides the sidebar so the console gets the whole window, and brings it back. */
export function SidebarToggle() {
  const open = useSidebarOpen();
  const label = open ? "Hide sidebar" : "Show sidebar";
  return (
    <button type="button" onClick={() => setSidebarOpen(!open)} aria-label={label} title={label} aria-expanded={open}
      className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-black/[0.04] hover:text-text">
      <svg width="18" height="16" viewBox="0 0 18 16" aria-hidden>
        <rect x="1.2" y="1.7" width="15.6" height="12.6" rx="3" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M6.5 2v12" stroke="currentColor" strokeWidth="1.3" />
        {open && <path d="M3 5h2M3 7.5h2M3 10h2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />}
      </svg>
    </button>
  );
}

/** The macOS-style window the whole console lives in (Mockup A). */
export function Window({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  const open = useSidebarOpen();
  return (
    <div className="mx-auto max-w-[1400px] p-0 sm:p-4 lg:p-7">
      <div
        className={cn(
          "grid min-h-screen grid-cols-1 overflow-hidden sm:min-h-[calc(100vh-2rem)] sm:rounded-[18px] lg:min-h-[calc(100vh-3.5rem)]", open && "lg:grid-cols-[248px_1fr]",
          "bg-white/40 backdrop-blur-[40px] backdrop-saturate-[1.8]",
          "sm:shadow-[0_0_0_0.5px_rgba(0,0,0,0.12),0_30px_80px_-30px_rgba(30,40,60,0.35),0_8px_24px_-12px_rgba(30,40,60,0.18)]",
        )}
      >
        {open && sidebar}
        <div className="relative min-w-0">{children}</div>
      </div>
    </div>
  );
}

const navIcon = {
  overview: (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <rect x="2" y="1.5" width="12" height="13" rx="3.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3 9h10v2.5A2 2 0 0 1 11 13.5H5A2 2 0 0 1 3 11.5z" fill="var(--water)" />
    </svg>
  ),
  replay: (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  ),
  simulation: (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <rect x="1.5" y="3" width="13" height="10" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6.5 6v4l3.5-2z" fill="var(--water)" />
    </svg>
  ),
  handoff: (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <path d="M3 4h10M3 8h10M3 12h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  ),
  agents: (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="3.5" r="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="3.5" cy="12" r="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="12.5" cy="12" r="2" fill="var(--nv)" />
      <path d="M7 5.3 4.4 10.2M9 5.3l2.6 4.9" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  ),
};

export function Sidebar({
  view,
  onView,
  systems,
  statusOf,
  alertCount,
  onSystem,
  systemLine,
  status = [],
  footer,
}: {
  footer?: ReactNode;
  /** One short status line under each system, e.g. "2 down · shuts 17:33". */
  systemLine?: (s: SystemState) => { text: string; tone?: "crit" | "warn" };
  /** Facts about the whole console shown under the systems. */
  status?: { label: string; value: string; tone?: "crit" | "warn" | "ok" }[];
  view: View;
  onView: (v: View) => void;
  systems: SystemState[];
  statusOf: (s: SystemState) => SystemStatus;
  alertCount: number;
  onSystem: (id: string) => void;
}) {
  const items: { id: View; label: string; count?: number }[] = [
    { id: "overview", label: "Overview", count: alertCount || undefined },
    { id: "replay", label: "Replay week" },
    { id: "simulation", label: "Simulation" },
    { id: "handoff", label: "Shift handoff" },
  ];
  return (
    <aside className="border-b-[0.5px] border-line bg-[rgba(236,238,242,0.72)] px-3 pt-4 pb-3 backdrop-blur-[50px] backdrop-saturate-[1.8] lg:border-r-[0.5px] lg:border-b-0 lg:pb-4">
      <div className="hidden gap-2 px-2 pb-5 lg:flex" aria-hidden>
        <i className="block size-3 rounded-full bg-[#ff5f57] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.15)]" />
        <i className="block size-3 rounded-full bg-[#febc2e] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.15)]" />
        <i className="block size-3 rounded-full bg-[#28c840] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.15)]" />
      </div>

      <nav aria-label="Views" className="flex flex-wrap gap-1 lg:flex-col lg:flex-nowrap lg:gap-0">
        {items.map((it) => (
          <button
            key={it.id}
            type="button"
            onClick={() => onView(it.id)}
            aria-current={view === it.id ? "page" : undefined}
            className={cn(
              "flex shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13.5px] whitespace-nowrap text-text transition-colors",
              view === it.id ? "bg-black/[0.07] font-semibold" : "hover:bg-black/[0.04]",
            )}
          >
            {navIcon[it.id]}
            {it.label}
            {it.count != null && <span className="ml-auto pl-3 text-[12.5px] font-normal text-faint">{it.count}</span>}
          </button>
        ))}
      </nav>

      <p className="hidden px-2.5 pt-4 pb-1.5 text-[11px] font-semibold text-faint lg:block">Systems</p>
      <nav aria-label="Systems" className="mt-2 flex flex-wrap gap-1 lg:mt-0 lg:flex-col lg:flex-nowrap lg:gap-0">
        {systems.map((s) => {
          const st = statusOf(s);
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onSystem(s.id)}
              className="flex shrink-0 items-start gap-2.5 rounded-lg px-2.5 py-[7px] text-left text-[13.5px] whitespace-nowrap text-text transition-colors hover:bg-black/[0.04]"
            >
              <span
                className={cn(
                  "mt-[6px] size-2 shrink-0 rounded-full",
                  st === "crit" ? "bg-crit" : st === "warn" ? "bg-warn-fill" : st === "nodata" ? "bg-[#8e8e93]" : "bg-[#34c759]",
                )}
                aria-hidden
              />
              <span className="min-w-0">
                System {systemNum(s.id)}
                {systemLine && (() => {
                  const l = systemLine(s);
                  return (
                    <span className={cn("hidden max-w-[170px] truncate text-[12px] leading-tight lg:block", l.tone === "crit" ? "font-medium text-crit" : l.tone === "warn" ? "font-medium text-warn" : "text-faint")}>
                      {l.text}
                    </span>
                  );
                })()}
              </span>
              <span className="sr-only">
                {st === "crit" ? ", pump down" : st === "warn" ? ", needs an inspector" : st === "nodata" ? ", no data" : ", normal"}
              </span>
              <span className="ml-auto pt-px pl-3 text-[12.5px] text-faint">
                <span className="sr-only">. </span>
                {s.facilities.length}
                <span className="sr-only"> {s.facilities.length === 1 ? "facility" : "facilities"}</span>
              </span>
            </button>
          );
        })}
      </nav>

      {status.length > 0 && (
        <>
          <p className="hidden px-2.5 pt-5 pb-1.5 text-[11px] font-semibold text-faint lg:block">Status</p>
          <dl className="hidden px-2.5 text-[12.5px] lg:block">
            {status.map((x) => (
              <div key={x.label} className="flex items-baseline justify-between gap-3 py-[5px]">
                <dt className="text-muted-foreground">{x.label}</dt>
                <dd className={cn("truncate text-right font-medium tabular-nums", x.tone === "crit" ? "text-crit" : x.tone === "warn" ? "text-warn" : x.tone === "ok" ? "text-[#248a3d]" : "text-text")}>{x.value}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      {footer && (
        <div className="hidden px-2.5 lg:block">
          <p className="pt-5 pb-2 text-[11px] font-semibold text-faint">Data</p>
          {footer}
        </div>
      )}
    </aside>
  );
}

export function Toolbar({
  datasets,
  current,
  replay,
  onReplay,
  atUnix,
  board,
}: {
  datasets: DatasetInfo[];
  current: DatasetInfo;
  replay: boolean;
  onReplay: (on: boolean) => void;
  atUnix?: number;
  /** undefined = local mode (nothing shown); null = configured but unreachable. */
  board?: BoardStatus | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const wall = (
    <Link href={`/live?${new URLSearchParams({ dataset: current.id })}`} className="shrink-0 rounded-lg bg-[#0a0e13] px-2.5 py-1 text-[13px] font-semibold text-white hover:opacity-90">
      Night shift view
    </Link>
  );
  const nemotron = (
    <Link
      href={`/how-it-works?${new URLSearchParams({ dataset: current.id, ...(atUnix ? { at: String(atUnix) } : {}) })}`}
      className={cn(
        board === undefined ? "ml-auto" : "shrink-0",
        "flex items-center gap-2 rounded-lg px-1.5 py-1 text-[13px] text-muted-foreground transition-colors hover:bg-black/[0.04]",
      )}
    >
      <NemotronMark className="size-[18px]" />
      <span>
        <span className="hidden sm:inline">Agents run on </span>
        <b className="font-semibold text-text">NVIDIA Nemotron</b>
      </span>
    </Link>
  );
  return (
    <div className="sticky top-0 z-20 flex flex-wrap items-center gap-3 border-b-[0.5px] border-line bg-white/55 px-4 py-3.5 backdrop-blur-[30px] backdrop-saturate-[1.8] sm:px-7">
      <SidebarToggle />
      <div role="radiogroup" aria-label="Time" className="inline-flex rounded-[9px] bg-[rgba(118,118,128,0.12)] p-0.5">
        {(["Now", "Replay"] as const).map((label) => {
          const on = label === "Replay" ? replay : !replay;
          return (
            <button
              key={label}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              onClick={() => onReplay(label === "Replay")}
              onKeyDown={(e) => {
                if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
                e.preventDefault();
                const toReplay = label === "Now";
                onReplay(toReplay);
                e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=radio]")[toReplay ? 1 : 0]?.focus();
              }}
              className={cn(
                "rounded-[7px] px-3.5 py-1 text-[13px] text-text transition-[background-color,box-shadow] duration-150",
                on && "bg-white font-semibold shadow-[0_1px_2px_rgba(0,0,0,0.12),0_0_0_0.5px_rgba(0,0,0,0.04)]",
              )}
            >
              {label}
            </button>
          );
        })}
      </div>

      <DemoModeSwitch />

      <Select value={current.id} onValueChange={(v) => start(() => router.push(`/?dataset=${encodeURIComponent(String(v))}`))}>
        <SelectTrigger
          aria-label="Dataset"
          className="h-auto rounded-lg border-0 bg-white py-[5px] pr-2.5 pl-3 text-[13px] shadow-[0_0_0_0.5px_rgba(0,0,0,0.12),0_1px_2px_rgba(0,0,0,0.06)] [&>svg:last-child]:hidden"
        >
          <SelectValue>{current.label}</SelectValue>
          {/* Mockup A's up/down popup chevron in place of the shared down arrow (hidden above). */}
          <svg width="9" height="12" viewBox="0 0 9 12" className="size-auto" style={{ width: 9, height: 12 }} aria-hidden>
            <path d="M1.5 4.5 4.5 1.5l3 3M1.5 7.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </SelectTrigger>
        <SelectContent>
          {datasets.map((d) => (
            <SelectItem key={d.id} value={d.id}>
              {d.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {pending && <span className="text-[13px] text-faint">Loading…</span>}

      {board === undefined ? (
        <>
          {nemotron}
          {wall}
          <ProvidersLink />
          <ThemeToggle />
        </>
      ) : (
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <BoardChip board={board} />
          {nemotron}
          {wall}
          <ProvidersLink />
          <ThemeToggle />
        </div>
      )}
    </div>
  );
}

function ProvidersLink() {
  return (
    <Link href="/internal/providers" title="Which model provider and key are in use" className="rounded-lg px-1.5 py-1 text-[13px] text-faint hover:bg-black/[0.04] hover:text-text">
      Providers
    </Link>
  );
}

/** Board health beside the Nemotron badge. Only rendered when a board is configured (live or simulated). */
function BoardChip({ board }: { board: BoardStatus | null }) {
  const state =
    !board || board.provenance === "unavailable" || (!board.online && board.provenance !== "software")
      ? board?.mode === "AUTONOMOUS"
        ? "own"
        : "offline"
      : board.provenance === "software"
        ? "software"
        : board.mode === "AUTONOMOUS"
          ? "own"
          : "online";
  const simulated = board?.source === "simulated";
  const label =
    state === "online" ? "Board online" : state === "own" ? "Board on its own" : state === "software" ? "Software board" : "Board offline";
  const detail =
    state === "offline"
      ? "The server is running the checks in software"
      : state === "own"
        ? "The board lost the server and is watching on its own"
        : state === "software"
          ? "Results come from the software copy of the board (fakeboard), not the FPGA"
        : board?.weightsVersion != null
          ? board.weightsVersion === 240
            ? "Untrained test weights (v240)"
            : `Model v${board.weightsVersion}`
          : undefined;
  const title = [simulated ? "Simulated board, not model output" : undefined, detail].filter(Boolean).join(". ") || undefined;
  return (
    <span
      role="status"
      title={title}
      className="flex max-w-full items-center gap-1.5 rounded-lg bg-white px-2.5 py-[5px] text-[13px] text-text shadow-[0_0_0_0.5px_rgba(0,0,0,0.12),0_1px_2px_rgba(0,0,0,0.06)]"
    >
      <span
        className={cn("size-2 shrink-0 rounded-full", state === "online" ? "bg-[#34c759]" : state === "own" ? "bg-warn-fill" : state === "software" ? "bg-water" : "bg-[#8e8e93]")}
        aria-hidden
      />
      <span className="min-w-0">
        {label}
        {simulated && <span className="font-medium text-warn"> (simulated)</span>}
        {state === "offline" && <span className="sr-only text-faint lg:not-sr-only">, server running the checks</span>}
        {detail && state !== "offline" && <span className="sr-only">. {detail}</span>}
      </span>
    </span>
  );
}
