import { describe, expect, test } from "bun:test";
import { providerFetch, thinkingBody, validateProvider, type Provider } from "./runtime";

const provider: Provider = { baseUrl: "https://llm.example/v1", model: "m", apiKey: "k" };
function recorder() {
  const calls: { url: string; init: RequestInit }[] = [];
  const base = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response("{}"); }) as unknown as typeof fetch;
  return { calls, base };
}

describe("Nemotron request shaping", () => {
  test("thinking modes map to vLLM body fields", () => {
    expect(thinkingBody(undefined)).toEqual({ chat_template_kwargs: { enable_thinking: false } });
    expect(thinkingBody({ mode: "off" })).toEqual({ chat_template_kwargs: { enable_thinking: false } });
    expect(thinkingBody({ mode: "on" })).toEqual({});
    expect(thinkingBody({ mode: "budget", tokens: 256 })).toEqual({ thinking_token_budget: 256 });
  });
  test("merges thinking fields into chat completions only, keeping other kwargs", async () => {
    const { calls, base } = recorder();
    const send = providerFetch(provider, base);
    await send("https://llm.example/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "m", chat_template_kwargs: { other: 1 } }) });
    await send("https://llm.example/v1/models", { method: "GET" });
    await send("https://elsewhere.example/v1/chat/completions", { method: "POST", body: "{}" });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ model: "m", chat_template_kwargs: { other: 1, enable_thinking: false } });
    expect(calls[1]!.init.body).toBeUndefined();
    expect(calls[2]!.init.body).toBe("{}");
  });
  test("thinking on sends the body unchanged", async () => {
    const { calls, base } = recorder();
    await providerFetch({ ...provider, thinking: { mode: "on" } }, base)("https://llm.example/v1/chat/completions", { method: "POST", body: "{\"a\":1}" });
    expect(calls[0]!.init.body).toBe("{\"a\":1}");
  });
  test("validates context window and output budget", () => {
    expect(() => validateProvider({ ...provider, contextWindow: 1048576, maxOutputTokens: 2048 })).not.toThrow();
    expect(() => validateProvider({ ...provider, contextWindow: 1024 })).toThrow("Invalid context window");
    expect(() => validateProvider({ ...provider, contextWindow: 4096, maxOutputTokens: 4096 })).toThrow("Invalid max output tokens");
    expect(() => validateProvider({ ...provider, maxOutputTokens: 10 })).toThrow("Invalid max output tokens");
  });
});
