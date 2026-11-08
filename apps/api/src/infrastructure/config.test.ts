import { describe, expect, test } from "bun:test";
import { loadConfig, parseThinking } from "./config";

const base = { STORAGE_MODE: "memory", ALLOW_INSECURE_LOCAL: "1", NVIDIA_BASE_URL: "https://llm.example/v1/", NEMOTRON_MODEL: "m", NVIDIA_API_KEY: "k" };

describe("Nemotron provider config", () => {
  test("defaults: thinking off, 2048 output tokens, no context window, trailing slash trimmed", () => {
    const provider = loadConfig(base).provider!;
    expect(provider).toEqual({ baseUrl: "https://llm.example/v1", model: "m", apiKey: "k", maxOutputTokens: 2048, thinking: { mode: "off" } });
  });
  test("reads context window, output budget and thinking mode", () => {
    const provider = loadConfig({ ...base, NEMOTRON_CONTEXT_WINDOW: "1048576", NEMOTRON_MAX_OUTPUT_TOKENS: "4096", NEMOTRON_THINKING: "budget:256" }).provider!;
    expect(provider.contextWindow).toBe(1048576);
    expect(provider.maxOutputTokens).toBe(4096);
    expect(provider.thinking).toEqual({ mode: "budget", tokens: 256 });
  });
  test("rejects invalid values", () => {
    expect(() => loadConfig({ ...base, NEMOTRON_CONTEXT_WINDOW: "abc" })).toThrow("NEMOTRON_CONTEXT_WINDOW");
    expect(() => loadConfig({ ...base, NEMOTRON_CONTEXT_WINDOW: "4096", NEMOTRON_MAX_OUTPUT_TOKENS: "4096" })).toThrow("below");
    expect(() => loadConfig({ ...base, NEMOTRON_THINKING: "maybe" })).toThrow("NEMOTRON_THINKING");
    expect(() => loadConfig({ ...base, NVIDIA_BASE_URL: "http://llm.example/v1" })).toThrow("HTTPS");
  });
  test("no provider without all three settings", () => {
    expect(loadConfig({ ...base, NVIDIA_API_KEY: "" }).provider).toBeUndefined();
  });
  test("thinking parser", () => {
    expect(parseThinking(undefined)).toEqual({ mode: "off" });
    expect(parseThinking("ON")).toEqual({ mode: "on" });
    expect(() => parseThinking("budget:0")).toThrow();
  });
});
