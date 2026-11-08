/**
 * One orchestrated agent run on a dataset cutoff, printed as a task tree (CLI trace).
 * bun apps/api/scripts/agent-run.ts --data <dataset dir> --at <unix> [--strategy 1|2] [--board results.jsonl] [--json out.json]
 * Reads NVIDIA_BASE_URL / NEMOTRON_MODEL / NVIDIA_API_KEY from the root .env (never printed).
 */
import { writeFileSync } from "node:fs";
import { loadConfig } from "../src/infrastructure/config";
import { createModel } from "../src/features/agents/orchestration/subagent";
import { orchestrate, SEED_STRATEGIES } from "../src/features/agents/orchestration/orchestrator";
import { SEED_TEMPLATES, RUN_ROLES } from "../src/features/agents/orchestration/roles";
import { loadDataset, readBoardJsonl, snapshotAt } from "../src/features/agents/orchestration/cases";
import { printTrace } from "../src/features/agents/orchestration/print";

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const config = loadConfig({ ...process.env, STORAGE_MODE: "memory", ALLOW_INSECURE_LOCAL: "1" });
if (!config.provider) throw new Error("Set NVIDIA_BASE_URL, NEMOTRON_MODEL and NVIDIA_API_KEY in the root .env");
const dataset = await loadDataset(arg("data") ?? "../HackUTD-ZeroDay/history/full_week");
const at = Number(arg("at") ?? dataset.info.nowUnix);
const snapshot = await snapshotAt(dataset, at);
const strategy = SEED_STRATEGIES.find((s) => s.version === Number(arg("strategy") ?? 2)) ?? SEED_STRATEGIES[1]!;
const prompts = Object.fromEntries(RUN_ROLES.map((r) => [r, { version: 1, template: SEED_TEMPLATES[r] }]));
const trace = await orchestrate({ model: createModel(config.provider), snapshot, board: readBoardJsonl(arg("board")), prompts, strategy });
printTrace(trace);
if (arg("json")) writeFileSync(arg("json")!, JSON.stringify(trace, null, 2));
