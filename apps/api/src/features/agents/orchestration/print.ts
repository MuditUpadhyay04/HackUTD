import type { AgentRunTrace, TaskNode } from "./orchestrator";

/** Plain-text task tree for the CLI. */
export function formatTrace(trace: AgentRunTrace): string {
  const lines = [`Agent run ${trace.id} | run ${trace.runId} rev ${trace.revision} | telemetry now ${trace.now} | strategy v${trace.strategy.version} (${trace.strategy.name})`,
    `Board: ${trace.board.length ? trace.board.filter((b) => b.heads.length).map((b) => `${b.facilityId} [${b.heads.join(",")}] ${b.status}`).join("; ") || "no active heads" : "none"}`,
    "Alerts view (deterministic, rule 7):", ...trace.alertsView.map((a) => `  ${a.rank}. ${a.line}`), "Task tree:"];
  const walk = (n: TaskNode, indent: string) => {
    const head = n.role === "orchestrator" ? `orchestrator: ${n.reason}` :
      `${n.role}${n.incidentId ? ` [${n.incidentId.split(":").slice(1, 3).join(" ")}]` : ""} v${n.promptVersion ?? "-"} ${n.status}` +
      (n.modelCalls ? ` | ${n.modelCalls} calls, ${n.inputTokens}/${n.outputTokens} tok, ${(n.latencyMs / 1000).toFixed(1)} s, rejected ${n.rejections.length}, score ${n.score?.total ?? "-"}` : "") +
      ` | by ${n.requestedBy}: ${n.reason}${n.question ? ` | q: ${n.question}` : ""}`;
    lines.push(indent + head);
    if (n.toolsCalled.length) lines.push(`${indent}   tools: ${n.toolsCalled.join(", ")}`);
    if (n.output && n.role !== "orchestrator") lines.push(`${indent}   out: ${JSON.stringify(n.output).slice(0, 500)}`);
    if (n.error && n.status !== "accepted") lines.push(`${indent}   error: ${n.error}`);
    for (const c of n.children) walk(trace.nodes.find((x) => x.id === c)!, indent + "  ");
  };
  walk(trace.nodes[0]!, "  ");
  const t = trace.totals;
  lines.push(`Totals: ${t.nodes} sub-agents, ${t.accepted} accepted, ${t.denied} refused requests, depth ${t.maxDepth}, ${t.modelCalls} model calls, ${t.inputTokens}/${t.outputTokens} tokens, ${(t.latencyMs / 1000).toFixed(1)} s, run score ${trace.score}`);
  return lines.join("\n");
}
export function printTrace(trace: AgentRunTrace) { console.log(formatTrace(trace)); }
