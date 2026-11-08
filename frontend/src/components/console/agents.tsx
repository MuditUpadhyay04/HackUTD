"use client";

// Agents view: who the orchestrator asked, who they asked in turn, and what each one did, step by step.
// Model reasoning text is not recorded by the server, so "thinking" here is the agent's actual trail:
// why it was asked, what it looked at, which helper it called, what the checker rejected, what it answered.
// Advice only: nothing here approves or dispatches.

import { useCallback, useEffect, useMemo, useState } from "react";
import { NemotronMark } from "./nemotron";
import { api, unwrap } from "@/lib/api";
import { facilityName, humanize, planText } from "@/lib/format";
import { cn } from "@/lib/utils";

type Node = {
  id: string; parentId: string | null; depth: number; role: string; incidentId?: string | null; requestedBy?: string | null; reason?: string | null;
  question?: string | null; promptVersion?: number | null; status: string; toolsCalled: string[]; modelCalls?: number; inputTokens?: number; outputTokens?: number;
  latencyMs?: number; rejections?: string[]; output?: unknown; error?: string | null; score?: { total: number } | null; children?: string[];
};
type AgentRun = {
  id: string; status: "running" | "done" | "failed"; error: string | null; nodes: Node[]; startedAt?: string;
  trace: { score: number; strategy: { version: number; name: string }; fallbacks?: string[]; totals: { nodes: number; modelCalls?: number; inputTokens: number; outputTokens: number; latencyMs: number; accepted: number; denied: number; maxDepth: number } } | null;
};
type Learning = {
  versions: { role: string; version: number; author: string; status: string; trainMean: number | null; trainN: number; heldoutMean: number | null; heldoutN: number; acceptRate: number | null }[];
};

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

function statusOf(n: Node): { label: string; tone: "ok" | "warn" | "crit" | "muted" } {
  const retries = n.rejections?.length ?? 0;
  switch (n.status) {
    case "accepted": return retries ? { label: `Accepted after ${retries} ${retries === 1 ? "retry" : "retries"}`, tone: "ok" } : { label: "Accepted", tone: "ok" };
    case "deterministic": return { label: "Rules", tone: "muted" };
    case "cached": return { label: "Reused an earlier answer", tone: "muted" };
    case "denied": return { label: "Refused", tone: "warn" };
    case "rejected": return { label: "Rejected", tone: "crit" };
    case "failed": return { label: "Failed", tone: "crit" };
    default: return { label: humanize(n.status), tone: "muted" };
  }
}
const toneText = { ok: "text-[#248a3d]", warn: "text-warn", crit: "text-crit", muted: "text-muted-foreground" } as const;
const toneDot = { ok: "bg-[#34c759]", warn: "bg-warn-fill", crit: "bg-crit", muted: "bg-[#8e8e93]" } as const;

/** "run-…:pump_failure:S5_FACILITY_C:179…" -> "S5 C, pump failure". */
function incidentLabel(id?: string | null) {
  if (!id) return null;
  const m = /:([a-z_]+):([A-Z0-9]+_FACILITY_[A-Z0-9]+)/i.exec(id);
  return m ? `${facilityName(m[2]!)}, ${m[1]!.replace(/_/g, " ")}` : null;
}

/** The prose each role submits, as plain lines. */
function answerLines(output: unknown, nowUnix: number): string[] {
  if (!output || typeof output !== "object") return [];
  const o = output as Record<string, unknown>;
  if (Array.isArray(o.notes)) return (o.notes as { incidentId: string; note: string }[]).map((n) => n.note);
  const text = o.explanation ?? o.handoff ?? o.answer ?? o.note;
  return typeof text === "string" ? [planText(text, nowUnix)] : [];
}

/** Server reasons are lower-case fragments; show them as sentences with readable ids. */
function sentence(text: string) {
  const t = humanize(text).trim();
  return t ? `${t.charAt(0).toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? "" : "."}` : t;
}

type Step = { kind: "asked" | "tool" | "delegate" | "rejected" | "answer" | "refused" | "error"; text: string; child?: Node; detail?: string };

