import type { Provider, ProviderDispatch, Thinking } from "./runtime";

/** Free chat models only. Embeddings and rerankers are not drop-in completions, and a paid id is rejected at boot. */
export const DEFAULT_FREE_NEMOTRON_MODELS = [
  "nvidia/nemotron-3.5-lightning:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nvidia/nemotron-3.5-super-vl:free",
] as const;

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

const BREV_COOL_MS = 20_000;
const KEY_AUTH_COOL_MS = 120_000;
const KEY_PAYMENT_COOL_MS = 600_000;
const KEY_RATE_COOL_MS = 45_000;
const KEY_TRANSIENT_COOL_MS = 20_000;
const MODEL_COOL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 12;
const RECENT_LIMIT = 40;

export function isFreeNemotronModel(id: string): boolean {
  const slug = id.trim().toLowerCase();
  if (!slug.endsWith(":free")) return false;
  const name = slug.slice(0, -":free".length);
  if (!name.startsWith("nvidia/") || !name.includes("nemotron")) return false;
  if (name.includes("embed") || name.includes("rerank")) return false;
  return true;
}

/** Last four characters once the secret is long enough that the tail is not the whole key. */
export function maskKey(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length < 12) return "…";
  return `…${trimmed.slice(-4)}`;
}

export function redact(text: string): string {
  return text
    .replace(/sk-or-[A-Za-z0-9_-]+/g, "sk-or-…")
    .replace(/Bearer\s+\S+/gi, "Bearer …")
    .replace(/\b[a-f0-9]{32,}\b/gi, "…");
}

export type LaneName = "brev" | "openrouter";
export type LaneState = "in-use" | "standby" | "cooling" | "unconfigured";

export interface ProviderEvent {
  at: string;
  kind: "chat" | "probe";
  lane: LaneName;
  keyId: string | null;
  model: string;
  ok: boolean;
  status: number | null;
  error: string | null;
}

export interface ProviderStatus {
  primary: "brev" | "openrouter" | "none";
  next: { lane: "brev" | "openrouter" | "none"; model: string | null; keyId: string | null };
  lastChat: { at: string; lane: LaneName; model: string; keyId: string | null } | null;
  brev: {
    configured: boolean;
    host: string | null;
    model: string | null;
    state: LaneState;
    cooldownUntil: string | null;
    successes: number;
    failures: number;
    lastStatus: number | null;
    lastError: string | null;
    lastUsedAt: string | null;
  };
  openrouter: {
    configured: boolean;
    models: { id: string; state: "ready" | "cooling"; cooldownUntil: string | null }[];
    keys: {
      id: string;
      hint: string;
      state: "in-use" | "standby" | "cooling";
      cooldownUntil: string | null;
      successes: number;
      failures: number;
      lastStatus: number | null;
      lastError: string | null;
      lastUsedAt: string | null;
      freeTier: boolean | null;
    }[];
  };
  recent: ProviderEvent[];
}

interface KeyState {
  index: number;
  id: string;
  secret: string;
  hint: string;
  cooldownUntil: number;
  successes: number;
  failures: number;
  lastStatus: number | null;
  lastError: string | null;
  lastUsedAt: string | null;
  freeTier: boolean | null;
}

interface BrevState {
  baseUrl: string;
  host: string;
  model: string;
  apiKey: string;
  cooldownUntil: number;
  successes: number;
  failures: number;
  lastStatus: number | null;
  lastError: string | null;
  lastUsedAt: string | null;
}

type Step = { lane: "brev" } | { lane: "openrouter"; keyIndex: number };

interface Attempt {
  lane: LaneName;
  model: string;
  keyId: string | null;
  keyIndex: number | null;
  url: string;
  init: RequestInit;
}

/**
 * Brev is tried first. A failed chat completion is sent again to OpenRouter, on a free Nemotron model,
 * walking the key list. Cooldowns skip a lane that just failed so the next call does not wait on it.
 * The snapshot never includes a key or a bearer token.
 */
export class ProviderPool implements ProviderDispatch {
  private readonly brev?: BrevState;
  private readonly keys: KeyState[];
  private readonly models: string[];
  private readonly modelCooldown = new Map<string, number>();
  private readonly events: ProviderEvent[] = [];
  private keyCursor = 0;
  private modelCursor = 0;
  private lastChat: ProviderStatus["lastChat"] = null;

