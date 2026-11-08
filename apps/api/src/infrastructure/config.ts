import { DomainError } from "@hackutd/contracts";
import type { Provider, Thinking } from "../features/agents/runtime";

export interface AppConfig {
  port: number; host: string; databaseUrl?: string; memory: boolean;
  apiToken?: string; insecureLocal: boolean; allowedOrigins: string[];
  sessionDir: string; modelMetadataPath?: string; provider?: Provider;
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
  let provider: AppConfig["provider"];
  if (env.NVIDIA_API_KEY && env.NVIDIA_BASE_URL && env.NEMOTRON_MODEL) {
    const u = new URL(env.NVIDIA_BASE_URL);
    if (u.username || u.password || (u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)))) throw new DomainError("CONFIG", "Model endpoint must use HTTPS or local HTTP", 500);
    const contextWindow = optionalInteger(env.NEMOTRON_CONTEXT_WINDOW, "NEMOTRON_CONTEXT_WINDOW", 1025);
    const maxOutputTokens = optionalInteger(env.NEMOTRON_MAX_OUTPUT_TOKENS, "NEMOTRON_MAX_OUTPUT_TOKENS", 64) ?? 2048;
    if (contextWindow !== undefined && maxOutputTokens >= contextWindow) throw new DomainError("CONFIG", "NEMOTRON_MAX_OUTPUT_TOKENS must be below NEMOTRON_CONTEXT_WINDOW", 500);
    provider = { baseUrl: env.NVIDIA_BASE_URL.replace(/\/$/, ""), model: env.NEMOTRON_MODEL, apiKey: env.NVIDIA_API_KEY,
      ...(contextWindow !== undefined ? { contextWindow } : {}), maxOutputTokens, thinking: parseThinking(env.NEMOTRON_THINKING) };
  }
  return { host, port, memory, databaseUrl: env.DATABASE_URL, apiToken: env.API_TOKEN, insecureLocal,
    allowedOrigins: (env.ALLOWED_ORIGINS ?? "http://localhost:3000,http://127.0.0.1:3000").split(",").filter(Boolean),
    sessionDir: env.FX_SESSIONS_DIR ?? ".data/fx-sessions", modelMetadataPath: env.MODEL_METADATA_PATH, provider };
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
