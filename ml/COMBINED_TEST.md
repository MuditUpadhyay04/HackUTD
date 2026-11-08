# Combined test: v4 on the FPGA → board results → API incidents → Nemotron agents

**For Lucas's Claude.** Read this file, then run the steps in order and report the results. Background:
`global_plan.md` (the single source of truth); the plan for this test, `docs/plan/mudit/nemotron_v4_fpga_test.md`;
the board procedure, `ml/BOARD_CHECKLIST.md`.

## What this proves

The board runs weights v4 and streams results. Those results become the incidents the Nemotron agents investigate;
the agents' explanations and handoff are checked by deterministic validators; nothing reaches the operator unchecked.
One command checks every link:

```text
dataset → replay.py → Eclypse Z7 (v4) → listen.py → board JSON → API run (incidents from the board)
        → orchestrator → Nemotron sub-agents → validators → handoff for the operator
```

## Rules for this session

- **The FPGA is the fixed point.** Don't edit RTL, the spec, the ARM app or Lucas's live FPGA doc. If something on the
  board looks wrong, write it down and tell Lucas; he decides.
- **No secrets anywhere in the repo, logs or chat.** The Nemotron key lives only in the repo-root `.env`, which git
  ignores. Mudit or Jason gives it to Lucas directly.
- **Don't run B4 / `--heartbeat-test`** or a server-down drill: that's a known board issue (`global_plan.md` O16).
- **Never read `answer_key.json`.** Nothing in these steps needs it.
- Report what was measured, exactly. No estimates presented as results (hard rule 10).

## 0. Set-up (once)

From the repo root, on the board PC (192.168.1.50 on the direct cable to the board at 192.168.1.10; Wi-Fi for the
internet, which Nemotron needs):

```bash
git fetch origin && git checkout main && git pull
```

You need the **whole repo** at `main` `752c071` or later, not just the `ml/` folder: the agents live in `apps/api/`.

```bash
python -c "import numpy, pandas; print(numpy.__version__, pandas.__version__)"
```

```bash
powershell -c "irm bun.sh/install.ps1 | iex"
```

```bash
bun install
```

Create `.env` in the repo root (never commit it):

```text
NVIDIA_BASE_URL=https://hackutd-26-llm.jasonaa.me/v1
NEMOTRON_MODEL=nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4
NVIDIA_API_KEY=<from Mudit or Jason>
```

Check Nemotron (expect HTTP 200 and the model name; a non-browser User-Agent is required by Cloudflare):

```bash
curl -A hutd-check -H "Authorization: Bearer <key>" https://hackutd-26-llm.jasonaa.me/v1/models
```

If `bun install` fails on Windows (the native `libfx` package supports macOS / Linux only), skip to **3b**.

`--reset-cmd` below: use the same re-program command as for the board suite. On `main` there is no `FPGA/deploy`, so point it at the FPGA checkout's `deploy\win_deploy_eog.bat`.

## 1. The gate: v4 board suite (passed on hardware, Sun 08:05)

From `ml/`:

```bash
python -m hutd_ml.board_suite --data <full_week> --reset-cmd "..\FPGA\deploy\win_deploy_eog.bat"
```

PASS: B1, B2, B3, B5, B6, L1, L2, L3 (4 folders). Details and fault finding: `ml/BOARD_CHECKLIST.md`. Stop here if
anything fails, and send `board_suite_*/report.md`.

## 2. The combined suite (board + agents, one command)

From `ml/`:

```bash
python -m hutd_ml.combined_suite --data <full_week> --reset-cmd "..\FPGA\deploy\win_deploy_eog.bat"
```

It takes about 6–10 min and writes `combined_suite_<time>/report.md`.

