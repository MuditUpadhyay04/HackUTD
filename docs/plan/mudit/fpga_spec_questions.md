# Questions from the ML side for the FPGA team

The ML side doesn't commit to branch `FPGA`. Rows are numbered **ML-n** so they don't collide with
`FPGA/TASKS.md` "Spec questions". **All thirteen are answered** (Lucas, Sun 02:10; FPGA spec questions 38, 67–70).

**Status:** `features_int.py` and the v4 `FPGA/model/eog_ref.py` now agree **bit for bit** (every RESULT and ALERT)
on these sets:

- v2 G1 (30,240 records, 130 alerts);
- v3 G1 (100 alerts);
- v3 G2 and v0 G2 (edge cases).

Command: `python -m hutd_ml.xcheck` or `python -m hutd_ml.fpga_sync`.

## Spec / vectors

| # | Module | Question | ML-side answer | Status |
| --- | --- | --- | --- | --- |
| ML-1 | validate | `PUMP_INCONS` / `WELL_INCONS` on INVALID records | Only on VALID / HELD records, on effective values; 0 on INVALID | **Settled** (FPGA #38) |
| ML-2 | validate | `HOLD_MAX` > 2, `CD_LOG2` ≠ 4 | `features_int.py` mirrors the RTL: `hold = min(HOLD_MAX, 2)`; it asserts `CD_LOG2 == 4`. The ingest always writes 2 and 4. | **Confirmed** |
| ML-3 | top / vectors | `HB_TIMEOUT_MS` in the golden GLOBAL | Golden sets carry `HB_TIMEOUT_MS = 0` since ml `d1ba779` (numerics v4 §9). RESULT bytes are unchanged, only `global_config.bin` differs. Please make T2.top / `check_mudit.py` use golden sets from `d1ba779` or later. | **Confirmed** |
| ML-4 | top / board | Which weights for the board and the demo | **v3** (`ml/artifacts/v3`, `weights_ver` 3, `persist_K4` [1,3,1,1], `logit_thr` [−64,0,0,0], `gap_thr` 504). RTL verification can stay on v2 golden sets; v3 sets exist too. | **Noted** (Lucas: send whichever version is retrained after R7 C) |

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

Exact per-bit set rules and per-status RESULT fields are in `ml/README.md` → "RESULT semantics" (ruling #23).
