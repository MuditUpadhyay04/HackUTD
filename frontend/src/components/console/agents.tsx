"use client";

// Agents view: what the agents concluded, who asked whom (as a diagram), and what each agent did, step by step.
// Model reasoning text is not recorded by the server, so "thinking" here is the agent's real trail: why it was
// asked, what it looked at, which helper it called, what the checker rejected, what it answered. Nothing is invented.
// Advice only: nothing here approves or dispatches.

import { useCallback, useEffect, useMemo, useState } from "react";
import { NemotronMark } from "./nemotron";
import { api, unwrap } from "@/lib/api";
import { facilityName, humanize, planText } from "@/lib/format";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------------------------------------------
// Data

export type AgentNode = {
  id: string; parentId: string | null; depth: number; role: string; incidentId?: string | null; requestedBy?: string | null; reason?: string | null;
  question?: string | null; promptVersion?: number | null; status: string; toolsCalled: string[]; modelCalls?: number; inputTokens?: number; outputTokens?: number;
  latencyMs?: number; rejections?: string[]; output?: unknown; error?: string | null; score?: { total: number } | null; children?: string[];
};
export type AgentRun = {
  id: string; status: "running" | "done" | "failed"; error: string | null; nodes: AgentNode[]; startedAt?: string;
  trace: {
    score: number; fallbacks?: string[];
    outputs?: { triage: { order: string[]; notes: { incidentId: string; note: string }[] } | null; explanations: { incidentId: string; explanation: string }[]; reviews: { incidentId: string; answer: string }[]; handoff: { handoff: string } | null };
    totals: { nodes: number; modelCalls?: number; inputTokens: number; outputTokens: number; latencyMs: number; accepted: number; denied: number; maxDepth: number };
  } | null;
};
type Learning = {
  versions: { role: string; version: number; author: string; status: string; trainMean: number | null; trainN: number; heldoutMean: number | null; heldoutN: number; acceptRate: number | null }[];
};

/** The latest agent run for an operator run, shared by the Agents view and the dashboard. Polls while agents work. */
export function useAgentRun(runId: string) {
  const [run, setRun] = useState<AgentRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    // The list holds summaries only: take the newest, then load it in full.
    api.api.runs({ id: runId })["agent-runs"].get().then(async (r) => {
      const list = (Array.isArray(r.data) ? r.data : []) as unknown as { id: string; startedAt?: string }[];
      const latest = [...list].sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")))[0];
      if (!latest) return;
      const full = unwrap(await api.api["agent-runs"]({ id: latest.id }).get()) as unknown as AgentRun;
      if (live) setRun((cur) => cur ?? full);
    }).catch(() => {});
    return () => { live = false; };
  }, [runId]);
  useEffect(() => {
    if (!run || run.status !== "running") return;
    const t = setTimeout(async () => {
      try { setRun(unwrap(await api.api["agent-runs"]({ id: run.id }).get()) as unknown as AgentRun); }
      catch (e) { setError((e as Error).message); }
    }, 900);
    return () => clearTimeout(t);
  }, [run]);
  const start = useCallback(async () => {
    setError(null);
    try { setRun(unwrap(await api.api.runs({ id: runId }).agents.post()) as unknown as AgentRun); }
    catch (e) { setError((e as Error).message); }
  }, [runId]);
  return { run, error, start };
}

