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

On Lucas's laptop (`FPGA/docs/BOARD_SESSION.md`), the Linux shell can't run Windows tools, so everything runs by
**double-clicking a `.bat`** and reading its log. Wi-Fi gives the internet (Nemotron needs it); the direct cable gives
the board (PC 192.168.1.50, board 192.168.1.10).

1. **Get the whole repo at `main`**, not just `ml/`: the agents live in `apps/api/`. For example, download the ZIP of
   `main` from GitHub and unpack it to `C:\Users\lqi20\hackutd\main_<commit>` (the same plain-snapshot habit as
   `ml_main_846463e`). The FPGA checkout stays where it is; the scripts re-program the board with its
   `FPGA\deploy\win_deploy_eog.bat`.
2. **Create `.env`** in the snapshot's root (never commit it; Mudit or Jason gives the key directly):

   ```text
   NVIDIA_BASE_URL=https://hackutd-26-llm.jasonaa.me/v1
   NEMOTRON_MODEL=nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4
   NVIDIA_API_KEY=<from Mudit or Jason>
   ```

3. **Double-click `ml\win_agents_setup.bat`.** It installs Bun if needed, runs `bun install` and asks Nemotron for its
   model list. Read `ml\agents_setup.log`: it ends `OK: setup done` and shows the model name. It never prints the key.

If `bun install` fails on Windows (the native `libfx` package supports macOS / Linux only), use **3b** (store and
forward) instead.

| Setting | Default in the `.bat` files | Override |
| --- | --- | --- |
| Python | `%USERPROFILE%\anaconda3\python.exe` | — |
| Practice data | `%USERPROFILE%\hackutd\zeroday\history\full_week` | `HUTD_DATA` |
| FPGA checkout (for the re-program script) | `%USERPROFILE%\OneDrive\Documents\GitHub\HackUTD\FPGA` | `HUTD_FPGA` |

With a Unix-like shell and a git checkout instead, the same steps are `git checkout main && git pull`, `bun install`,
the `.env` above, and `curl -A hutd-check -H "Authorization: Bearer <key>" <NVIDIA_BASE_URL>/models` (Cloudflare needs a
non-browser User-Agent).

## 1. The gate: v4 board suite (passed on hardware, Sun 08:05)

Already done (12/12 PASS, `FPGA/reports/board_suite_v4_20261108.md`). Rerun only if the bitstream or ARM app changed:
double-click `FPGA\deploy\win_board_suite.bat` in the FPGA checkout, or from `ml/`:

```bash
python -m hutd_ml.board_suite --data <full_week> --reset-cmd "<FPGA checkout>\deploy\win_deploy_eog.bat"
```

PASS: B1, B2, B3, B5, B6, L1, L2, L3 (4 folders). Details and fault finding: `ml/BOARD_CHECKLIST.md`. Stop here if
anything fails, and send `board_suite_*/report.md`.

## 2. The combined suite (board + agents, one command)

**Double-click `ml\win_combined_suite.bat`** in the snapshot. It takes about 6–10 min and writes
`ml\combined_suite_<time>\report.md` (copied to `ml\combined_suite_report.md`) and the console output to
`ml\combined_suite.log`. The command it runs, from `ml/`:

```bash
python -m hutd_ml.combined_suite --data <full_week> --reset-cmd "<FPGA checkout>\deploy\win_deploy_eog.bat"
```

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
`--source fpga` labels them. Or run only the board stage of the combined suite (needs no Bun): **double-click
`ml\win_combined_suite_board.bat`**, which runs

```bash
python -m hutd_ml.combined_suite --data <full_week> --reset-cmd "<FPGA checkout>\deploy\win_deploy_eog.bat" --skip N1,N2,D1
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

- **Judging day** (the judges' `test/` folder, an unseen S6–S11 network): `docs/plan/mudit/judging_day.md`. Rehearse
  first on an unseen network made from the practice week: `python -m hutd_ml.unseen`, then this suite with `--data` on it.
- **Live demo set-up**, with everything on the board PC: `docs/plan/mudit/nemotron_v4_fpga_test.md` step 6.
  - `listen.py --source fpga --jsonl live.jsonl --post http://127.0.0.1:3000/api/ingest`;
  - the API with `BOARD_JSONL=live.jsonl BOARD_SOURCE=fpga`;
  - the console with `BOARD_INGEST=1`;
  - `replay.py` with v4.
- **Live weight swap during the demo:** `replay.py … --swap-at-step N --swap-weights artifacts/v4/weights.bin --swap-version 4 --swap-config artifacts/v4/global_config.json`.
