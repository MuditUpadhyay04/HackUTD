// One command for the demo: `bun run demo`
//
// Stream  — one sensor reading a second, so the console looks like a live shift.
// Batch   — the whole dataset through the board as fast as it will go.
//
// Switch from the toolbar, or:
//   curl -s -X POST http://127.0.0.1:3099 -H 'content-type: application/json' -d '{"mode":"batch"}'
//
// This Mac has no FPGA, so the default board is the software copy (fakeboard).
// On the board PC: DEMO_BOARD=fpga bun run demo
// Dataset: HUTD_DATA, else the judges' test/, else the newest mock_test folder, else full_week, in the reference
// repo next to this checkout or in %USERPROFILE%\hackutd\zeroday. HUTD_DATA picks any folder (e.g. a mock_test).

import { spawn, type Subprocess } from "bun";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { basename, join, resolve } from "node:path";

type Mode = "stream" | "batch";

const root = resolve(import.meta.dir, "..");
const ml = join(root, "ml");
const jsonl = join(root, ".data", "live.jsonl");
const controlPort = 3099;
const apiPort = 3002;
const webPort = 3020;
const streamSeconds = Number(process.env.DEMO_STEP ?? "1") || 1;
// Batch pace in DATA packets/s (30 records each). Measured lossless: the software board ~300 (it is Python and drops
// its input above that), the FPGA ~1,000 (board suite T1, 30,240/30,240). Faster loses data and the story is wrong.
const batchPpsFor = (source: "fpga" | "fakeboard") => Number(process.env.DEMO_PPS ?? "") || (source === "fpga" ? 1000 : 300);

const children: Subprocess[] = [];
let replay: Subprocess | null = null;
let generation = 0;
let mode: Mode = process.argv.includes("batch") ? "batch" : "stream";
let replayState = { running: false, startedAt: null as string | null, endedAt: null as string | null, exitCode: null as number | null };
let switching = false;
let stopping = false;

function ipv4(name: string): string | null {
  for (const net of networkInterfaces()[name] ?? []) {
    if (net.family === "IPv4" && !net.internal) return net.address;
  }
  return null;
}

function datasetFolder(): string {
  const env = process.env.HUTD_DATA;
  if (env && existsSync(join(env, "telemetry.csv"))) return env;
  // The reference repo next to this checkout, or where the board PC keeps it (%USERPROFILE%\hackutd\zeroday).
  const repos = [join(resolve(root, ".."), "HackUTD-ZeroDay"), join(homedir(), "hackutd", "zeroday")].filter((r) => existsSync(r));
  // The judges' test/ folder wins as soon as it exists; then the newest mock_test; then the full practice week.
  for (const repo of repos) if (existsSync(join(repo, "test", "telemetry.csv"))) return join(repo, "test");
  for (const repo of repos) {
    const history = join(repo, "history");
    const mocks = existsSync(history) ? readdirSync(history).filter((name) => name.startsWith("mock_test_") && existsSync(join(history, name, "telemetry.csv"))).sort() : [];
    if (mocks.length) return join(history, mocks.at(-1)!);
  }
  for (const repo of repos) if (existsSync(join(repo, "history", "full_week", "telemetry.csv"))) return join(repo, "history", "full_week");
  throw new Error("No dataset. Set HUTD_DATA to a folder with network.json, ops.json and telemetry.csv.");
}

function boardAddress(): { board: string; local: string; source: "fpga" | "fakeboard" } {
  if (process.env.DEMO_BOARD === "fpga") {
    // The board always answers to 192.168.1.50 (the PC's wired address, ML-6); en0/en1 are macOS names only.
    const local = process.env.DEMO_LOCAL ?? "192.168.1.50";
    return { board: process.env.DEMO_FPGA ?? "192.168.1.10", local, source: "fpga" };
  }
  // Software board: a second loopback address on Linux/Windows; on macOS (only 127.0.0.1 is up) the Wi-Fi address.
  const board = process.platform === "darwin" ? ipv4("en0") ?? ipv4("en1") : "127.0.0.2";
  if (!board) throw new Error("No network address for the software board. Connect Wi-Fi, or set DEMO_BOARD=fpga on the board PC.");
  return { board, local: "127.0.0.1", source: "fakeboard" };
}

function python(): string {
  return process.env.HUTD_PY || (process.platform === "win32" ? "python" : "python3");
}

function track(child: Subprocess): Subprocess {
  children.push(child);
  return child;
}

