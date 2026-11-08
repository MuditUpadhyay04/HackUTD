# Board checklist: does the hardware compute exactly what the software says?

For the board run (FPGA task T2.board1) and the first live run (`global_plan.md` §7). Each step gives a command, what
**PASS** looks like, and what it proves. Work top to bottom and stop at the first FAIL; section 3 says how to find the
culprit. Every command runs from `ml/` on the board PC.

The reference is normative (contract C6): `features_int.py` defines every RESULT and ALERT byte. A mismatch is a
hardware/software clash to fix unless Lucas rules the spec says otherwise.

## Where v4 is

`ml/artifacts/v4/` on `main`:

| File | Use |
| --- | --- |
| `weights.bin` | the 980 B blob that `replay.py` / `board.py` push over UDP 7004 (`weights_ver` 4, CRC32 `0x3A17A6A0`) |
| `weights.eog` | the same blob wrapped for the **SD card** (copy to the card root as `weights.eog`; made and checked with `FPGA/deploy/make_weights_sd.py`). `artifacts/v3/weights.eog` is the fallback |
| `global_config.json` | thresholds, per-class K, `gap_thr` (GLOBAL CONFIG is not on the card: the PC always sends it) |
| `weights.json` | float weights, calibration for `listen.py` |
| `golden/g0`, `g1`, `g2` | the golden sets below |

## One command: the whole suite

```bash
python -m hutd_ml.board_suite --data <full_week> --reset-cmd "..\FPGA\deploy\win_deploy_eog.bat"
```

It re-programs the board before every test (fresh latches) and waits for ping. Use `--prompt-reset` to reset by hand,
or `--fakeboard` to rehearse on the software board. It writes `board_suite_<time>/report.md` (send it to Mudit) and
exits 0 only if every test passed.

| Id | What | Checked against |
| --- | --- | --- |
| B1, B2, B3 | golden v4 g0 (+ 4 rejected blobs), g2, g1 | expected files, every RESULT field and ALERT |
| B5, B6 | golden v0 g0 + g2 (extreme untrained weights), v2 g1 (a second model) | expected files |
| L1 | **the demo path:** `replay.py` (v4) → board → `listen.py`, full week | an offline run of `features_int.py` on the same records: every RESULT field in the JSON, every `active` flag, every ALERT |
| L2 | live swap v3 → v4 at step 1029 with `--swap-config` | offline run swapping at the same step; one clean step boundary |
| L3 | every other dataset folder (`mock_test_*`, `snapshot_*`), live with v4 | offline run; a different "now" and length through the real encoder |
| B4 | `--with-b4`: heartbeat gap (known issue on the board, FPGA lead investigating) | expected files |
| T1 | `--throughput`: g1 unpaced; records/s, reported as a measurement | — |

Pick tests with `--only B3,L1` or `--skip B6`.

## 0. Already passing in software (re-run only if the code changed)

| Check | Command | Result (Sun Nov 8, 06:30 CST) |
| --- | --- | --- |
| ML tests | `HUTD_DATA=<full_week> python -m pytest -q tests` | 14 / 14 pass |
| Reference vs Lucas's model | `python -m hutd_ml.fpga_sync --golden artifacts/v4/golden --sets g0,g2,g1` | PASS at FPGA `3560bda` (every T1 module DONE), all 71 alerts |
| The whole suite on the software board | `python -m hutd_ml.board_suite --data <full_week> --fakeboard` | B1, B2, B3, B5, B6, L1, L2, L3 (4 folders): all PASS; every live RESULT and ALERT identical to the offline engine |

## 1. Pre-flight on the board PC (about 5 min): the usual clash sources

- [ ] The PC's wired address is **192.168.1.50**: the board always sends RESULT / STATS / ALERT there (ML-6). The board is
      192.168.1.10, and `ping 192.168.1.10` answers.
- [ ] Nothing else listens on UDP **7001–7004**. `board.py` binds all four itself. Run either `board.py` *or* the
      live pair `listen.py` + `replay.py`, never both. Windows: `netstat -ano | findstr :700`.
- [ ] The firewall lets Python (Anaconda) receive inbound UDP on 7001–7004.
- [ ] Python: Anaconda, `python -c "import numpy, pandas; print(numpy.__version__, pandas.__version__)"` shows numpy
      2.1.3 / pandas 2.2.3 or newer (ML-13).
- [ ] Repo at `main` (`git log -1`); `ml/artifacts/v4/golden/` holds g0, g2, g1.
- [ ] Write down the FPGA commit of the bitstream and ARM app (the one that passed T2.top).
- [ ] **Power-cycle or reset the board before each golden set** if you compare ALERTs. Alarm latches survive CONFIG
      writes on purpose, so a latch left over from the previous set suppresses a `*_RAISED`. Otherwise pass
      `--skip-alerts`.

## 2. Golden tests: byte for byte, in this order

`board.py` sends GLOBAL CONFIG → Facility CONFIG → WEIGHTS → DATA (with heartbeats), collects every RESULT and
ALERT, and compares them all with the expected files. It ends with `PASS` and exit code 0, or names the first
mismatching record and field. The captured output goes to `<set>/board_run/` (not committed).