  constructor(private readonly options: {
    primary: ProviderStatus["primary"];
    brev?: { baseUrl: string; model: string; apiKey: string };
    keys: string[];
    models: string[];
    now?: () => number;
  }) {
    if (options.brev) {
      this.brev = { ...options.brev, host: hostOf(options.brev.baseUrl), cooldownUntil: 0, successes: 0, failures: 0, lastStatus: null, lastError: null, lastUsedAt: null };
    }
    this.keys = options.keys.map((secret, index) => ({
      index, id: `key-${index + 1}`, secret, hint: maskKey(secret), cooldownUntil: 0,
      successes: 0, failures: 0, lastStatus: null, lastError: null, lastUsedAt: null, freeTier: null,
    }));
    this.models = options.models.length ? [...options.models] : [...DEFAULT_FREE_NEMOTRON_MODELS];
  }

  activeModel(): string | null { return this.lastChat?.model ?? null; }

  async dispatch(provider: Provider, url: string, init: RequestInit, base: (url: string, init: RequestInit) => Promise<Response>): Promise<Response> {
    if (!isChat(url)) return base(url, init);
    if (init.signal?.aborted) throw abortError();
    const queue = this.steps();
    const seen = new Set<string>();
    let lastResponse: Response | undefined;
    let lastError: unknown;
    while (queue.length && seen.size < MAX_ATTEMPTS) {
      if (init.signal?.aborted) throw abortError();
      const step = queue.shift()!;
      const attempt = this.attempt(step, url, init, provider.thinking);
      if (!attempt) continue;
      const stamp = `${attempt.lane}:${attempt.keyId ?? "brev"}:${attempt.model}`;
      if (seen.has(stamp)) continue;
      seen.add(stamp);
      try {
        const res = await base(attempt.url, attempt.init);
        if (res.ok) {
          this.noteChatOk(attempt, res.status);
          return res;
        }
        const detail = await errorDetail(res);
        this.noteChatFail(attempt, res.status, detail);
        lastResponse = res;
        if (!shouldRetry(attempt.lane, res.status, detail)) return res;
        const modelProblem = attempt.lane === "openrouter" && isModelProblem(res.status, detail);
        if (!modelProblem) this.cool(attempt, res.status);
        if (modelProblem) {
          const failed = attempt.model;
          this.advanceModel(failed);
          if (this.currentModel() !== failed && attempt.keyIndex !== null) queue.unshift({ lane: "openrouter", keyIndex: attempt.keyIndex });
        }
      } catch (error) {
        if (isAbort(error)) throw error;
        const message = messageOf(error);
        this.noteChatFail(attempt, null, message);
        this.cool(attempt, 503);
        lastError = error;
      }
    }
    if (lastResponse) return lastResponse;
    if (lastError instanceof Error) throw lastError;
    return base(url, init);
  }

  /** Asks Brev for its model list and OpenRouter for each key, without spending a completion. */
  async probe(fetchImpl: typeof fetch = fetch): Promise<ProviderStatus> {
    if (this.brev) await this.probeBrev(fetchImpl);
    for (const key of this.keys) await this.probeKey(fetchImpl, key);
    return this.status();
  }