| Stage | What | PASS |
| --- | --- | --- |
| A L1 / A L3 | The demo path over the full week and the mock test, on a freshly programmed board | every RESULT and ALERT identical to the reference (30,240 + 24,405 results) |
| N1 × 4 | The agents at steps 1030, 1080 and the last step of the week, and at the mock test's "now" | the incidents are exactly what the board flags; the board facts equal the board JSON (source **fpga**, weights v4, not stale); an operator handoff exists |
| N2 | The API path the console uses: upload, a run at step 1030, `POST /runs/:id/agents` | the same, with incident provenance **fpga**; every accepted explanation presents the solver's recommended plan first |
| D1 | Stale drill: board results cut 1 h before a cutoff | every board fact is marked stale |

What a PASS looks like on the software board (Sun 07:50), for comparison:

| Stage | Result |
| --- | --- |
| Board stages | bit-exact |
| Step 1030 | 6 incidents: the 3 S2 pump failures, the S5 B leak, the S3 A and S4 C worn pumps |
| Step 1080 | 3 incidents: the leak and the two worn pumps |
| Last step | none: the orchestrator writes "No ongoing incidents", with no model call |
| Mock test | the 2 S5 pump failures |
| Stale drill | 15/15 board facts stale |

Nemotron's acceptance varies from run to run. The report prints, per stage, how many sub-agent outputs the validators
accepted. When the triage or handoff output never passes, the orchestrator writes it from the facts (a
"deterministic fallback", named in the report), so the operator never gets a blank. That still PASSes; add
`--strict-agents` to require Nemotron for everything.

## 3. If something goes wrong

| Symptom | Do |
| --- | --- |
| A L1 / A L3 fail | It's the board: fix as in `ml/BOARD_CHECKLIST.md` §3; don't continue to the agents |
| `agent-run.ts exit 1` | Look at the stage's `.log`. Usually the key: check `.env` and the curl in §0 |
| N1 "incidents differ from the board" | Send the report and the stage's `N1_*.json`: a real bug on the API side (Mudit / Jason) |
| Board facts "source fakeboard" | `listen.py` labels by board address; for the real board it must be `fpga` (pass `--source fpga` if needed) |
| HTTP 429 or timeouts from Nemotron | Rate limit (10 requests/s, burst 20): rerun the failed stage with `--skip A,...` and `--board-jsonl` |
| After re-programming, no CONFIG_ACK | The link drops for a few seconds; the suite waits for ping, then 5 s |

**3b. Store and forward** (if Bun can't run on the board PC). The board suite's own L1 / L3 files work as they are:
`board_suite_*/L1_full_week.jsonl` and `board_suite_*/L3_mock_test_*.jsonl`. They lack the source label, but
`--source fpga` labels them. Or run only the board stage of the combined suite, then send the two board files to Mudit:

```bash
python -m hutd_ml.combined_suite --data <full_week> --reset-cmd "..\FPGA\deploy\win_deploy_eog.bat" --skip N1,N2,D1
```

Zip `combined_suite_*/L1_full_week.jsonl` and `combined_suite_*/L3_mock_test_*.jsonl` and send them to Mudit. Mudit
then runs the agent stages on them:

```bash
python -m hutd_ml.combined_suite --data <full_week> --board-jsonl L1_full_week.jsonl --heldout-jsonl L3_mock_test_2026-10-10T1530.jsonl --source fpga --skip A
```

## 4. Report back

Send `combined_suite_*/report.md` (and `board_suite_*/report.md`). Include the FPGA commit of the bitstream and ARM app,
the clock (50 MHz), and anything that looked off. Mudit records the result in
`docs/plan/mudit/nemotron_v4_fpga_test.md` §5 and `global_plan.md`.

## After it passes (for Lucas and Mudit)

- **Live demo set-up**, with everything on the board PC: `docs/plan/mudit/nemotron_v4_fpga_test.md` step 6.
  - `listen.py --source fpga --jsonl live.jsonl --post http://127.0.0.1:3000/api/ingest`;
  - the API with `BOARD_JSONL=live.jsonl BOARD_SOURCE=fpga`;
  - the console with `BOARD_INGEST=1`;
  - `replay.py` with v4.
- **Live weight swap during the demo:** `replay.py … --swap-at-step N --swap-weights artifacts/v4/weights.bin --swap-version 4 --swap-config artifacts/v4/global_config.json`.
