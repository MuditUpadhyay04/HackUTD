import { describe, expect, test } from "bun:test";
import { providerFetch, type Provider } from "./runtime";
import { DEFAULT_FREE_NEMOTRON_MODELS, OPENROUTER_BASE, ProviderPool, isFreeNemotronModel, maskKey, redact, type ProviderStatus } from "./provider-pool";

const brevKey = "brev-DO-NOT-LEAK-0123456789abcdef0123456789abcdef";
const keyA = "sk-or-v1-SUPERSECRETaaaa";
const keyB = "sk-or-v1-SUPERSECRETbbbb";
const chat = "https://llm.example/v1/chat/completions";
const brevBody = JSON.stringify({ model: "nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4", chat_template_kwargs: { enable_thinking: false }, thinking_token_budget: 32 });

function scripted(responses: Array<Response | Error>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const base = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next ?? new Response("missing", { status: 500 });
  }) as (url: string, init: RequestInit) => Promise<Response>;
  return { calls, base };
}

function jsonBody(init: RequestInit) { return JSON.parse(String(init.body)) as Record<string, unknown>; }
function auth(init: RequestInit) { return new Headers(init.headers).get("authorization"); }

function pool(extra: { primary?: ProviderStatus["primary"]; keys?: string[]; models?: string[]; now?: () => number; thinking?: Provider["thinking"] } = {}) {
  const primary = extra.primary ?? "brev";
  const value = new ProviderPool({
    primary,
    brev: primary === "brev" ? { baseUrl: "https://llm.example/v1", model: "nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4", apiKey: brevKey } : undefined,
    keys: extra.keys ?? [keyA, keyB],
    models: extra.models ?? [...DEFAULT_FREE_NEMOTRON_MODELS],
    ...(extra.now ? { now: extra.now } : {}),
  });
  const provider: Provider = {
    baseUrl: primary === "openrouter" ? OPENROUTER_BASE : "https://llm.example/v1",
    model: primary === "openrouter" ? DEFAULT_FREE_NEMOTRON_MODELS[0] : "nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4",
    apiKey: primary === "openrouter" ? keyA : brevKey,
    ...(primary === "openrouter" ? { transport: "openrouter" as const } : {}),
    ...(extra.thinking ? { thinking: extra.thinking } : {}),
    pool: value,
  };
  return { value, provider };
}

