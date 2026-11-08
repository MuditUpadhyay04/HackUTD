import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { jsonSchema, tool, ToolLoopAgent, type StepResult, type ToolSet } from "ai";
import { COORDINATOR_INSTRUCTIONS, DEFAULT_MAX_OUTPUT_TOKENS, MAX_MODEL_CALLS, providerFetch, validateProvider, type CoordinatorRuntime, type Provider, type RunResult } from "./runtime";
import { createTools, validateFinalization, type Facts, type Finalization } from "./tools";

export interface AiSdkRuntimeOptions { provider: Provider; fetch?: typeof fetch }


/**
 * Fallback coordinator: AI SDK v7 ToolLoopAgent on the same OpenAI-compatible endpoint, the same read-only tools and
 * instructions, and the same thinking control (through the shared fetch). Facts reach the model only through tools.
 * There is no durable session, so no session link is reported.
 */
export function createAiSdkRuntime(options: AiSdkRuntimeOptions): CoordinatorRuntime {
  validateProvider(options.provider);
  const send = providerFetch(options.provider, options.fetch);
  const provider = createOpenAICompatible({
    baseURL: options.provider.baseUrl, name: "hackutd-nemotron", apiKey: options.provider.apiKey, includeUsage: true,
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => send(input instanceof Request ? input.url : String(input), init ?? {})) as typeof fetch,
  });
  const definitions = createTools();

  return {
    async run(facts: Facts, signal: AbortSignal): Promise<RunResult> {
      const tools: ToolSet = {};
      for (const t of definitions) {
        tools[t.name] = tool({
          description: t.description,
          inputSchema: jsonSchema<Record<string, unknown>>(t.inputSchema as Parameters<typeof jsonSchema>[0]),
          execute: async (input: Record<string, unknown>) => t.execute(input, { context: facts }),
        });
      }
      const finalized = (steps: Array<StepResult<ToolSet>>) => steps.some((step) => step.toolResults.some((r) => r.toolName === "finalize_analysis"));
      const agent = new ToolLoopAgent({
        model: provider.chatModel(options.provider.model),
        instructions: COORDINATOR_INSTRUCTIONS,
        tools,
        maxOutputTokens: options.provider.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        stopWhen: [({ steps }) => steps.length >= MAX_MODEL_CALLS, ({ steps }) => finalized(steps)],
      });
      const result = await agent.generate({ prompt: "Review the snapshot, then call finalize_analysis with your handoff and relevant evidence and plan IDs.", abortSignal: signal });

      let finalization: Finalization | undefined;
      let toolCalls = 0, rejected = 0, lastRejection = "";
      for (const step of result.steps) {
        toolCalls += step.toolCalls.length;
        for (const part of step.content) {
          if (part.type === "tool-error" && part.toolName === "finalize_analysis") { rejected++; lastRejection = String(part.error instanceof Error ? part.error.message : part.error).slice(0, 200); }
          if (part.type === "tool-result" && part.toolName === "finalize_analysis") finalization = validateFinalization(facts, part.output);
        }
      }
      if (!finalization) throw new Error(`AI SDK coordinator did not return a valid finalize_analysis result in ${result.steps.length} steps (${toolCalls} tool calls, ${rejected} rejected finalizations${lastRejection ? `; last: ${lastRejection}` : ""})`);
      const usage = result.totalUsage;
      return { ...finalization, trace: { runtime: "ai-sdk", modelCalls: result.steps.length, toolCalls, rejectedFinalizations: rejected,
        ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}), ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}) } };
    },
    close: async () => {},
  };
}