/** Rebuild the agent's trail from what the server recorded, in order. */
function stepsOf(n: Node, byId: Map<string, Node>, nowUnix: number): Step[] {
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
    steps.push({ kind: "refused", text: "The orchestrator refused this request", detail: n.reason ? humanize(n.reason) : undefined });
    return steps;
  }
  if (n.status === "cached") {
    steps.push({ kind: "answer", text: "Same question was already answered in this run; that answer was reused." });
    return steps;
  }
  const kids = (n.children ?? []).map((id) => byId.get(id)).filter((x): x is Node => !!x);
  let kid = 0, rejection = 0;
  for (const t of n.toolsCalled) {
    if (t === "request_subtask") {
      const child = kids[kid++];
      steps.push({ kind: "delegate", text: child ? `Asked the ${roleName(child.role).toLowerCase()} for help` : "Asked for help", child });
    } else if (t.startsWith("submit_")) {
      const why = n.rejections?.[rejection];
      if (why !== undefined && (rejection < (n.rejections?.length ?? 0))) {
        rejection++;
        steps.push({ kind: "rejected", text: "Answer rejected by the checker", detail: why });
      }
    } else steps.push({ kind: "tool", text: TOOL[t] ?? humanize(t.replace(/_/g, " ")) });
  }
  // Rejections the tool list did not account for (e.g. validator retries without a recorded submit).
  for (; rejection < (n.rejections?.length ?? 0); rejection++) steps.push({ kind: "rejected", text: "Answer rejected by the checker", detail: n.rejections![rejection] });
  const lines = answerLines(n.output, nowUnix);
  if (lines.length) steps.push({ kind: "answer", text: lines.join("\n") });
  if (n.error) steps.push({ kind: "error", text: humanize(n.error) });
  return steps;
}

