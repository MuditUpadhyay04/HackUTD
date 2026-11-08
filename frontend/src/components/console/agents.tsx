"use client";

import { useCallback, useEffect, useState } from "react";
import { Tile } from "./section";
import { NemotronMark } from "./nemotron";
import { api, unwrap } from "@/lib/api";
import { cn } from "@/lib/utils";

type Node = {
  id: string; parentId: string | null; depth: number; role: string; incidentId?: string | null; requestedBy?: string | null; reason?: string | null;
  promptVersion?: number | null; status: string; toolsCalled: string[]; inputTokens?: number; outputTokens?: number; latencyMs?: number; rejections?: string[];
  output?: unknown; error?: string | null; score?: { total: number } | null;
};
type AgentRun = { id: string; status: "running" | "done" | "failed"; error: string | null; nodes: Node[]; trace: { score: number; strategy: { version: number; name: string }; totals: { nodes: number; inputTokens: number; outputTokens: number; latencyMs: number; accepted: number; denied: number; maxDepth: number }; alertsView: { rank: number; line: string }[] } | null };
type Learning = {
  champions: { prompts: Record<string, number>; strategy: number };
  versions: { role: string; version: number; author: string; status: string; trainMean: number | null; trainN: number; heldoutMean: number | null; heldoutN: number; acceptRate: number | null }[];
  trend: { cycle: string; trainRunScore: number | null; heldoutRunScore: number | null; tokens: number }[];
};

const tone: Record<string, string> = { accepted: "text-ok", deterministic: "text-water", cached: "text-water", rejected: "text-crit", failed: "text-crit", denied: "text-warn" };

/** One line per agent output: the prose field each role submits. */
function summary(output: unknown): string {
  if (!output || typeof output !== "object") return "";
  const o = output as Record<string, unknown>;
  const text = o.explanation ?? o.handoff ?? o.answer ?? (Array.isArray(o.notes) ? (o.notes as { note: string }[]).map((n) => n.note).join(" ") : undefined) ?? o.note;
  return typeof text === "string" ? text : "";
}