function startReplay(next: Mode, link: { board: string; local: string; source: "fpga" | "fakeboard" }): Subprocess {
  const pace = next === "stream" ? ["--step-seconds", String(streamSeconds)] : ["--step-seconds", "0", "--pps", String(batchPpsFor(link.source))];
  return track(spawn([
    python(), "-m", "hutd_ml.replay",
    "--data", dataset,
    "--board", link.board,
    "--local", link.local,
    "--weights", "artifacts/v4/weights.bin",
    "--weights-version", "4",
    "--config", "artifacts/v4/global_config.json",
    ...pace,
  ], { cwd: ml, stdout: "inherit", stderr: "inherit" }));
}

async function stopReplay() {
  const child = replay;
  replay = null;
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([child.exited, Bun.sleep(2000)]);
  if (child.exitCode === null) child.kill(9);
}

async function setMode(next: Mode) {
  if (switching || stopping) return;
  switching = true;
  const gen = ++generation;
  try {
    await stopReplay();
    if (gen !== generation || stopping) return;
    writeFileSync(jsonl, "");
    mode = next;
    const child = startReplay(next, link);
    replay = child;
    replayState = { running: true, startedAt: new Date().toISOString(), endedAt: null, exitCode: null };
    void child.exited.then((code) => {
      if (replay !== child) return;
      replayState = { ...replayState, running: false, endedAt: new Date().toISOString(), exitCode: code };
    });
  } finally {
    switching = false;
  }
}

function status() {
  return {
    available: true,
    mode,
    dataset: basename(dataset),
    source: link.source,
    pace: mode === "stream" ? `${streamSeconds}s per reading` : `${batchPpsFor(link.source)} packets/s`,
    replay: replayState,
  };
}

const dataset = datasetFolder();
const link = boardAddress();
mkdirSync(join(root, ".data"), { recursive: true });
writeFileSync(jsonl, "");

if (link.source === "fakeboard") {
  track(spawn([python(), "-m", "hutd_ml.fakeboard", "--bind", link.board, "--pc", link.local], { cwd: ml, stdout: "inherit", stderr: "inherit" }));
}
track(spawn([
  python(), "-m", "hutd_ml.listen",
  "--data", dataset,
  "--board", link.board,
  "--local", link.local,
  "--model", "artifacts/v4",
  "--source", link.source,
  "--jsonl", jsonl,
  "--quiet",
], { cwd: ml, stdout: "inherit", stderr: "inherit" }));

const apiEnv = {
  ...process.env,
  STORAGE_MODE: "memory",
  ALLOW_INSECURE_LOCAL: "1",
  HOSTNAME: "127.0.0.1",
  API_HOST: "127.0.0.1",
  API_PORT: String(apiPort),
  DATA_ROOT: dataset,
  BOARD_JSONL: jsonl,
  BOARD_SOURCE: link.source,
  ALLOWED_ORIGINS: `http://127.0.0.1:${webPort},http://localhost:${webPort}`,
};
track(spawn(["bun", "apps/api/src/index.ts"], { cwd: root, env: apiEnv, stdout: "inherit", stderr: "inherit" }));
track(spawn(["bun", "run", "dev", "--", "--hostname", "127.0.0.1", "--port", String(webPort)], {
  cwd: join(root, "frontend"),
  env: { ...process.env, API_URL: `http://127.0.0.1:${apiPort}`, ALLOW_INSECURE_LOCAL: "1", HOSTNAME: "127.0.0.1" },
  stdout: "inherit",
  stderr: "inherit",
}));

Bun.serve({
  hostname: "127.0.0.1",
  port: controlPort,
  async fetch(req) {
    if (req.method === "GET") return Response.json(status());
    if (req.method !== "POST") return new Response("Not found", { status: 404 });
    const body = await req.json().catch(() => null) as { mode?: string } | null;
    if (body?.mode !== "stream" && body?.mode !== "batch") {
      return Response.json({ error: "mode must be stream or batch" }, { status: 400 });
    }
    await setMode(body.mode);
    return Response.json(status());
  },
});

await Bun.sleep(800);
await setMode(mode);

console.log(`Demo ready — ${mode === "stream" ? "streaming one reading a second" : "batching the whole dataset"}.`);
console.log(`Console  http://127.0.0.1:${webPort}`);
console.log(`Dataset  ${dataset}`);
console.log(`Board    ${link.source === "fpga" ? link.board : `software copy on ${link.board}`}`);

async function shutdown() {
  if (stopping) return;
  stopping = true;
  generation++;
  for (const child of children) {
    if (child.exitCode === null) child.kill();
  }
  await Promise.race([Promise.all(children.map((child) => child.exited)), Bun.sleep(1500)]);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
