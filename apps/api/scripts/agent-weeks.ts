/**
 * Simulated weekly learning loop. Each "week" is a successive window of the training dataset: deploy the champion
 * (and challengers), measure decisions against the following window's telemetry, promote winners, let the critic
 * propose next week's prompts, then score the champion on a held-out dataset that is never used for critique.
 *
 * bun apps/api/scripts/agent-weeks.ts --train <full_week dir> --heldout <mock_test dir> [--weeks 3] [--cases 2]
 *   [--heldout-cases 2] [--first-week 1] [--offset-hours 0] [--board full_week results.jsonl] [--heldout-board mock_test results.jsonl] [--store .data/agent-learning.json] [--fresh] [--out report.json]
 * Reads the provider from the root .env (never printed). Reads only network.json, ops.json and telemetry.csv.
 */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { loadConfig } from "../src/infrastructure/config";
import { createModel } from "../src/features/agents/orchestration/subagent";
import { buildCases, loadDataset, readBoardJsonl } from "../src/features/agents/orchestration/cases";
import { readBoardIndex } from "../src/features/runtimes/service";
import { MemoryLearningStore, champions } from "../src/features/agents/learning/store";
import { runCycle, type CycleReport } from "../src/features/agents/learning/cycle";
import { cycleTrend, planOutcomes, versionTable } from "../src/features/agents/learning/rollup";

const arg = (name: string, fallback?: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const config = loadConfig({ ...process.env, STORAGE_MODE: "memory", ALLOW_INSECURE_LOCAL: "1" });
if (!config.provider) throw new Error("Set NVIDIA_BASE_URL, NEMOTRON_MODEL and NVIDIA_API_KEY in the root .env");
const storeFile = arg("store", ".data/agent-learning.json")!;
if (process.argv.includes("--fresh") && existsSync(storeFile)) rmSync(storeFile);
const store = new MemoryLearningStore(storeFile);
await store.init();
const model = createModel(config.provider, { concurrency: Number(arg("concurrency", "3")) });
const weeks = Number(arg("weeks", "3")), perWeek = Number(arg("cases", "2"));
const train = await loadDataset(arg("train", "../HackUTD-ZeroDay/history/full_week")!);
const held = await loadDataset(arg("heldout", "../HackUTD-ZeroDay/history/mock_test_2026-10-10T1530")!);
const boardSource = arg("board-source") === "fpga" || arg("board-source") === "fakeboard" ? arg("board-source") as "fpga" | "fakeboard" : undefined;
const board = readBoardJsonl(arg("board"), boardSource);
const heldBoard = readBoardJsonl(arg("heldout-board"), boardSource);
// With --board / --heldout-board, the cases' detections come from the board results too (test plan step 2).
const boardIdx = arg("board") ? readBoardIndex(arg("board"), boardSource) : undefined;
const heldIdx = arg("heldout-board") ? readBoardIndex(arg("heldout-board"), boardSource) : undefined;
const heldCases = await buildCases(held, { from: held.info.startUnix, to: held.info.nowUnix + 1 }, { strideHours: 3, limit: Number(arg("heldout-cases", "2")), board: heldIdx });
console.log(`Held-out: ${held.info.label}: ${heldCases.map((c) => `${c.id} [${c.systems.join(",")}]`).join("; ")}`);
// Weeks start at the first cutoff with an ongoing incident: a quiet stretch has nothing to deploy agents on.
const first = (await buildCases(train, { from: train.info.startUnix, to: train.info.nowUnix }, { strideHours: 2, limit: 1, board: boardIdx }))[0];
const origin = first ? first.at - 3600 : train.info.startUnix;
const span = (train.info.nowUnix - origin) / weeks;
// A later pass over the same week (continuing a store) uses other cutoffs and continues the week numbering.
const firstWeek = Number(arg("first-week", "1")), offset = Number(arg("offset-hours", "0")) * 3600;
const reports: CycleReport[] = [];
for (let w = 0; w < weeks; w++) {
  const from = origin + w * span, to = from + span;
  const cases = await buildCases(train, { from: from + offset, to }, { strideHours: 4, limit: perWeek, board: boardIdx });
  const week = firstWeek + w;
  console.log(`\nWeek ${week} (${new Date(from * 1000).toISOString().slice(0, 16)}Z to ${new Date(to * 1000).toISOString().slice(0, 16)}Z): ${cases.map((c) => `${c.id} [${c.systems.join(",")}]`).join("; ")}`);
  reports.push(await runCycle({ store, model, cycle: `week${week}`, train: { dataset: train, cases, board }, heldout: { dataset: held, cases: heldCases, board: heldBoard }, log: console.log }));
}

const [prompts, strategies, evals, decisions] = await Promise.all([store.listPrompts(), store.listStrategies(), store.listEvals(), store.listDecisions()]);
console.log("\nScores per version (train = weekly windows of the training data; held-out = never critiqued):");
console.log("role             ver  author                 status      train (n)       held-out (n)    accept  tokens");
for (const r of versionTable(evals, prompts, strategies).filter((r) => r.trainN + r.heldoutN > 0)) {
  console.log(`${r.role.padEnd(16)} v${String(r.version).padEnd(3)} ${r.author.padEnd(22)} ${r.status.padEnd(11)} ${String(r.trainMean ?? "-").padEnd(6)} (${r.trainN})`.padEnd(80) + `${String(r.heldoutMean ?? "-").padEnd(6)} (${r.heldoutN})`.padEnd(16) + `${String(r.acceptRate ?? "-").padEnd(7)} ${r.meanTokens ?? "-"}`);
}
console.log("\nWeek-by-week run score (champion on held-out):");
for (const t of cycleTrend(evals)) console.log(`  ${t.cycle}: train ${t.trainRunScore}, held-out ${t.heldoutRunScore}, tokens ${t.tokens}`);
console.log("\nPlan outcomes (the following window's telemetry is the no-action path; nobody executed the advice):");
for (const p of planOutcomes(decisions)) console.log(`  ${p.kind}: ${p.decisions} decisions, ${p.measured} measured, tank limit reached without action ${p.tankLimitReachedRate}, recommendation justified ${p.justifiedRate}, do-nothing forecast matched ${p.forecastMatchRate}, mean cost $${p.meanCostUsd}, agent agreed ${p.agentAgreedRate}`);
const final = await champions(store);
console.log(`\nChampions now: ${Object.entries(final.prompts).map(([r, p]) => `${r} v${p!.version}`).join(", ")}; strategy v${final.strategy.version}`);
if (arg("out")) writeFileSync(arg("out")!, JSON.stringify({ reports, prompts, strategies, versions: versionTable(evals, prompts, strategies), trend: cycleTrend(evals), plans: planOutcomes(decisions) }, null, 2));
await store.close();