/** The orchestrator's task tree and the prompt registry. Advice only: nothing here approves or dispatches. */
export function AgentsPanel({ runId }: { runId: string }) {
  const [run, setRun] = useState<AgentRun | null>(null);
  const [learning, setLearning] = useState<Learning | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadLearning = useCallback(() => api.api.agents.learning.get().then((r) => setLearning(unwrap(r) as unknown as Learning)).catch(() => {}), []);
  useEffect(() => { void loadLearning(); }, [loadLearning]);
  useEffect(() => {
    if (!run || run.status !== "running") return;
    const t = setTimeout(async () => {
      try { const next = unwrap(await api.api["agent-runs"]({ id: run.id }).get()) as unknown as AgentRun; setRun(next); if (next.status !== "running") void loadLearning(); }
      catch (e) { setError((e as Error).message); }
    }, 1500);
    return () => clearTimeout(t);
  }, [run, loadLearning]);

  const start = async () => {
    setError(null);
    try { setRun(unwrap(await api.api.runs({ id: runId }).agents.post()) as unknown as AgentRun); }
    catch (e) { setError((e as Error).message); }
  };
  const nodes = run?.nodes ?? [];
  const ordered: Node[] = [];
  const visit = (parent: string | null) => nodes.filter((n) => n.parentId === parent).forEach((n) => { ordered.push(n); visit(n.id); });
  visit(null);

  return (
    <div className="mt-6 grid max-w-[980px] gap-4">
      <Tile className="px-6 py-5">
        <div className="flex items-center gap-2.5">
          <NemotronMark className="size-5" />
          <h3 className="text-[15px] font-semibold text-text">One coordinator, specialists as tools</h3>
          <button type="button" onClick={start} disabled={run?.status === "running"} className="ml-auto rounded-lg bg-text px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50">
            {run?.status === "running" ? "Agents working…" : "Run agents"}
          </button>
        </div>
        <p className="mt-1 text-[13px] text-muted-foreground">
          The orchestrator decides which Nemotron sub-agents run and grants or refuses their subtask requests. Every output is checked against the snapshot; the plan solver still decides.
        </p>
        {error && <p className="mt-3 text-[14px] text-crit">{error}</p>}
        {run?.trace && (
          <p className="mt-3 text-[13px] text-muted-foreground">
            Strategy v{run.trace.strategy.version}: {run.trace.totals.nodes} agents, {run.trace.totals.accepted} accepted, {run.trace.totals.denied} refused, depth {run.trace.totals.maxDepth}, {(run.trace.totals.inputTokens + run.trace.totals.outputTokens).toLocaleString()} tokens, {(run.trace.totals.latencyMs / 1000).toFixed(1)} s, score {run.trace.score.toFixed(2)}.
          </p>
        )}
        {ordered.length > 0 && (
          <ol className="mt-4 flex flex-col gap-2.5">
            {ordered.map((n) => (
              <li key={n.id} className="text-[13px] leading-snug" style={{ paddingLeft: `${n.depth * 20}px` }}>
                <span className="font-medium text-text">{n.role.replace("_", " ")}</span>
                <span className={cn("ml-2", tone[n.status] ?? "text-faint")}>{n.status}</span>
                <span className="ml-2 text-faint">
                  {n.promptVersion ? `prompt v${n.promptVersion} · ` : ""}{n.toolsCalled.length ? `${[...new Set(n.toolsCalled)].join(", ")} · ` : ""}{n.inputTokens ? `${(n.inputTokens + (n.outputTokens ?? 0)).toLocaleString()} tok · ` : ""}{n.latencyMs ? `${(n.latencyMs / 1000).toFixed(1)} s` : ""}{n.score ? ` · score ${n.score.total.toFixed(2)}` : ""}
                </span>
                {n.requestedBy && <p className="text-faint">requested by {n.requestedBy}: {n.reason}</p>}
                {summary(n.output) && <p className="text-muted-foreground">{summary(n.output)}</p>}
                {n.error && <p className="text-crit">{n.error}</p>}
                {!!n.rejections?.length && <p className="text-warn">Rejected {n.rejections.length}×: {n.rejections[n.rejections.length - 1]}</p>}
              </li>
            ))}
          </ol>
        )}
      </Tile>

      {learning && (
        <Tile className="px-6 py-5">
          <h3 className="text-[15px] font-semibold text-text">Prompt versions and weekly scores</h3>
          <p className="mt-1 text-[13px] text-muted-foreground">Scored only by validators and snapshot facts. Held-out runs are never shown to the critic.</p>
          <table className="mt-3 w-full text-[13px]">
            <thead className="text-left text-faint"><tr><th>Role</th><th>Version</th><th>Author</th><th>Status</th><th>Train</th><th>Held-out</th><th>Accepted</th></tr></thead>
            <tbody>
              {learning.versions.filter((v) => v.trainN + v.heldoutN > 0).map((v) => (
                <tr key={`${v.role}-${v.version}`} className={cn(v.status === "champion" && "font-semibold")}>
                  <td>{v.role.replace("_", " ")}</td><td>v{v.version}</td><td>{v.author}</td><td>{v.status}</td>
                  <td>{v.trainMean ?? "–"} ({v.trainN})</td><td>{v.heldoutMean ?? "–"} ({v.heldoutN})</td><td>{v.acceptRate ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {learning.trend.length > 0 && (
            <p className="mt-3 text-[13px] text-muted-foreground">
              {learning.trend.map((t) => `${t.cycle}: train ${t.trainRunScore ?? "–"}, held-out ${t.heldoutRunScore ?? "–"}`).join(" · ")}
            </p>
          )}
        </Tile>
      )}
    </div>
  );
}
