# Questions from the ML side for the FPGA team

The ML side doesn't commit to branch `FPGA`. Rows are numbered **ML-n** so they don't collide with
`FPGA/TASKS.md` "Spec questions". **All thirteen are answered** (Lucas, Sun 02:10; FPGA spec questions 38, 67–70).

**Status:** `features_int.py` and `FPGA/model/eog_ref.py` (FPGA `10be393`, spec v4 + R7 option C) agree **bit for
bit** (every RESULT and ALERT) on these sets:

- v4 G0, G2 (41 records, including the R7 sequence) and G1 (30,240 records, 71 alerts);
- earlier, at `f264be2`: v2 G1 (130 alerts), v3 G1 (100 alerts), v3 G2, v0 G2.

The FPGA side's `check_mudit.py` passes on all 8 golden sets (FPGA TASKS T0.2c, T0.5).

Command: `python -m hutd_ml.xcheck` or `python -m hutd_ml.fpga_sync`.

## Spec / vectors

| # | Module | Question | ML-side answer | Status |
| --- | --- | --- | --- | --- |
| ML-1 | validate | `PUMP_INCONS` / `WELL_INCONS` on INVALID records | Only on VALID / HELD records, on effective values; 0 on INVALID | **Settled** (FPGA #38) |
| ML-2 | validate | `HOLD_MAX` > 2, `CD_LOG2` ≠ 4 | `features_int.py` mirrors the RTL: `hold = min(HOLD_MAX, 2)`; it asserts `CD_LOG2 == 4`. The ingest always writes 2 and 4. | **Confirmed** |
| ML-3 | top / vectors | `HB_TIMEOUT_MS` in the golden GLOBAL | Golden sets carry `HB_TIMEOUT_MS = 0` since ml `d1ba779` (numerics v4 §9). RESULT bytes are unchanged, only `global_config.bin` differs. Please make T2.top / `check_mudit.py` use golden sets from `d1ba779` or later. | **Confirmed** |
| ML-4 | top / board | Which weights for the board and the demo | **v4** (`ml/artifacts/v4`, `weights_ver` 4, CRC32 `0x3A17A6A0`, `persist_K4` [2,4,1,1], `logit_thr` [−128,−64,0,0], `gap_thr` 504): retrained after R7 C with missing-data augmentation. v3 stays as the fallback. RTL verification can stay on v2 golden sets; v3 and v4 sets exist too. | **Answered** (Lucas asked for the post-R7 C version) |

## Integration: ARM app (T2.ps1) and the board run: answers (FPGA spec questions 67–70)

| # | Question | Answer (Lucas, Sun 02:10) |
| --- | --- | --- |
| ML-5 | Where do CONFIG_ACK / WEIGHTS_ACK go? | **The sender's IP and port.** |
| ML-6 | Where do RESULT / STATS / ALERT go? | **Fixed: 192.168.1.50:7001 (RESULT, STATS) and :7002 (ALERT)**, so buffered results still have a destination after an outage. `listen.py` must run on that PC. |
| ML-7 | HEARTBEAT from any source port? | **Yes.** |
| ML-8 | WEIGHTS COMMIT layout | **Exactly as A16:** offset = blob length, length 0, flags 1, then u32 total length + u32 CRC32. Version from header `aux` → window word 70. ACK statuses: 0 OK, 1 CRC, 2 length, 3 self-test, 4 swapped. |
| ML-9 | Blob checks | **Status 3** on `blob_format ≠ 1`, `n_heads ≠ 4`, `n_features ≠ 31`, `feature_set_id ≠ 1` or a failed self-test; a CRC failure stays status 1. |
| ML-10 | WEIGHTS while DATA streams | **Yes:** the inactive bank is written, then swapped at a record boundary. |
| ML-11 | CONFIG re-sent mid-run | **Same result, done by the ARM in steps:** disable the slot, rewrite it, re-enable it (that slot's history restarts; latches and `result_no` continue). A GLOBAL re-send pauses the stream, writes it and resumes. |
| ML-12 | R7 | **Option C** (FPGA spec question 70): implemented at ml `59f3746`. |
| ML-13 | Python on the demo PC | **Yes:** Anaconda, Python 3.13, numpy 2.1.3, pandas 2.2.3. Run `replay.py` / `listen.py` from the Anaconda Prompt. |

## FPGA spec questions that asked something of the ML side

| FPGA # | Ruling | ML side |
| --- | --- | --- |
| 46 | `S_OUT = 0`: no rounding constant, no shift | `features_int.round_shift`; `quantize()` still never emits 0. Test `test_fpga_rulings_46_48_75`. |
| 48 | `N_WELLS` > 8 clamps to 8 (#14) | The engine clamps; the ingest still refuses > 8. |
| 71 | `FIELD_HELD` = 0 on a hold-limit record | Already so in T0.5 (`59f3746`). |
| 74 | ALERT SOURCE bit 3 on ARM-replayed alerts | The fakeboard sets it on alerts buffered while AUTONOMOUS. |
| 75 | Bad blob header → WEIGHTS_ACK status 3 | The fakeboard answers status 3 instead of raising. |
| 93 | `FEAT[0..11]` = 0 on records that update no slot | Already so in `features_int.py`. |

None of these changed a golden byte.

Exact per-bit set rules and per-status RESULT fields are in `ml/README.md` → "RESULT semantics" (ruling #23).