/** One line per incident from the agents, for the dashboard: the plan explanation, else the triage note. */
export function agentLines(run: AgentRun | null): Record<string, string> {
  const o = run?.trace?.outputs;
  if (!o) return {};
  const out: Record<string, string> = {};
  for (const n of o.triage?.notes ?? []) out[n.incidentId] = n.note;
  for (const e of o.explanations ?? []) out[e.incidentId] = e.explanation;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Words

const ROLE: Record<string, { name: string; job: string }> = {
  orchestrator: { name: "Orchestrator", job: "Code, not a model. Decides which agents run and grants or refuses their requests." },
  triage: { name: "Triage", job: "Puts the open problems in order." },
  plan_explainer: { name: "Plan explainer", job: "Explains why one response plan comes first." },
  evidence_reviewer: { name: "Evidence reviewer", job: "Checks the sensor evidence behind one problem." },
  handoff: { name: "Handoff writer", job: "Writes the note for the next shift." },
  critic: { name: "Critic", job: "Suggests better prompts offline." },
};
const roleName = (r: string) => ROLE[r]?.name ?? humanize(r.replace(/_/g, " "));

const TOOL: Record<string, string> = {
  list_incidents: "Read the open problems",
  alerts_view: "Checked the console's alert order",
  read_incident: "Read the problem's evidence and plans",
  compare_plans: "Compared the planner's options",
  well_economics: "Checked lost revenue per well",
  inspection_advice: "Checked the inspection advice",
  read_agent_notes: "Read the other agents' notes",
};

type Tone = "ok" | "warn" | "crit" | "muted";
function statusOf(n: AgentNode): { label: string; tone: Tone } {
  const retries = n.rejections?.length ?? 0;
  switch (n.status) {
    case "accepted": return retries ? { label: `Accepted after ${retries} ${retries === 1 ? "retry" : "retries"}`, tone: "ok" } : { label: "Accepted", tone: "ok" };
    case "deterministic": return { label: n.role === "orchestrator" ? "Rules" : "Written from the facts", tone: "muted" };
    case "cached": return { label: "Reused an earlier answer", tone: "muted" };
    case "denied": return { label: "Refused", tone: "warn" };
    case "rejected": return { label: "Rejected", tone: "crit" };
    case "failed": return { label: "Failed", tone: "crit" };
    default: return { label: humanize(n.status), tone: "muted" };
  }
}
const toneText: Record<Tone, string> = { ok: "text-[#248a3d]", warn: "text-warn", crit: "text-crit", muted: "text-muted-foreground" };
const toneDot: Record<Tone, string> = { ok: "bg-[#34c759]", warn: "bg-warn-fill", crit: "bg-crit", muted: "bg-[#8e8e93]" };
const toneLine: Record<Tone, string> = { ok: "#34c759", warn: "#ff9500", crit: "#ff3b30", muted: "#c7c7cc" };

/** "run-…:pump_failure:S5_FACILITY_C:179…" -> "S5 C". */
function incidentFacility(id?: string | null) {
  const m = id ? /:([A-Z0-9]+_FACILITY_[A-Z0-9]+)/i.exec(id) : null;
  return m ? facilityName(m[1]!) : null;
}
function incidentLabel(id?: string | null) {
  const m = id ? /:([a-z_]+):([A-Z0-9]+_FACILITY_[A-Z0-9]+)/i.exec(id) : null;
  return m ? `${facilityName(m[2]!)}, ${m[1]!.replace(/_/g, " ")}` : null;
}

/** Server reasons are lower-case fragments; show them as sentences with readable ids. */
function sentence(text: string) {
  const t = humanize(text).trim();
  return t ? `${t.charAt(0).toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? "" : "."}` : t;
}

function answerLines(output: unknown, nowUnix: number): string[] {
  if (!output || typeof output !== "object") return [];
  const o = output as Record<string, unknown>;
  if (Array.isArray(o.notes)) return (o.notes as { incidentId: string; note: string }[]).map((n) => planText(n.note, nowUnix));
  const text = o.explanation ?? o.handoff ?? o.answer ?? o.note;
  return typeof text === "string" ? [planText(text, nowUnix)] : [];
}

type Step = { kind: "asked" | "tool" | "delegate" | "rejected" | "answer" | "refused" | "error"; text: string; child?: AgentNode; detail?: string };

/** Rebuild the agent's trail from what the server recorded, in order. */
function stepsOf(n: AgentNode, byId: Map<string, AgentNode>, nowUnix: number): Step[] {
  const steps: Step[] = [];
  if (n.role === "orchestrator") {
    if (n.reason) steps.push({ kind: "asked", text: sentence(n.reason) });
  } else {
    const by = n.requestedBy && byId.get(n.requestedBy);
    // Reasons like "requested by handoff n2" only repeat the line above with an internal id; drop those.
    const reason = n.reason && !/^requested by /i.test(n.reason) ? sentence(n.reason) : undefined;
    steps.push(
      by && by.role !== "orchestrator"
        ? { kind: "asked", text: `${roleName(by.role)} asked${n.question ? `: “${n.question}”` : " for help"}`, detail: reason }
        : { kind: "asked", text: `Started by the orchestrator${reason ? `: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}` : ""}` },
    );
  }
  if (n.status === "denied") {
    steps.push({ kind: "refused", text: "The orchestrator refused this request", detail: n.reason ? sentence(n.reason.replace(/^refused:\s*/i, "")) : undefined });
    return steps;
  }
  if (n.status === "cached") {
    steps.push({ kind: "answer", text: "The same question was already answered in this run; that answer was reused." });
    return steps;
  }
  const kids = (n.children ?? []).map((id) => byId.get(id)).filter((x): x is AgentNode => !!x);
  const rejections = n.rejections ?? [];
  let kid = 0, rejection = 0;
  for (const t of n.toolsCalled) {
    if (t === "request_subtask") {
      const child = kids[kid++];
      steps.push({ kind: "delegate", text: child ? `Asked the ${roleName(child.role).toLowerCase()} for help` : "Asked for help", child });
    } else if (t.startsWith("submit_")) {
      if (rejection < rejections.length) steps.push({ kind: "rejected", text: "Answer rejected by the checker", detail: rejections[rejection++] });
    } else steps.push({ kind: "tool", text: TOOL[t] ?? sentence(t.replace(/_/g, " ")) });
  }
  for (; rejection < rejections.length; rejection++) steps.push({ kind: "rejected", text: "Answer rejected by the checker", detail: rejections[rejection] });
  const lines = answerLines(n.output, nowUnix);
  if (lines.length) steps.push({ kind: "answer", text: lines.join("\n") });
  if (n.error) steps.push({ kind: "error", text: sentence(n.error) });
  return steps;
}