  status(): ProviderStatus {
    const now = this.now();
    const step = this.steps()[0];
    const next: ProviderStatus["next"] = !step ? { lane: "none", model: null, keyId: null }
      : step.lane === "brev" ? { lane: "brev", model: this.brev?.model ?? null, keyId: null }
      : { lane: "openrouter", model: this.keys.length ? this.currentModel() : null, keyId: this.keys[step.keyIndex]?.id ?? null };
    const iso = (ms: number) => ms > now ? new Date(ms).toISOString() : null;
    return {
      primary: this.options.primary,
      next,
      lastChat: this.lastChat,
      brev: this.brev ? {
        configured: true, host: this.brev.host, model: this.brev.model,
        state: this.brev.cooldownUntil > now ? "cooling" : next.lane === "brev" ? "in-use" : "standby",
        cooldownUntil: iso(this.brev.cooldownUntil), successes: this.brev.successes, failures: this.brev.failures,
        lastStatus: this.brev.lastStatus, lastError: this.brev.lastError, lastUsedAt: this.brev.lastUsedAt,
      } : { configured: false, host: null, model: null, state: "unconfigured", cooldownUntil: null, successes: 0, failures: 0, lastStatus: null, lastError: null, lastUsedAt: null },
      openrouter: {
        configured: this.keys.length > 0,
        models: this.keys.length ? this.models.map((id) => ({ id, state: (this.modelCooldown.get(id) ?? 0) > now ? "cooling" as const : "ready" as const, cooldownUntil: iso(this.modelCooldown.get(id) ?? 0) })) : [],
        keys: this.keys.map((key) => ({
          id: key.id, hint: key.hint,
          state: key.cooldownUntil > now ? "cooling" as const : next.lane === "openrouter" && next.keyId === key.id ? "in-use" as const : "standby" as const,
          cooldownUntil: iso(key.cooldownUntil), successes: key.successes, failures: key.failures,
          lastStatus: key.lastStatus, lastError: key.lastError, lastUsedAt: key.lastUsedAt, freeTier: key.freeTier,
        })),
      },
      recent: this.events.slice(-RECENT_LIMIT).reverse(),
    };
  }

  private steps(): Step[] {
    const now = this.now();
    const steps: Step[] = [];
    if (this.options.primary === "brev" && this.brev && this.brev.cooldownUntil <= now) steps.push({ lane: "brev" });
    if (this.keys.length && this.options.primary !== "none") {
      for (let n = 0; n < this.keys.length; n++) {
        const index = (this.keyCursor + n) % this.keys.length;
        const key = this.keys[index];
        if (key && key.cooldownUntil <= now) steps.push({ lane: "openrouter", keyIndex: index });
      }
    }
    if (steps.length) return steps;
    if (this.options.primary === "brev" && this.brev) return [{ lane: "brev" }];
    if (this.keys.length) return [{ lane: "openrouter", keyIndex: this.keyCursor % this.keys.length }];
    return [];
  }

  private attempt(step: Step, url: string, init: RequestInit, thinking: Thinking | undefined): Attempt | null {
    if (step.lane === "brev") {
      const brev = this.brev;
      if (!brev) return null;
      return { lane: "brev", model: brev.model, keyId: null, keyIndex: null, url, init };
    }
    const key = this.keys[step.keyIndex];
    if (!key) return null;
    const model = this.currentModel();
    const rewritten = rewriteForOpenRouter(init, key.secret, model, thinking);
    if (!rewritten) return null;
    return { lane: "openrouter", model, keyId: key.id, keyIndex: key.index, url: `${OPENROUTER_BASE}/chat/completions`, init: rewritten };
  }

  private currentModel(): string {
    const now = this.now();
    for (let n = 0; n < this.models.length; n++) {
      const model = this.models[(this.modelCursor + n) % this.models.length];
      if (model && (this.modelCooldown.get(model) ?? 0) <= now) return model;
    }
    return this.models[this.modelCursor] ?? DEFAULT_FREE_NEMOTRON_MODELS[0];
  }

  private advanceModel(failed: string) {
    this.modelCooldown.set(failed, this.now() + MODEL_COOL_MS);
    const index = this.models.indexOf(failed);
    if (index >= 0 && this.models.length) this.modelCursor = (index + 1) % this.models.length;
  }

  private cool(attempt: Attempt, status: number) {
    const until = this.now() + cooldownMs(attempt.lane, status);
    if (attempt.lane === "brev" && this.brev) this.brev.cooldownUntil = until;
    if (attempt.keyIndex !== null) {
      const key = this.keys[attempt.keyIndex];
      if (key) {
        key.cooldownUntil = until;
        this.keyCursor = (attempt.keyIndex + 1) % this.keys.length;
      }
    }
  }