export function AgentsPanel({ runId, nowUnix }: { runId: string; nowUnix: number }) {
  const [run, setRun] = useState<AgentRun | null>(null);
  const [learning, setLearning] = useState<Learning | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  const loadLearning = useCallback(() => api.api.agents.learning.get().then((r) => setLearning(unwrap(r) as unknown as Learning)).catch(() => {}), []);
  // Show the latest agent run for this operator run, if there is one.
  useEffect(() => {
    void loadLearning();
    api.api.runs({ id: runId })["agent-runs"].get().then((r) => {
      const list = (r.data ?? []) as unknown as AgentRun[];
      if (Array.isArray(list) && list.length) setRun((cur) => cur ?? list[list.length - 1]!);
    }).catch(() => {});
  }, [runId, loadLearning]);
  // Poll while agents work; nodes appear as each one finishes.
  useEffect(() => {
    if (!run || run.status !== "running") return;
    const t = setTimeout(async () => {
      try {
        const next = unwrap(await api.api["agent-runs"]({ id: run.id }).get()) as unknown as AgentRun;
        setRun(next);
        if (next.status !== "running") void loadLearning();
      } catch (e) { setError((e as Error).message); }
    }, 1000);
    return () => clearTimeout(t);
  }, [run, loadLearning]);

  const start = async () => {
    setError(null);
    setPicked(null);
    try { setRun(unwrap(await api.api.runs({ id: runId }).agents.post()) as unknown as AgentRun); }
    catch (e) { setError((e as Error).message); }
  };

  const nodes = useMemo(() => run?.nodes ?? [], [run]);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const ordered = useMemo(() => {
    const out: Node[] = [];
    const visit = (parent: string | null) => nodes.filter((n) => n.parentId === parent).forEach((n) => { out.push(n); visit(n.id); });
    visit(null);
    // Nodes whose parent hasn't arrived yet (live run) still show.
    for (const n of nodes) if (!out.includes(n)) out.push(n);
    return out;
  }, [nodes]);
  // Default to the most interesting agent: one the checker pushed back on, else the last to finish.
  const fallbackPick = ordered.find((n) => n.rejections?.length) ?? ordered.filter((n) => n.role !== "orchestrator").at(-1) ?? ordered[0];
  const selected = (picked && byId.get(picked)) || fallbackPick;
  const running = run?.status === "running";
  const t = run?.trace?.totals;
  const retried = nodes.filter((n) => n.rejections?.length).length;

  return (
    <div className="mt-5 grid gap-4">
      <div className="glass flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <NemotronMark className="size-5" />
        <p className="min-w-0 flex-1 text-[13px] text-muted-foreground">
          {running
            ? `Working… ${nodes.length} ${nodes.length === 1 ? "agent has" : "agents have"} finished so far.`
            : t
              ? `${t.nodes} agents, ${t.accepted} accepted${retried ? `, ${retried} retried after the checker pushed back` : ""}${t.denied ? `, ${t.denied} refused` : ""}. ${(t.latencyMs / 1000).toFixed(1)} s.`
              : run?.status === "failed"
                ? "The last agent run failed."
                : "Run the agents to see who does what, and why."}
        </p>
        <button type="button" onClick={start} disabled={running} className="rounded-md bg-text px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50">
          {running ? "Agents working…" : run ? "Run again" : "Run agents"}
        </button>
      </div>
      {(error || run?.error) && <p role="alert" className="glass px-4 py-3 text-[14px] text-crit">{error ?? run?.error}</p>}
      {run?.trace?.fallbacks?.length ? (
        <p className="glass px-4 py-3 text-[13px] text-muted-foreground">
          Nemotron&apos;s {run.trace.fallbacks.join(" and ")} wasn&apos;t accepted, so the orchestrator wrote {run.trace.fallbacks.length === 1 ? "it" : "them"} from the facts.
        </p>
      ) : null}

      {ordered.length > 0 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <section className="glass overflow-hidden" aria-label="Agent tree">
            <h3 className="border-b border-line px-4 py-2.5 text-[13px] font-semibold">Who asked whom</h3>
            <ol className="py-1.5">
              {ordered.map((n) => {
                const st = statusOf(n);
                const on = selected?.id === n.id;
                const inc = incidentLabel(n.incidentId);
                return (
                  <li key={n.id}>
                    <button
                      type="button"
                      onClick={() => setPicked(n.id)}
                      aria-current={on || undefined}
                      className={cn("relative flex w-full items-start gap-2.5 py-2 pr-4 text-left transition-colors hover:bg-black/[0.03]", on && "bg-water/[0.08] hover:bg-water/[0.08]")}
                      style={{ paddingLeft: 16 + n.depth * 22 }}
                    >
                      {n.depth > 0 && <span aria-hidden className="absolute top-0 bottom-1/2 border-l border-b border-line" style={{ left: 16 + (n.depth - 1) * 22 + 5, width: 12 }} />}
                      <span aria-hidden className={cn("mt-[6px] size-2 shrink-0 rounded-full", toneDot[st.tone])} />
                      <span className="min-w-0">
                        <span className="block text-[13.5px] font-semibold">
                          {roleName(n.role)}
                          {inc && <span className="font-normal text-muted-foreground"> · {inc}</span>}
                        </span>
                        <span className={cn("block text-[12px]", toneText[st.tone])}>{st.label}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
              {running && (
                <li className="flex items-center gap-2.5 px-4 py-2 text-[13px] text-muted-foreground">
                  <span aria-hidden className="size-2 animate-pulse rounded-full bg-water" /> Next agent working…
                </li>
              )}
            </ol>
          </section>

          {selected && <Trail node={selected} byId={byId} nowUnix={nowUnix} onPick={setPicked} />}
        </div>
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

function Trail({ node, byId, nowUnix, onPick }: { node: Node; byId: Map<string, Node>; nowUnix: number; onPick: (id: string) => void }) {
  const steps = stepsOf(node, byId, nowUnix);
  const st = statusOf(node);
  const inc = incidentLabel(node.incidentId);
  return (
    <section className="glass overflow-hidden" aria-label={`${roleName(node.role)} steps`}>
      <header className="border-b border-line px-4 py-2.5">
        <h3 className="text-[13px] font-semibold">
          {roleName(node.role)}
          {inc && <span className="font-normal text-muted-foreground"> · {inc}</span>}
          <span className={cn("ml-2 font-normal", toneText[st.tone])}>{st.label}</span>
        </h3>
        <p className="text-[12.5px] text-muted-foreground">{ROLE[node.role]?.job}</p>
      </header>
      <ol className="px-4 py-3">
        {steps.map((s, i) => (
          <li key={i} className="relative flex gap-3 pb-3.5 last:pb-0">
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
                  {s.text.split("\n").map((line, k) => <p key={k} className="mt-0.5">{line}</p>)}
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

const stepRing: Record<Step["kind"], string> = {
  asked: "border-text",
  tool: "border-[#8e8e93]",
  delegate: "border-water",
  rejected: "border-crit",
  refused: "border-warn-fill",
  answer: "border-[#34c759]",
  error: "border-crit",
};
