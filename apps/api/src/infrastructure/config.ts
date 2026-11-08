import { DomainError } from "@hackutd/contracts";
import { DEFAULT_FREE_NEMOTRON_MODELS, OPENROUTER_BASE, isFreeNemotronModel } from "../features/agents/provider-pool";
import type { Provider, Thinking } from "../features/agents/runtime";

export interface AppConfig {
  port: number; host: string; databaseUrl?: string; memory: boolean;
  apiToken?: string; insecureLocal: boolean; allowedOrigins: string[];
  sessionDir: string; modelMetadataPath?: string; provider?: Provider;
  /** Free-Nemotron OpenRouter keys. Used when Brev fails, or as the only lane when Brev is unset. */
  openrouter?: { keys: string[]; models: string[] };
  /** Agent learning state in memory mode (shared with scripts/agent-weeks.ts) and the board results file listen.py writes. */
  agentLearningFile?: string; boardJsonl?: string; boardSource?: "fpga" | "fakeboard";
  /** Folder(s) searched for dataset folders (network.json + ops.json + telemetry.csv), e.g. the reference repo's root. */
  dataRoots?: string[];
  /** Run the agents by themselves when the open incidents change at the newest moment (AGENTS_AUTO=0 turns it off). */
  agentsAuto?: boolean;
}
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const memory = env.STORAGE_MODE === "memory";
  const insecureLocal = env.ALLOW_INSECURE_LOCAL === "1";
  const host = env.API_HOST ?? "127.0.0.1";
  const port = Number(env.API_PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new DomainError("CONFIG", "API_PORT is invalid", 500);
  if (!memory && !env.DATABASE_URL) throw new DomainError("CONFIG", "Set DATABASE_URL for Tiger Data/PostgreSQL, or explicitly select STORAGE_MODE=memory for a nonpersistent demo", 500);
  if (!env.API_TOKEN && !insecureLocal) throw new DomainError("CONFIG", "Set API_TOKEN; unauthenticated access requires explicit ALLOW_INSECURE_LOCAL=1 on loopback", 500);
  if (insecureLocal && !["127.0.0.1", "localhost", "::1"].includes(host)) throw new DomainError("CONFIG", "Insecure demo mode may bind only to loopback", 500);
  const openrouter = parseOpenRouter(env);
  let provider: AppConfig["provider"];
  if (env.NVIDIA_API_KEY && env.NVIDIA_BASE_URL && env.NEMOTRON_MODEL) {
    const u = new URL(env.NVIDIA_BASE_URL);
    if (u.username || u.password || (u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)))) throw new DomainError("CONFIG", "Model endpoint must use HTTPS or local HTTP", 500);
    const limits = nemotronLimits(env);
    provider = { baseUrl: env.NVIDIA_BASE_URL.replace(/\/$/, ""), model: env.NEMOTRON_MODEL, apiKey: env.NVIDIA_API_KEY, ...limits };
  } else if (openrouter) {
    const limits = nemotronLimits(env);
    provider = { baseUrl: OPENROUTER_BASE, model: openrouter.models[0]!, apiKey: openrouter.keys[0]!, transport: "openrouter", ...limits };
  }
  return { host, port, memory, databaseUrl: env.DATABASE_URL, apiToken: env.API_TOKEN, insecureLocal,
    allowedOrigins: (env.ALLOWED_ORIGINS ?? "http://localhost:3000,http://127.0.0.1:3000").split(",").filter(Boolean),
    sessionDir: env.FX_SESSIONS_DIR ?? ".data/fx-sessions", modelMetadataPath: env.MODEL_METADATA_PATH, provider, openrouter,
    agentLearningFile: env.AGENT_LEARNING_FILE ?? ".data/agent-learning.json", boardJsonl: env.BOARD_JSONL || undefined,
    boardSource: env.BOARD_SOURCE === "fpga" || env.BOARD_SOURCE === "fakeboard" ? env.BOARD_SOURCE : undefined,
    agentsAuto: !["0", "off", "false"].includes((env.AGENTS_AUTO ?? "").toLowerCase()),
    dataRoots: (env.DATA_ROOT ?? "").split(process.platform === "win32" ? ";" : ":").map((s) => s.trim()).filter(Boolean) };
}

function parseOpenRouter(env: Record<string, string | undefined>): AppConfig["openrouter"] {
  const keys = [...new Set((env.OPENROUTER_API_KEYS ?? "").split(",").map((part) => part.trim()).filter(Boolean))];
  if (!keys.length) return undefined;
  const listed = (env.OPENROUTER_MODELS ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  const models = listed.length ? listed : [...DEFAULT_FREE_NEMOTRON_MODELS];
  for (const model of models) {
    if (!isFreeNemotronModel(model)) throw new DomainError("CONFIG", `OpenRouter model must be a free Nemotron chat model ending in :free (${model})`, 500);
  }
  return { keys, models };
}

function nemotronLimits(env: Record<string, string | undefined>): Pick<Provider, "contextWindow" | "maxOutputTokens" | "thinking"> {
  const contextWindow = optionalInteger(env.NEMOTRON_CONTEXT_WINDOW, "NEMOTRON_CONTEXT_WINDOW", 1025);
  const maxOutputTokens = optionalInteger(env.NEMOTRON_MAX_OUTPUT_TOKENS, "NEMOTRON_MAX_OUTPUT_TOKENS", 64) ?? 2048;
  if (contextWindow !== undefined && maxOutputTokens >= contextWindow) throw new DomainError("CONFIG", "NEMOTRON_MAX_OUTPUT_TOKENS must be below NEMOTRON_CONTEXT_WINDOW", 500);
  return { ...(contextWindow !== undefined ? { contextWindow } : {}), maxOutputTokens, thinking: parseThinking(env.NEMOTRON_THINKING) };
}

function optionalInteger(raw: string | undefined, name: string, min: number): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) throw new DomainError("CONFIG", `${name} must be an integer >= ${min}`, 500);
  return value;
}

/** NEMOTRON_THINKING: off (default; reasoning disabled per request), on (server default), or budget:N (vLLM thinking_token_budget). */
export function parseThinking(raw: string | undefined): Thinking {
  const value = (raw ?? "off").trim().toLowerCase();
  if (value === "" || value === "off") return { mode: "off" };
  if (value === "on") return { mode: "on" };
  const budget = /^budget:(\d+)$/.exec(value);
  if (budget && Number(budget[1]) >= 1) return { mode: "budget", tokens: Number(budget[1]) };
  throw new DomainError("CONFIG", "NEMOTRON_THINKING must be off, on, or budget:N", 500);
}