  private noteChatOk(attempt: Attempt, status: number) {
    this.touch(attempt, { ok: true, status, error: null, kind: "chat", countSuccess: true });
    if (attempt.lane === "brev" && this.brev) this.brev.cooldownUntil = 0;
    if (attempt.keyIndex !== null) {
      const key = this.keys[attempt.keyIndex];
      if (key) key.cooldownUntil = 0;
      this.keyCursor = attempt.keyIndex;
    }
    this.lastChat = { at: new Date(this.now()).toISOString(), lane: attempt.lane, model: attempt.model, keyId: attempt.keyId };
  }

  private noteChatFail(attempt: Attempt, status: number | null, error: string) {
    this.touch(attempt, { ok: false, status, error, kind: "chat", countSuccess: false });
  }

  private touch(attempt: Attempt, outcome: { ok: boolean; status: number | null; error: string | null; kind: ProviderEvent["kind"]; countSuccess: boolean }) {
    const at = new Date(this.now()).toISOString();
    const slot = attempt.lane === "brev" ? this.brev : this.keys[attempt.keyIndex ?? -1];
    if (slot) {
      if (outcome.ok && outcome.countSuccess) slot.successes += 1;
      if (!outcome.ok && outcome.kind === "chat") slot.failures += 1;
      slot.lastStatus = outcome.status;
      slot.lastError = outcome.ok ? null : outcome.error;
      slot.lastUsedAt = at;
    }
    this.events.push({ at, kind: outcome.kind, lane: attempt.lane, keyId: attempt.keyId, model: attempt.model, ok: outcome.ok, status: outcome.status, error: outcome.ok ? null : outcome.error });
    if (this.events.length > RECENT_LIMIT * 2) this.events.splice(0, this.events.length - RECENT_LIMIT);
  }

  private async probeBrev(fetchImpl: typeof fetch) {
    const brev = this.brev;
    if (!brev) return;
    const attempt: Attempt = { lane: "brev", model: brev.model, keyId: null, keyIndex: null, url: "", init: {} };
    try {
      const res = await fetchImpl(`${brev.baseUrl}/models`, { headers: { authorization: `Bearer ${brev.apiKey}` }, signal: AbortSignal.timeout(8_000) });
      if (res.ok) {
        this.touch(attempt, { ok: true, status: res.status, error: null, kind: "probe", countSuccess: false });
        brev.cooldownUntil = 0;
        brev.lastError = null;
      } else {
        const detail = await errorDetail(res);
        this.touch(attempt, { ok: false, status: res.status, error: detail, kind: "probe", countSuccess: false });
        brev.cooldownUntil = this.now() + cooldownMs("brev", res.status);
      }
    } catch (error) {
      this.touch(attempt, { ok: false, status: null, error: messageOf(error), kind: "probe", countSuccess: false });
      brev.cooldownUntil = this.now() + cooldownMs("brev", 503);
    }
  }

  private async probeKey(fetchImpl: typeof fetch, key: KeyState) {
    const attempt: Attempt = { lane: "openrouter", model: this.currentModel(), keyId: key.id, keyIndex: key.index, url: "", init: {} };
    try {
      const res = await fetchImpl(`${OPENROUTER_BASE}/key`, { headers: { authorization: `Bearer ${key.secret}` }, signal: AbortSignal.timeout(8_000) });
      if (res.ok) {
        key.freeTier = await freeTierFlag(res);
        this.touch(attempt, { ok: true, status: res.status, error: null, kind: "probe", countSuccess: false });
        key.cooldownUntil = 0;
        key.lastError = null;
      } else {
        const detail = await errorDetail(res);
        this.touch(attempt, { ok: false, status: res.status, error: detail, kind: "probe", countSuccess: false });
        key.cooldownUntil = this.now() + cooldownMs("openrouter", res.status);
      }
    } catch (error) {
      this.touch(attempt, { ok: false, status: null, error: messageOf(error), kind: "probe", countSuccess: false });
      key.cooldownUntil = this.now() + cooldownMs("openrouter", 503);
    }
  }

  private now() { return this.options.now?.() ?? Date.now(); }
}

