import { describe, expect, test } from "bun:test";
import type { Snapshot } from "@hackutd/contracts";
import { createAiSdkRuntime } from "./runtime-ai-sdk";
import { factsFor } from "./tools";

const snapshot = { runId: "run", revision: 4, nowUnix: 100, runtime: { scoresAvailable: false }, coverage: { complete: false }, recommendation: { state: "ready", inputRevision: 4 }, history: [],
  alerts: [{ id: "incident", status: "ongoing", category: "pipeline_leak", facilityId: "facility", systemId: "system", assetId: "pipe", evidence: ["pressure drop"] }] } as unknown as Snapshot;

function completion(message: Record<string, unknown>, finish: string) {
  return new Response(JSON.stringify({ id: "c", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, message: { role: "assistant", content: null, ...message }, finish_reason: finish }],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }), { headers: { "content-type": "application/json" } });
}
const call = (name: string, args: unknown, id: string) => ({ tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });

describe("AI SDK v7 fallback runtime", () => {
  test("runs tools, repairs a rejected finalize, sends thinking off and no facts in the system prompt", async () => {
    const bodies: Record<string, unknown>[] = [];
    const replies = [
      completion(call("read_snapshot", {}, "t1"), "tool_calls"),
      completion(call("finalize_analysis", { handoff: "Review 99 trucks.", evidenceIds: ["incident:evidence:0"], planIds: [] }, "t2"), "tool_calls"),
      completion(call("finalize_analysis", { handoff: "Review the pipeline leak at facility.", evidenceIds: ["incident:evidence:0"], planIds: [] }, "t3"), "tool_calls"),
    ];
    const fakeFetch = (async (_url: string, init: RequestInit) => { bodies.push(JSON.parse(init.body as string)); return replies.shift()!; }) as unknown as typeof fetch;
    const runtime = createAiSdkRuntime({ provider: { baseUrl: "https://llm.example/v1", model: "m", apiKey: "k", maxOutputTokens: 512 }, fetch: fakeFetch });
    const result = await runtime.run(factsFor(snapshot), new AbortController().signal);
    expect(result.handoff).toBe("Review the pipeline leak at facility.");
    expect(result.evidenceIds).toEqual(["incident:evidence:0"]);
    expect(result.trace).toEqual({ runtime: "ai-sdk", modelCalls: 3, toolCalls: 3, rejectedFinalizations: 1, inputTokens: 300, outputTokens: 30 });
    expect(bodies).toHaveLength(3);
    expect(bodies[0]!.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(bodies[0]!.max_tokens).toBe(512);
    const system = JSON.stringify((bodies[0]!.messages as { role: string }[]).filter((m) => m.role === "system"));
    expect(system).toContain("finalize_analysis");
    expect(system).not.toContain("pressure drop");
    expect(JSON.stringify(bodies[2]!.messages)).toContain("Ungrounded number");
  });
  test("throws when the model never finalizes", async () => {
    const fakeFetch = (async () => completion({ content: "done" }, "stop")) as unknown as typeof fetch;
    const runtime = createAiSdkRuntime({ provider: { baseUrl: "https://llm.example/v1", model: "m", apiKey: "k" }, fetch: fakeFetch });
    await expect(runtime.run(factsFor(snapshot), new AbortController().signal)).rejects.toThrow("did not return a valid finalize_analysis");
  });
});
