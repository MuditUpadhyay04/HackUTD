# Judging day: the judges' `test/` folder through the board, the console and the agents

The organizers add `test/` to their repo right before judging: "a week from a different network (S6 to S11) you have
never seen", three files, no answer key (reference `README.md`). This page is the procedure, with what has been checked.

## What has been rehearsed (Sun Nov 8, cloud session, software board + live Nemotron)

`python -m hutd_ml.unseen` reshapes the practice week into a network nobody has seen. It keeps the physics: inflow is
still the sum of the wells (within 0.4 bpd), and the grid is 5 minutes. It changes:

- the names: systems S6–S11, facilities as letters or words (NORTH, EAST, …);
- the shape: 24 or 30 facilities, 2–5 wells, new sizes and disposal pressures;
- the time: another week, starting off the hour;
- the ops: new prices and fleets.

It also writes a mock-test cut. Results on that network:

| Check | Result |
| --- | --- |
| Board stages: `replay.py` → board → `listen.py` (24 facilities) | 48,384 / 48,384 RESULTs and 130 / 130 ALERTs identical to the offline engine; mock cut also identical |
| v4 detections vs. the synthetic answer key (offline scoring, `unseen --score`) | 39 / 39 events found (10 leaks, 8 worn pumps, 21 failures); delays and false episodes the same as on the practice week (2 false worn-pump episodes on both) |
| Agents at 4 cutoffs + API path + stale drill (`combined_suite`) | 8 / 8 PASS: incidents = what the board flags (10 at step 1030), board facts fresh, handoff never blank |
| Console with `DATA_ROOT` and board results | `test` picked by default; S6–S11 named right; 5 pumps down across 4 systems with countdowns and the shared-fleet plans; leaks and worn pumps as inspections |
| 30-facility network (53 MB) | imports (was refused at 40 MB before this fix) |

Not proven: new failure physics. The unseen network reuses the practice week's event signatures. On the practice week
itself, leave-one-system-out validation (`ml/hutd_ml/train.py`) is the evidence that v4 generalizes across systems.

## Before judging (once)

1. On the board PC, with Wi-Fi up:
   - a full snapshot of `main`, with the Nemotron key in `.env` at its root;
   - `ml\win_agents_setup.bat` run once.
2. Rehearse on an unseen network (about 15 min). From `ml/`:

   ```bash
   python -m hutd_ml.unseen --src <zeroday>\history\full_week --out <zeroday>\rehearsal
   ```

   ```bash
   python -m hutd_ml.combined_suite --data <zeroday>\rehearsal\full_week --reset-cmd "<FPGA checkout>\deploy\win_deploy_eog.bat"
   ```

   This is the real board on a network it hasn't seen. Expect every stage PASS.
3. Board temperature: double-click `ml\win_board_temp.bat`; it reads the Zynq die temperature over JTAG and is
   read-only. Watch the peak during the rehearsal.

## When `test/` appears

1. `git pull` in the reference repo clone (`%USERPROFILE%\hackutd\zeroday`), so `test\` sits next to `history\`.
2. Check the limits:
   - **The board:** at most 32 facilities and 8 wells per facility. `replay.py` says why if not. In that case run
     without the board: the console's software runtime still detects pump failures and plans trucks, and it says
     leak and worn-pump checks need the board.
   - **The API:** up to 160 MB / 2.5 M rows of telemetry.
3. Double-click `ml\win_demo.bat`. It opens four windows on `test\`:
   - the operator API, with `DATA_ROOT` = the reference repo, so every folder appears in the console's dataset menu;
   - the console;
   - `listen.py --source fpga`;
   - `replay.py` with weights v4.

   Then it opens http://127.0.0.1:3000. `REPLAY_STEP` (default 0.5 s per 5-minute step: a week in about 17 min) sets the pace. The script is
   not yet run on Windows: try it once on a practice folder first. The same by hand:
   `docs/plan/mudit/nemotron_v4_fpga_test.md` step 6.
4. In the console:
   - the dataset menu → `test`;
   - **Replay** → drag to any moment;
   - **Agents** runs the Nemotron sub-agents on the incidents the board flagged.

## Don'ts

- No server-down segment (B4, `global_plan.md` O16).
- Never load `answer_key.json`: the API reads only `network.json`, `ops.json` and `telemetry.csv` from each folder.
- No code changes between the rehearsal and `test/` (hard rule: data from the files, nothing hardcoded).
