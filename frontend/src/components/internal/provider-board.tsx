"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type LaneState = "in-use" | "standby" | "cooling" | "unconfigured";

interface ProviderStatus {
  primary: "brev" | "openrouter" | "none";
  next: { lane: "brev" | "openrouter" | "none"; model: string | null; keyId: string | null };
  lastChat: { at: string; lane: "brev" | "openrouter"; model: string; keyId: string | null } | null;
  brev: {
    configured: boolean;
    host: string | null;
    model: string | null;
    state: LaneState;
    cooldownUntil: string | null;
    successes: number;
    failures: number;
    lastStatus: number | null;
    lastError: string | null;
    lastUsedAt: string | null;
  };
  openrouter: {
    configured: boolean;
    models: { id: string; state: "ready" | "cooling"; cooldownUntil: string | null }[];
    keys: {
      id: string;
      hint: string;
      state: "in-use" | "standby" | "cooling";
      cooldownUntil: string | null;
      successes: number;
      failures: number;
      lastStatus: number | null;
      lastError: string | null;
      lastUsedAt: string | null;
      freeTier: boolean | null;
    }[];
  };
  recent: {
    at: string;
    kind: "chat" | "probe";
    lane: "brev" | "openrouter";
    keyId: string | null;
    model: string;
    ok: boolean;
    status: number | null;
    error: string | null;
  }[];
}

const stateLabel: Record<LaneState | "ready", string> = {
  "in-use": "In use",
  standby: "Standby",
  cooling: "Cooling",
  unconfigured: "Not configured",
  ready: "Ready",
};