/** Tree order (who asked whom, top-down). Nodes whose parent hasn't reported yet go under the root. */
function treeOrder(nodes: AgentNode[]) {
  const ids = new Set(nodes.map((n) => n.id));
  const parentOf = (n: AgentNode) => (n.parentId && ids.has(n.parentId) ? n.parentId : n.parentId === null ? null : (nodes.find((x) => x.role === "orchestrator")?.id ?? null));
  const out: AgentNode[] = [];
  const visit = (p: string | null) => nodes.filter((n) => parentOf(n) === p && !out.includes(n)).forEach((n) => { out.push(n); visit(n.id); });
  visit(null);
  for (const n of nodes) if (!out.includes(n)) out.push(n);
  return { out, parentOf };
}

// ---------------------------------------------------------------------------------------------------------------
// View

export function AgentsPanel({
  agents,
  nowUnix,
  onOpenIncident,
}: {
  agents: ReturnType<typeof useAgentRun>;
  nowUnix: number;
  onOpenIncident: (incidentId: string) => void;
}) {
  const { run, error, start } = agents;
  const [learning, setLearning] = useState<Learning | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [play, setPlay] = useState<number | null>(null); // replay position in tree order

  useEffect(() => {
    if (run?.status === "running") return;
    api.api.agents.learning.get().then((r) => setLearning(unwrap(r) as unknown as Learning)).catch(() => {});
  }, [run?.status]);

  const nodes = useMemo(() => run?.nodes ?? [], [run]);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const { out: ordered, parentOf } = useMemo(() => treeOrder(nodes), [nodes]);
  const running = run?.status === "running";

  // Replay: reveal agents one at a time in the order they were asked.
  useEffect(() => {
    if (play == null) return;
    if (play >= ordered.length - 1) { const t = setTimeout(() => setPlay(null), 2600); return () => clearTimeout(t); }
    const t = setTimeout(() => setPlay((p) => (p == null ? null : p + 1)), 2200);
    return () => clearTimeout(t);
  }, [play, ordered.length]);

  // While agents work, follow the newest one to finish unless the operator picked one.
  const newest = running ? nodes[nodes.length - 1] : undefined;

  const visible = play != null ? ordered.slice(0, play + 1) : ordered;
  const fallbackPick = ordered.find((n) => n.rejections?.length) ?? ordered.filter((n) => n.role !== "orchestrator").at(-1) ?? ordered[0];
  const selected = play != null ? ordered[play] : (picked && byId.get(picked)) || newest || fallbackPick;
  const active = play != null ? ordered[play]?.id : newest?.id;

  const t = run?.trace?.totals;
  const retried = nodes.filter((n) => n.rejections?.length).length;
  const handoff = run?.trace?.outputs?.handoff?.handoff;
  const order = run?.trace?.outputs?.triage?.order ?? [];
  const wroteItself = run?.trace?.fallbacks?.includes("handoff");

  return (
    <div className="mt-5 grid gap-4">
      {/* What the agents concluded */}
      <section className="glass px-4 py-3.5" aria-label="What the agents concluded">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <NemotronMark className="size-5" />
          <h3 className="text-[13px] font-semibold">What the agents concluded</h3>
          <span className="text-[12.5px] text-muted-foreground">
            {running
              ? `Working… ${nodes.length} ${nodes.length === 1 ? "agent has" : "agents have"} finished`
              : t
                ? `${t.nodes} agents, ${t.accepted} accepted${retried ? `, ${retried} retried after the checker pushed back` : ""}${t.denied ? `, ${t.denied} refused` : ""}, ${(t.latencyMs / 1000).toFixed(1)} s`
                : ""}
          </span>
          <span className="ml-auto flex gap-2">
            {run?.status === "done" && ordered.length > 1 && (
              <button type="button" onClick={() => { setPicked(null); setPlay(play == null ? 0 : null); }} className="rounded-md px-3 py-1.5 text-[13px] font-medium text-water ring-1 ring-water/40">
                {play == null ? "Replay steps" : "Stop replay"}
              </button>
            )}
            <button type="button" onClick={() => { setPlay(null); setPicked(null); void start(); }} disabled={running} className="rounded-md bg-text px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50">
              {running ? "Agents working…" : run ? "Run again" : "Run agents"}
            </button>
          </span>
        </div>
        {handoff ? (
          <>
            <p className="mt-2.5 max-w-[80ch] text-[15px] leading-snug">{planText(handoff, nowUnix)}</p>
            {wroteItself && <p className="mt-1 text-[12.5px] text-muted-foreground">Nemotron&apos;s handoff wasn&apos;t accepted, so the orchestrator wrote this from the facts.</p>}
          </>
        ) : (
          <p className="mt-2 text-[14px] text-muted-foreground">
            {running ? "The handoff writer runs last; its summary will appear here." : "Run the agents to see who does what, and why. They advise; they never dispatch or approve."}
          </p>
        )}
        {order.length > 0 && (
          <ol className="mt-2.5 flex flex-wrap gap-2 text-[13px]" aria-label="Priority order from triage">
            {order.map((id, i) => (
              <li key={id}>
                <button type="button" onClick={() => onOpenIncident(id)} className="rounded-md bg-black/[0.04] px-2 py-0.5 hover:bg-black/[0.07]">
                  <span className="text-faint tabular-nums">{i + 1}.</span> {incidentLabel(id) ?? "Incident"}
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>
      {(error || run?.error) && <p role="alert" className="glass px-4 py-3 text-[14px] text-crit">{error ?? run?.error}</p>}

      {visible.length > 0 && (
        <>
          <FlowDiagram nodes={visible} parentOf={parentOf} selected={selected?.id} active={active} working={running} onPick={(id) => { setPlay(null); setPicked(id); }} />
          {selected && (
            <Trail
              key={`${selected.id}:${play ?? "x"}`}
              node={selected}
              byId={byId}
              nowUnix={nowUnix}
              animate={play != null || selected.id === newest?.id}
              onPick={(id) => { setPlay(null); setPicked(id); }}
              onOpenIncident={onOpenIncident}
            />
          )}
        </>
      )}

      {learning && learning.versions.some((v) => v.trainN + v.heldoutN > 0) && (
        <details className="glass px-4 py-3">
          <summary className="cursor-pointer text-[13px] font-semibold">Prompt versions and scores</summary>
          <p className="mt-1 text-[12.5px] text-muted-foreground">Scored only by the checkers and the facts. Held-out runs are never shown to the critic.</p>
          <table className="mt-2 w-full text-left text-[12.5px] tabular-nums">
            <thead className="text-faint"><tr><th className="font-normal">Agent</th><th className="font-normal">Version</th><th className="font-normal">Status</th><th className="font-normal">Train</th><th className="font-normal">Held-out</th><th className="font-normal">Accepted</th></tr></thead>
            <tbody>
              {learning.versions.filter((v) => v.trainN + v.heldoutN > 0).map((v) => (
                <tr key={`${v.role}-${v.version}`} className={cn("border-t border-line-soft", v.status === "champion" && "font-semibold")}>
                  <td className="py-1">{roleName(v.role)}</td><td>v{v.version}</td><td>{v.status}</td>
                  <td>{v.trainMean ?? "–"} ({v.trainN})</td><td>{v.heldoutMean ?? "–"} ({v.heldoutN})</td><td>{v.acceptRate ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Flow diagram: boxes by depth (left to right), elbow arrows from the asker to the agent it asked.

const BOX_W = 170, BOX_H = 54, COL = 206, ROW = 66, PAD = 12;

function FlowDiagram({
  nodes,
  parentOf,
  selected,
  active,
  working,
  onPick,
}: {
  nodes: AgentNode[];
  parentOf: (n: AgentNode) => string | null;
  selected?: string;
  active?: string;
  working: boolean;
  onPick: (id: string) => void;
}) {
  // Tidy layout: leaves take the next row; a parent sits level with its first child.
  const pos = new Map<string, { x: number; y: number }>();
  const depthOf = new Map<string, number>();
  let row = 0;
  const kids = (id: string | null) => nodes.filter((n) => parentOf(n) === id);
  const place = (n: AgentNode, depth: number) => {
    depthOf.set(n.id, depth);
    const children = kids(n.id);
    if (!children.length) { pos.set(n.id, { x: PAD + depth * COL, y: PAD + row++ * ROW }); return; }
    const first = row;
    children.forEach((c) => place(c, depth + 1));
    pos.set(n.id, { x: PAD + depth * COL, y: PAD + first * ROW });
  };
  kids(null).forEach((n) => place(n, 0));
  const maxDepth = Math.max(0, ...depthOf.values());
  const w = PAD * 2 + maxDepth * COL + BOX_W + (working ? COL : 0);
  const h = PAD * 2 + Math.max(1, row) * ROW - (ROW - BOX_H);
  const deepest = nodes.reduce((a, n) => ((depthOf.get(n.id) ?? 0) >= (depthOf.get(a?.id ?? "") ?? -1) ? n : a), nodes[0]);

  return (
    <section className="glass overflow-hidden" aria-label="Who asked whom">
      <h3 className="flex flex-wrap items-baseline gap-x-3 border-b border-line px-4 py-2.5 text-[13px] font-semibold">
        Who asked whom
        <span className="text-[12.5px] font-normal text-muted-foreground">Arrows point from the agent that asked to the agent it asked. Click one to see its steps.</span>
      </h3>
      <div className="overflow-x-auto">
        <div className="relative" style={{ width: w, height: h }}>
          <svg className="absolute inset-0" width={w} height={h} aria-hidden>
            <defs>
              <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0 0L8 4L0 8z" fill="#aeaeb2" />
              </marker>
            </defs>
            {nodes.map((n) => {
              const p = parentOf(n);
              const a = p ? pos.get(p) : undefined, b = pos.get(n.id);
              if (!a || !b) return null;
              const x1 = a.x + BOX_W, y1 = a.y + BOX_H / 2, x2 = b.x - 2, y2 = b.y + BOX_H / 2, mx = x1 + (x2 - x1) / 2;
              const st = statusOf(n);
              return (
                <path
                  key={n.id}
                  d={`M${x1} ${y1}H${mx - 8}Q${mx} ${y1} ${mx} ${y1 + Math.sign(y2 - y1) * 8}V${y2 - Math.sign(y2 - y1) * 8}Q${mx} ${y2} ${mx + 8} ${y2}H${x2}`}
                  fill="none"
                  stroke={n.status === "denied" ? toneLine.warn : "#c7c7cc"}
                  strokeWidth={1.5}
                  strokeDasharray={n.status === "denied" || n.status === "cached" ? "4 4" : undefined}
                  markerEnd="url(#arrow)"
                  className={cn(st.tone === "crit" && "stroke-crit")}
                />
              );
            })}
            {working && deepest && pos.get(deepest.id) && (
              <path
                d={`M${pos.get(deepest.id)!.x + BOX_W} ${pos.get(deepest.id)!.y + BOX_H / 2}h${COL - BOX_W - 4}`}
                stroke="#0a84ff"
                strokeWidth={1.5}
                strokeDasharray="3 4"
                fill="none"
                className="pipe-flow"
              />
            )}
          </svg>
          {nodes.map((n) => {
            const p = pos.get(n.id);
            if (!p) return null;
            const st = statusOf(n);
            const fac = incidentFacility(n.incidentId);
            const on = selected === n.id;
            return (
              <button
                key={n.id}
                type="button"
                onClick={() => onPick(n.id)}
                aria-current={on || undefined}
                aria-label={`${roleName(n.role)}${fac ? ` for ${fac}` : ""}: ${st.label}`}
                className={cn(
                  "absolute flex flex-col justify-center rounded-lg border bg-white px-3 text-left transition-[box-shadow,border-color] duration-200 animate-in fade-in-0 zoom-in-95 motion-reduce:animate-none",
                  on ? "border-water shadow-[0_0_0_3px_rgba(10,132,255,0.18)]" : "border-line hover:border-[#aeaeb2]",
                  active === n.id && !on && "shadow-[0_0_0_3px_rgba(52,199,89,0.22)]",
                )}
                style={{ left: p.x, top: p.y, width: BOX_W, height: BOX_H }}
              >
                <span className="flex items-center gap-1.5 text-[13px] font-semibold">
                  <span aria-hidden className={cn("size-2 shrink-0 rounded-full", toneDot[st.tone])} />
                  <span className="truncate">{roleName(n.role)}</span>
                  {fac && <span className="shrink-0 font-normal text-muted-foreground">· {fac}</span>}
                </span>
                <span className={cn("truncate pl-3.5 text-[12px]", toneText[st.tone])}>{st.label}</span>
              </button>
            );
          })}
          {working && deepest && pos.get(deepest.id) && (
            <span
              className="absolute flex items-center gap-2 rounded-lg border border-dashed border-water/50 px-3 text-[12.5px] text-water"
              style={{ left: pos.get(deepest.id)!.x + COL, top: pos.get(deepest.id)!.y, width: BOX_W - 30, height: BOX_H }}
            >
              <span aria-hidden className="size-2 animate-pulse rounded-full bg-water" /> Next agent working…
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// One agent's steps

const stepRing: Record<Step["kind"], string> = {
  asked: "border-text",
  tool: "border-[#8e8e93]",
  delegate: "border-water",
  rejected: "border-crit",
  refused: "border-warn-fill",
  answer: "border-[#34c759]",
  error: "border-crit",
};

function Trail({
  node,
  byId,
  nowUnix,
  animate,
  onPick,
  onOpenIncident,
}: {
  node: AgentNode;
  byId: Map<string, AgentNode>;
  nowUnix: number;
  animate: boolean;
  onPick: (id: string) => void;
  onOpenIncident: (id: string) => void;
}) {
  const steps = stepsOf(node, byId, nowUnix);
  const st = statusOf(node);
  const inc = incidentLabel(node.incidentId);
  return (
    <section className="glass overflow-hidden" aria-label={`${roleName(node.role)} steps`} aria-live={animate ? "polite" : undefined}>
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line px-4 py-2.5">
        <h3 className="text-[13px] font-semibold">
          {roleName(node.role)}
          {inc && <span className="font-normal text-muted-foreground"> · {inc}</span>}
          <span className={cn("ml-2 font-normal", toneText[st.tone])}>{st.label}</span>
        </h3>
        <span className="text-[12.5px] text-muted-foreground">{ROLE[node.role]?.job}</span>
        {node.incidentId && (
          <button type="button" onClick={() => onOpenIncident(node.incidentId!)} className="ml-auto text-[13px] font-medium text-water hover:underline">
            Open {incidentFacility(node.incidentId) ?? "incident"} on the dashboard
          </button>
        )}
      </header>
      <ol className="px-4 py-3">
        {steps.map((s, i) => (
          <li
            key={i}
            className={cn("relative flex gap-3 pb-3.5 last:pb-0", animate && "animate-in fade-in-0 slide-in-from-left-1 fill-mode-both duration-300 motion-reduce:animate-none")}
            style={animate ? { animationDelay: `${i * 280}ms` } : undefined}
          >
            {i < steps.length - 1 && <span aria-hidden className="absolute top-4 bottom-0 left-[5px] border-l border-line" />}
            <span aria-hidden className={cn("mt-[5px] size-[11px] shrink-0 rounded-full border-2 bg-white", stepRing[s.kind])} />
            <div className="min-w-0 text-[13.5px] leading-snug">
              {s.kind === "delegate" && s.child ? (
                <button type="button" onClick={() => onPick(s.child!.id)} className="text-left font-medium text-water hover:underline">
                  {s.text}
                  <span className="font-normal text-muted-foreground"> ({statusOf(s.child).label.toLowerCase()})</span>
                </button>
              ) : s.kind === "answer" ? (
                <>
                  <span className="block text-[12px] text-faint">Answer</span>
                  {s.text.split("\n").map((line, k) => <p key={k} className="mt-0.5 max-w-[80ch]">{line}</p>)}
                </>
              ) : (
                <span className={cn(s.kind === "rejected" || s.kind === "error" ? "font-medium text-crit" : s.kind === "refused" ? "font-medium text-warn" : s.kind === "asked" ? "font-medium" : "")}>{s.text}</span>
              )}
              {s.detail && <p className="mt-0.5 text-[12.5px] text-muted-foreground">{s.detail}</p>}
            </div>
          </li>
        ))}
      </ol>
      {node.role !== "orchestrator" && (node.latencyMs || node.modelCalls) ? (
        <p className="border-t border-line px-4 py-2 text-[12px] text-faint tabular-nums">
          {node.modelCalls ? `${node.modelCalls} model ${node.modelCalls === 1 ? "call" : "calls"}` : ""}
          {node.latencyMs ? `${node.modelCalls ? ", " : ""}${(node.latencyMs / 1000).toFixed(1)} s` : ""}
        </p>
      ) : null}
    </section>
  );
}
