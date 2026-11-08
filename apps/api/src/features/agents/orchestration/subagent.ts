import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { jsonSchema, tool, ToolLoopAgent, type ModelMessage, type ToolSet } from "ai";
import { DEFAULT_MAX_OUTPUT_TOKENS, providerFetch, validateProvider, type Provider } from "../runtime";

/** A read-only tool for one sub-agent. execute may be async (request_subtask waits for a child). */
export interface ToolDef { name: string; description: string; inputSchema: Record<string, unknown>; execute: (input: Record<string, unknown>) => unknown | Promise<unknown> }

export interface SubAgentResult<O> {
  status: "accepted" | "rejected" | "failed";
  output: O | null; toolsCalled: string[]; modelCalls: number; inputTokens: number; outputTokens: number; latencyMs: number;
  rejections: string[]; rejectedInputs: string[]; error: string | null;
}

/** Caps concurrent model requests across every sub-agent in a run (children run inside a parent's tool call). */
export function limitConcurrency(base: typeof fetch, max: number): typeof fetch {
  let active = 0;
  const queue: (() => void)[] = [];
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (active >= max) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try { return await base(input as string, init); } finally { active--; queue.shift()?.(); }
  }) as typeof fetch;
}

export interface Model { chat: ReturnType<ReturnType<typeof createOpenAICompatible>["chatModel"]>; maxOutputTokens: number }

/** One OpenAI-compatible model handle; thinking control and the concurrency cap are applied in fetch. */
export function createModel(provider: Provider, options: { fetch?: typeof fetch; concurrency?: number } = {}): Model {
  validateProvider(provider);
  const shaped = providerFetch(provider, options.fetch);
  const send = limitConcurrency(((input: RequestInfo | URL, init?: RequestInit) => shaped(input instanceof Request ? input.url : String(input), init ?? {})) as typeof fetch, options.concurrency ?? 3);
  const openai = createOpenAICompatible({ baseURL: provider.baseUrl, name: "hackutd-nemotron", apiKey: provider.apiKey, includeUsage: true, fetch: send });
  return { chat: openai.chatModel(provider.model), maxOutputTokens: provider.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS };
}

/**
 * Runs one scoped sub-agent until its submit tool accepts (the validator is the submit tool's execute), or the
 * step budget runs out. Nothing here decides anything; the caller records and scores the result.
 */
export async function runSubAgent<O>(model: Model, spec: {
  instructions: string; prompt: string; tools: ToolDef[];
  submit: { name: string; description: string; inputSchema: Record<string, unknown>; validate: (input: Record<string, unknown>) => O };
  maxSteps: number; signal?: AbortSignal;
}): Promise<SubAgentResult<O>> {
  const started = Date.now();
  const toolsCalled: string[] = [];
  const rejections: string[] = [];
  const rejectedInputs: string[] = [];
  let output: O | null = null;
  const tools: ToolSet = {};
  for (const t of spec.tools) {
    tools[t.name] = tool({ description: t.description, inputSchema: jsonSchema<Record<string, unknown>>(t.inputSchema as Parameters<typeof jsonSchema>[0]),
      execute: async (input: Record<string, unknown>) => { toolsCalled.push(t.name); return t.execute(input ?? {}); } });
  }
  tools[spec.submit.name] = tool({ description: spec.submit.description, inputSchema: jsonSchema<Record<string, unknown>>(spec.submit.inputSchema as Parameters<typeof jsonSchema>[0]),
    execute: async (input: Record<string, unknown>) => {
      toolsCalled.push(spec.submit.name);
      try { output = spec.submit.validate(input ?? {}); return { accepted: true }; }
      catch (error) { const message = error instanceof Error ? error.message : String(error); rejections.push(message.slice(0, 300)); rejectedInputs.push(JSON.stringify(input).slice(0, 600)); throw new Error(message); }
    } });
  let steps = 0, inputTokens = 0, outputTokens = 0;
  try {
    const agent = new ToolLoopAgent({ model: model.chat, instructions: spec.instructions, tools, maxOutputTokens: model.maxOutputTokens,
      stopWhen: [({ steps: s }) => output !== null || steps + s.length >= spec.maxSteps] });
    let messages: ModelMessage[] = [{ role: "user", content: spec.prompt }];
    // A model that answers in plain text instead of calling the submit tool gets up to two reminders.
    for (let nudge = 0; nudge < 3 && output === null && steps < spec.maxSteps; nudge++) {
      const result = await agent.generate({ messages, abortSignal: spec.signal });
      steps += result.steps.length; inputTokens += result.totalUsage.inputTokens ?? 0; outputTokens += result.totalUsage.outputTokens ?? 0;
      messages = [...messages, ...result.responseMessages, { role: "user", content: `Call ${spec.submit.name} now with your answer; do not reply in plain text.` }];
    }
    return { status: output !== null ? "accepted" : "rejected", output, toolsCalled, modelCalls: steps, inputTokens, outputTokens,
      latencyMs: Date.now() - started, rejections, rejectedInputs, error: output !== null ? null : `No accepted ${spec.submit.name} within ${spec.maxSteps} model calls${rejections.length ? `; last: ${rejections.at(-1)}` : ""}` };
  } catch (error) {
    return { status: output !== null ? "accepted" : "failed", output, toolsCalled, modelCalls: steps, inputTokens, outputTokens, latencyMs: Date.now() - started, rejections, rejectedInputs,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
  }
}