describe("provider failover", () => {
  test("free nemotron ids are the only ones accepted", () => {
    for (const model of DEFAULT_FREE_NEMOTRON_MODELS) expect(isFreeNemotronModel(model)).toBe(true);
    expect(isFreeNemotronModel("nvidia/nemotron-3.5-lightning")).toBe(false);
    expect(isFreeNemotronModel("nvidia/nemotron-3.5-embed-1b:free")).toBe(false);
    expect(isFreeNemotronModel("nvidia/llama-nemotron-rerank:free")).toBe(false);
    expect(isFreeNemotronModel("openai/gpt-4o:free")).toBe(false);
    expect(maskKey("short")).toBe("…");
    expect(redact(`bearer leaked ${keyA} and ${brevKey.slice(-40)}`)).not.toContain("SUPERSECRET");
  });

  test("brev failure moves the chat onto the first free model and the first key", async () => {
    const { value, provider } = pool();
    const { calls, base } = scripted([new Response("down", { status: 503 }), new Response("ok", { status: 200 })]);
    const send = providerFetch(provider, base as typeof fetch);
    const res = await send(chat, { method: "POST", headers: { authorization: `Bearer ${brevKey}` }, body: brevBody });
    expect(await res.text()).toBe("ok");
    expect(calls[0]!.url).toBe(chat);
    expect(jsonBody(calls[0]!.init).chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(auth(calls[0]!.init)).toBe(`Bearer ${brevKey}`);
    expect(calls[1]!.url).toBe(`${OPENROUTER_BASE}/chat/completions`);
    expect(auth(calls[1]!.init)).toBe(`Bearer ${keyA}`);
    const moved = jsonBody(calls[1]!.init);
    expect(moved.model).toBe(DEFAULT_FREE_NEMOTRON_MODELS[0]);
    expect(moved.chat_template_kwargs).toBeUndefined();
    expect(moved.thinking_token_budget).toBeUndefined();
    expect(moved.reasoning).toEqual({ enabled: false });
    expect(moved.provider).toEqual({ allow_fallbacks: false });
    const status = value.status();
    expect(status.next).toEqual({ lane: "openrouter", model: DEFAULT_FREE_NEMOTRON_MODELS[0], keyId: "key-1" });
    expect(status.lastChat?.lane).toBe("openrouter");
    expect(status.brev.state).toBe("cooling");
    expect(status.openrouter.keys[0]).toMatchObject({ id: "key-1", hint: "…aaaa", state: "in-use", successes: 1, lastError: null });
    expect(JSON.stringify(status)).not.toContain("SUPERSECRET");
    expect(JSON.stringify(status)).not.toContain("DO-NOT-LEAK");
    expect(provider.pool?.activeModel()).toBe(DEFAULT_FREE_NEMOTRON_MODELS[0]);
  });

  test("a rate-limited key is skipped and the next key is kept", async () => {
    let now = 1_000_000;
    const { value, provider } = pool({ now: () => now });
    const { calls, base } = scripted([
      new Response("down", { status: 503 }),
      new Response(JSON.stringify({ error: { message: `rate limit ${keyA}` } }), { status: 429 }),
      new Response("ok", { status: 200 }),
    ]);
    await value.dispatch(provider, chat, { method: "POST", body: brevBody }, base);
    expect(auth(calls[2]!.init)).toBe(`Bearer ${keyB}`);
    expect(value.status().next.keyId).toBe("key-2");
    expect(value.status().openrouter.keys[0]?.state).toBe("cooling");
    const limited = value.status().recent.find((event) => event.status === 429);
    expect(limited?.error).toContain("rate limit");
    expect(limited?.error).not.toContain("SUPERSECRET");
    now += 19_000;
    const again = scripted([new Response("ok", { status: 200 })]);
    await value.dispatch(provider, chat, { method: "POST", body: brevBody }, again.base);
    expect(again.calls[0]!.url).toBe(`${OPENROUTER_BASE}/chat/completions`);
    now += 2_000;
    const recovered = scripted([new Response("ok", { status: 200 })]);
    await value.dispatch(provider, chat, { method: "POST", body: brevBody }, recovered.base);
    expect(recovered.calls[0]!.url).toBe(chat);
  });

  test("a missing openrouter model advances to the next free model on the same key", async () => {
    const { value, provider } = pool({ primary: "openrouter", models: ["nvidia/nemotron-3.5-lightning:free", "nvidia/nemotron-3-ultra-550b-a55b:free"] });
    const { calls, base } = scripted([
      new Response(JSON.stringify({ error: { message: "model not found" } }), { status: 404 }),
      new Response("ok", { status: 200 }),
    ]);
    await value.dispatch(provider, `${OPENROUTER_BASE}/chat/completions`, { method: "POST", body: "{\"model\":\"old\"}" }, base);
    expect(calls).toHaveLength(2);
    expect(auth(calls[0]!.init)).toBe(`Bearer ${keyA}`);
    expect(auth(calls[1]!.init)).toBe(`Bearer ${keyA}`);
    expect(jsonBody(calls[1]!.init).model).toBe("nvidia/nemotron-3-ultra-550b-a55b:free");
    expect(value.status().openrouter.models[0]?.state).toBe("cooling");
  });

  test("a bad prompt on openrouter does not burn the next key", async () => {
    const { value, provider } = pool({ primary: "openrouter" });
    const { calls, base } = scripted([new Response(JSON.stringify({ error: { message: "invalid request" } }), { status: 400 })]);
    const res = await value.dispatch(provider, `${OPENROUTER_BASE}/chat/completions`, { method: "POST", body: "{}" }, base);
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  test("brev refusal still falls back, and a non-chat call does not", async () => {
    const { value, provider } = pool({ thinking: { mode: "budget", tokens: 128 } });
    const refused = scripted([new Response("no", { status: 400 }), new Response("ok", { status: 200 })]);
    await value.dispatch(provider, chat, { method: "POST", body: brevBody }, refused.base);
    expect(refused.calls[1]!.url).toContain("openrouter.ai");
    expect(jsonBody(refused.calls[1]!.init).reasoning).toEqual({ max_tokens: 128 });
    const other = scripted([new Response("[]", { status: 200 })]);
    await value.dispatch(provider, "https://llm.example/v1/models", { method: "GET" }, other.base);
    expect(other.calls).toHaveLength(1);
    expect(other.calls[0]!.url).toBe("https://llm.example/v1/models");
  });

  test("an aborted chat is not retried", async () => {
    const { value, provider } = pool();
    const { calls, base } = scripted([new Response("ok", { status: 200 })]);
    await expect(value.dispatch(provider, chat, { method: "POST", body: "{}", signal: AbortSignal.abort() }, base)).rejects.toThrow(/abort/i);
    expect(calls).toHaveLength(0);
  });

  test("probe records key health without keeping the upstream payload", async () => {
    const { value } = pool();
    const { calls, base } = scripted([
      new Response("denied", { status: 401 }),
      new Response(JSON.stringify({ data: { label: keyA, is_free_tier: true } }), { status: 200 }),
      new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401 }),
    ]);
    const status = await value.probe(base as typeof fetch);
    expect(calls.map((call) => call.url)).toEqual(["https://llm.example/v1/models", `${OPENROUTER_BASE}/key`, `${OPENROUTER_BASE}/key`]);
    expect(status.brev).toMatchObject({ state: "cooling", lastStatus: 401 });
    expect(status.openrouter.keys[0]).toMatchObject({ hint: "…aaaa", freeTier: true, lastStatus: 200, state: "in-use" });
    expect(status.openrouter.keys[1]).toMatchObject({ state: "cooling", lastStatus: 401 });
    expect(status.recent.map((event) => event.kind)).toEqual(["probe", "probe", "probe"]);
    const dumped = JSON.stringify(status);
    expect(dumped).not.toContain("SUPERSECRET");
    expect(dumped).not.toContain("DO-NOT-LEAK");
    expect(dumped).not.toContain(keyA);
  });
});