export function attachProviderPool(config: { provider?: Provider; openrouter?: { keys: string[]; models: string[] } }): ProviderPool {
  const primary: ProviderStatus["primary"] = config.provider?.transport === "openrouter" ? "openrouter" : config.provider ? "brev" : "none";
  const pool = new ProviderPool({
    primary,
    brev: primary === "brev" && config.provider ? { baseUrl: config.provider.baseUrl, model: config.provider.model, apiKey: config.provider.apiKey } : undefined,
    keys: config.openrouter?.keys ?? [],
    models: config.openrouter?.models?.length ? config.openrouter.models : [...DEFAULT_FREE_NEMOTRON_MODELS],
  });
  if (config.provider) config.provider.pool = pool;
  return pool;
}

function hostOf(baseUrl: string): string {
  try { return new URL(baseUrl).host; } catch { return "unknown"; }
}

function isChat(url: string): boolean {
  try { return new URL(url).pathname.replace(/\/$/, "").endsWith("/chat/completions"); }
  catch { return url.endsWith("/chat/completions"); }
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function messageOf(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error)).slice(0, 180);
}

function shouldRetry(lane: LaneName, status: number, detail: string): boolean {
  // A Brev 400 usually means the instance is up but the vLLM request was refused; OpenRouter can still answer it.
  if (lane === "brev" && status === 400) return true;
  if (status === 400) return isModelProblem(status, detail);
  return status === 401 || status === 402 || status === 403 || status === 404 || status === 408 || status === 409 || status === 429 || status >= 500;
}

function isModelProblem(status: number, detail: string): boolean {
  if (status === 404) return true;
  return status === 400 && /model|endpoint|provider/i.test(detail);
}

function cooldownMs(lane: LaneName, status: number): number {
  if (lane === "brev") return status === 401 || status === 403 ? KEY_AUTH_COOL_MS : status === 429 ? KEY_RATE_COOL_MS : BREV_COOL_MS;
  if (status === 401 || status === 403) return KEY_AUTH_COOL_MS;
  if (status === 402) return KEY_PAYMENT_COOL_MS;
  if (status === 429) return KEY_RATE_COOL_MS;
  return KEY_TRANSIENT_COOL_MS;
}

function openrouterReasoning(thinking: Thinking | undefined): Record<string, unknown> {
  if (!thinking || thinking.mode === "off") return { reasoning: { enabled: false } };
  if (thinking.mode === "on") return { reasoning: { enabled: true } };
  if (thinking.mode === "budget") return { reasoning: { max_tokens: thinking.tokens } };
  const unreachable: never = thinking;
  return unreachable;
}

/** Rewrites a Brev chat body onto one free model. Returns null when the body is not JSON, so a paid model id is never forwarded. */
function rewriteForOpenRouter(init: RequestInit, apiKey: string, model: string, thinking: Thinking | undefined): RequestInit | null {
  const text = decodeBody(init.body);
  if (text === undefined) return null;
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(text) as Record<string, unknown>; }
  catch { return null; }
  delete parsed.chat_template_kwargs;
  delete parsed.thinking_token_budget;
  parsed.model = model;
  const previous = parsed.provider;
  parsed.provider = { ...(previous && typeof previous === "object" ? previous as Record<string, unknown> : {}), allow_fallbacks: false };
  Object.assign(parsed, openrouterReasoning(thinking));
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${apiKey}`);
  headers.set("http-referer", "http://127.0.0.1:3000");
  headers.set("x-title", "Beat the Shutdown");
  headers.delete("content-length");
  return { ...init, headers, body: JSON.stringify(parsed) };
}

function decodeBody(body: RequestInit["body"]): string | undefined {
  if (typeof body === "string") return body;
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (ArrayBuffer.isView(body)) return new TextDecoder().decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  return undefined;
}

async function errorDetail(res: Response): Promise<string> {
  let text = "";
  try { text = await res.clone().text(); } catch { return `HTTP ${res.status}`; }
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const message = typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? parsed.message;
    if (typeof message === "string" && message.trim()) return redact(message).slice(0, 180);
  } catch { /* plain text */ }
  const flat = redact(text).replace(/\s+/g, " ").trim();
  return (flat || `HTTP ${res.status}`).slice(0, 180);
}

async function freeTierFlag(res: Response): Promise<boolean | null> {
  try {
    const parsed = await res.clone().json() as { data?: { is_free_tier?: unknown } };
    return typeof parsed.data?.is_free_tier === "boolean" ? parsed.data.is_free_tier : null;
  } catch { return null; }
}