| # | Command | PASS looks like | Proves |
| --- | --- | --- | --- |
| B1 | `python -m hutd_ml.board --golden artifacts/v4/golden/g0 --weights-negative` | 4 × `WEIGHTS negative (…) -> ok`; `WEIGHTS v4: swapped, active version 4`; RESULTs 30 / 30; PASS | UDP framing, CONFIG / WEIGHTS ACK routing, blob checks (CRC → 1, length → 2, header and self-test → 3, model unchanged), cold start, pump start |
| B2 | `python -m hutd_ml.board --golden artifacts/v4/golden/g2` | RESULTs 41 / 41; PASS | validation edge cases: duplicate, out of order, 1- and 3-step gaps, held fields, R7 option C (INVALID with no reset, then recovery), illegal enum, out of range, disabled slot, `fac_id` ≥ 32, framing |
| B3 | `python -m hutd_ml.board --golden artifacts/v4/golden/g1` | 30,240 / 30,240 RESULTs, every field; ALERTs 71 / 71; PASS | the whole week: 31 features, memory, 4 heads, rules, countdown, alarms and latches |
| B4 | `python -m hutd_ml.board --golden artifacts/v4/golden/g1 --heartbeat-test 6` | as B3, plus `N raised while AUTONOMOUS, N replayed` with N > 0 | server-down mode: buffering, replay, ALERT SOURCE bits 2 and 3 (#74) |
| B5 (optional) | `python -m hutd_ml.board --golden artifacts/v0/golden/g0`, then `g2` | PASS (1 alert each) | untrained full-range weights (`weights_ver` 240): head accumulator, saturation |
| B6 (optional) | `python -m hutd_ml.board --golden artifacts/v2/golden/g1` | PASS, 130 alerts | a second trained model; the set the RTL was verified against |

## 3. If a golden test fails: find the module

1. Rerun once with a lower `--pps` (for example 500). If the count of RESULTs changes, it's packet loss, not
   arithmetic: check the last STATS line (`data_seq_gaps`, `results_out`).
2. Diff with per-stage detail. G0 and G2 ship `expected_stages.csv`: validated values, all 31 features, logits,
   rules and countdown for every record.

   ```bash
   python -m hutd_ml.compare artifacts/v4/golden/g2/expected_results.bin artifacts/v4/golden/g2/board_run/actual_results.bin --stages artifacts/v4/golden/g2/expected_stages.csv
   ```

   For G1, regenerate the stages first:

   ```bash
   python -m hutd_ml.golden --data <full_week> --out g1_stages --set g1 --weights artifacts/v4/weights.bin --weights-version 4 --config artifacts/v4/global_config.json --stages
   ```

3. Map the first wrong field to a module:

   | First wrong field | Look at |
   | --- | --- |
   | `status`, `reason`, `since_reset` | validate (or unpack, for framing) |
   | a feature in the stages diff | features (0–11) or memory (12–30) |
   | `logits` with the features right | head: weight window, `S_OUT`, the version in word 70 |
   | `rules`, `countdown` | countdown |
   | ALERTs only | alarm: per-class K, gap rule, latches, ALERT order |
   | missing results, `result_no` jumps | pack / regs / ARM path, or UDP loss (step 1) |

4. Send Mudit the `board_run/` folder (`actual_results.bin`, `actual_alerts.json`, `stats.json`) plus the FPGA commit.

## 4. Live pipeline (after B3 passes)

Terminal 1, the receiver (on 192.168.1.50). It reads each result with the settings of the model that produced it:

```bash
python -m hutd_ml.listen --data <full_week> --model artifacts/v3 --model artifacts/v4 --jsonl live.jsonl --post <Jason's ingest URL>
```

Terminal 2, the sender. `replay.py` refuses to stream unless the board confirms the weights:

```bash
python -m hutd_ml.replay --data <full_week> --weights artifacts/v4/weights.bin --weights-version 4 --config artifacts/v4/global_config.json --step-seconds 0.05
```

| # | Check | PASS looks like |
| --- | --- | --- |
| L1 | Startup | `WEIGHTS v4: swapped, active version 4`; then a result for every facility at every step |
| L2 | Board alarms vs the JSON | each `*_raised` ALERT has a matching problem turning on in `active` at the same `ts_unix` |
| L3 | Server down (**skip for now:** it uses the same buffered-replay path as B4) | stop `listen.py` for about 10 s, then start it again: STATS `mode` goes AUTONOMOUS and back; buffered results arrive with no `result_no` gap |
| L4 | **Live weight swap** (the demo) | `replay.py … --weights artifacts/v3/weights.bin --weights-version 3 --config artifacts/v3/global_config.json --swap-at-step 1029 --swap-weights artifacts/v4/weights.bin --swap-version 4 --swap-config artifacts/v4/global_config.json`: `weights_ver` goes 3 → 4 at exactly one step boundary, the GLOBAL for v4 follows the swap, and no record shows `history_reset` at the swap |
| L5 | Judging folder (when `test/` appears) | `replay.py` on it unchanged; ≤ 32 facilities and ≤ 8 wells, or the encoder says why not |

Always pass `--swap-config` with a swap. Each model's thresholds and K were tuned for that model, and the GLOBAL
CONFIG carries them; a GLOBAL-only write restarts no history (FPGA question 69).

## 5. Not covered here

- Throughput and latency (FPGA task T3.perf). Make no claim without a measurement (hard rule 10).
- The server's events, plans and agent (Jason): they consume the JSON from section 4.

## Results log

| When | FPGA commit | Step | Result | Notes |
| --- | --- | --- | --- | --- |
| Sun 03:55 | software board | B1–B4, L4 | PASS | dress rehearsal |
| Sun ~04:40 | `eog/T2.bd1` @ `5aecbc2`, 50 MHz build | B1, B2, B3 | **PASS** | first hardware run (Lucas): 30,240 / 30,240 RESULTs bit-exact, 71 / 71 ALERTs, 4 bad blobs refused |
| Sun ~04:40 | same | B4 | FAIL (known issue) | 10 RESULTs corrupted only after a heartbeat gap; ALERTs 71 / 71. Not the RTL, per the FPGA lead (`FPGA/reports/LEAD_board_response.md`); under investigation |
| Sun 06:30 | software board | `board_suite` default set | PASS | B1–B3, B5, B6, L1, L2, L3 × 4 folders |