function clock(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function stateClass(state: string): string {
  if (state === "in-use" || state === "ready") return "text-ok";
  if (state === "cooling") return "text-warn";
  return "text-faint";
}

export function ProviderBoard() {
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updated, setUpdated] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);

  const load = useCallback(async (path: string, method = "GET") => {
    const res = await fetch(path, { method, cache: "no-store" });
    if (!res.ok) throw new Error(`Status request failed (${res.status})`);
    return await res.json() as ProviderStatus;
  }, []);

  useEffect(() => {
    let gone = false;
    const tick = () => {
      load("/api/backend/api/internal/providers")
        .then((next) => { if (!gone) { setStatus(next); setError(null); setUpdated(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })); } })
        .catch((reason: unknown) => { if (!gone) setError(reason instanceof Error ? reason.message : "Could not load provider status"); });
    };
    tick();
    const timer = setInterval(tick, 3000);
    return () => { gone = true; clearInterval(timer); };
  }, [load]);

  async function probe() {
    setProbing(true);
    try {
      const next = await load("/api/backend/api/internal/providers/probe", "POST");
      setStatus(next);
      setError(null);
      setUpdated(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Key check failed");
    } finally {
      setProbing(false);
    }
  }

  const nextLine = !status ? "Loading…"
    : status.next.lane === "none" ? "No model provider is configured."
    : status.next.lane === "brev" ? `Next chat: Brev · ${status.next.model ?? "model unset"}`
    : `Next chat: OpenRouter · ${status.next.keyId ?? "key"} · ${status.next.model ?? "model unset"}`;

  return (
    <main className="mx-auto max-w-[960px] px-5 pt-8 pb-24 sm:px-8">
      <Link href="/" className="text-[14px] text-muted-foreground hover:text-text">Console</Link>
      <div className="mt-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[12px] font-medium tracking-[0.04em] text-faint uppercase">Internal</p>
          <h1 className="mt-1 font-display text-[32px] font-bold tracking-display text-text">Model providers</h1>
        </div>
        <button
          type="button"
          onClick={() => void probe()}
          disabled={probing}
          className="rounded-lg bg-text px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
        >
          {probing ? "Checking…" : "Check keys"}
        </button>
      </div>
      <p className="mt-3 max-w-[62ch] text-[15px] leading-relaxed text-muted-foreground">
        Brev takes the first chat. When that call errors, the same request goes to a free Nemotron model on OpenRouter and the next key in <span className="font-mono text-[13px] text-text">OPENROUTER_API_KEYS</span>. Keys are masked. This page shows the API process that runs the agents.
      </p>
      {error && <p className="mt-4 text-[14px] text-crit">{error}</p>}
      <p className="mt-6 text-[15px] font-medium text-text">{nextLine}</p>
      {status?.lastChat && (
        <p className="mt-1 text-[13px] text-faint">
          Last completed chat {clock(status.lastChat.at)} on {status.lastChat.lane === "brev" ? "Brev" : "OpenRouter"}
          {status.lastChat.keyId ? ` · ${status.lastChat.keyId}` : ""} · {status.lastChat.model}
        </p>
      )}
      {updated && <p className="mt-1 text-[12px] text-faint">Updated {updated}</p>}

      <section className="glass mt-6 p-4 sm:p-5">
        <h2 className="font-display text-[18px] font-bold tracking-display text-text">Brev</h2>
        {status && (
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[13px] sm:grid-cols-4">
            <Stat label="State" value={stateLabel[status.brev.state]} className={stateClass(status.brev.state)} />
            <Stat label="Host" value={status.brev.host ?? "—"} />
            <Stat label="Chats" value={`${status.brev.successes} ok · ${status.brev.failures} failed`} />
            <Stat label="Last status" value={status.brev.lastStatus ? String(status.brev.lastStatus) : "—"} />
            <div className="col-span-2 sm:col-span-4">
              <dt className="text-faint">Model</dt>
              <dd className="mt-0.5 font-mono text-[12.5px] text-text">{status.brev.model ?? "—"}</dd>
            </div>
            {status.brev.lastError && <div className="col-span-2 text-[13px] sm:col-span-4"><span className="text-faint">Last error · </span><span className="text-crit">{status.brev.lastError}</span></div>}
            {status.brev.cooldownUntil && <div className="col-span-2 text-faint sm:col-span-4">Cooling until {clock(status.brev.cooldownUntil)}</div>}
          </dl>
        )}
      </section>

      <section className="glass mt-4 p-4 sm:p-5">
        <h2 className="font-display text-[18px] font-bold tracking-display text-text">OpenRouter keys</h2>
        <p className="mt-1 text-[13px] text-faint">Free Nemotron chat models only. A cooling key is skipped until its timer ends.</p>
        {status && status.openrouter.models.length > 0 && (
          <ul className="mt-3 flex flex-col gap-1">
            {status.openrouter.models.map((model) => (
              <li key={model.id} className="flex flex-wrap items-baseline justify-between gap-2 text-[13px]">
                <span className="font-mono text-[12.5px] text-text">{model.id}</span>
                <span className={stateClass(model.state)}>{stateLabel[model.state]}{model.state === "cooling" ? ` until ${clock(model.cooldownUntil)}` : ""}</span>
              </li>
            ))}
          </ul>
        )}
        {status && status.openrouter.keys.length === 0 && <p className="mt-3 text-[14px] text-muted-foreground">No OpenRouter keys are set.</p>}
        {status && status.openrouter.keys.length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <thead className="text-faint">
                <tr className="border-b border-line">
                  <th className="py-2 pr-3 font-medium">Key</th>
                  <th className="py-2 pr-3 font-medium">State</th>
                  <th className="py-2 pr-3 font-medium">Chats</th>
                  <th className="py-2 pr-3 font-medium">Last</th>
                  <th className="py-2 font-medium">Error</th>
                </tr>
              </thead>
              <tbody>
                {status.openrouter.keys.map((key) => (
                  <tr key={key.id} className="border-b border-line-soft align-top">
                    <td className="py-2 pr-3 font-mono text-[12.5px] text-text">{key.id} {key.hint}{key.freeTier === false ? " · paid tier" : ""}</td>
                    <td className={`py-2 pr-3 ${stateClass(key.state)}`}>{stateLabel[key.state]}{key.cooldownUntil ? ` · ${clock(key.cooldownUntil)}` : ""}</td>
                    <td className="num py-2 pr-3 text-text">{key.successes} ok · {key.failures} failed</td>
                    <td className="num py-2 pr-3 text-text">{key.lastStatus ?? "—"} <span className="text-faint">{clock(key.lastUsedAt)}</span></td>
                    <td className="py-2 text-crit">{key.lastError ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="glass mt-4 p-4 sm:p-5">
        <h2 className="font-display text-[18px] font-bold tracking-display text-text">Recent calls</h2>
        {status && status.recent.length === 0 && <p className="mt-3 text-[14px] text-muted-foreground">No model calls in this process yet.</p>}
        {status && status.recent.length > 0 && (
          <ul className="mt-3 divide-y divide-line-soft">
            {status.recent.map((event, index) => (
              <li key={`${event.at}-${index}`} className="grid grid-cols-1 gap-1 py-2 text-[13px] sm:grid-cols-[88px_72px_1fr]">
                <span className="num text-faint">{clock(event.at)}</span>
                <span className={event.ok ? "text-ok" : "text-crit"}>{event.ok ? "ok" : event.status ?? "error"} {event.kind}</span>
                <span className="text-text">
                  {event.lane === "brev" ? "Brev" : "OpenRouter"}
                  {event.keyId ? ` · ${event.keyId}` : ""} · <span className="font-mono text-[12px]">{event.model}</span>
                  {event.error ? <span className="mt-0.5 block text-crit">{event.error}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div>
      <dt className="text-faint">{label}</dt>
      <dd className={`mt-0.5 text-text ${className ?? ""}`}>{value}</dd>
    </div>
  );
}
