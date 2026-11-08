# Questions from the ML side for the FPGA team

The ML side doesn't commit to branch `FPGA`. Rows are numbered **ML-n** so they don't collide with
`FPGA/TASKS.md` "Spec questions". Paste the open ones there. State as of FPGA `f264be2`, Sun Nov 8 ~01:55 CST.

**Status:** `features_int.py` and the v4 `FPGA/model/eog_ref.py` now agree **bit for bit** (every RESULT and ALERT)
on these sets:

- v2 G1 (30,240 records, 130 alerts);
- v3 G1 (100 alerts);
- v3 G2 and v0 G2 (edge cases).

Command: `python -m hutd_ml.xcheck` or `python -m hutd_ml.fpga_sync`.

## Spec / vectors

| # | Module | Question | ML-side answer | Status |
| --- | --- | --- | --- | --- |
| ML-1 | validate | `PUMP_INCONS` / `WELL_INCONS` on INVALID records | Only on VALID / HELD records, on effective values; 0 on INVALID | **Settled** by FPGA #38 |
| ML-2 | validate | `HOLD_MAX` > 2, `CD_LOG2` ≠ 4 | `features_int.py` mirrors the RTL: `hold = min(HOLD_MAX, 2)`; it asserts `CD_LOG2 == 4`. The ingest always writes 2 and 4. | FYI |
| ML-3 | top / vectors | `HB_TIMEOUT_MS` in the golden GLOBAL | Golden sets carry `HB_TIMEOUT_MS = 0` since ml `d1ba779` (numerics v4 §9). RESULT bytes are unchanged, only `global_config.bin` differs. Please make T2.top / `check_mudit.py` use golden sets from `d1ba779` or later. | **Please confirm** |
| ML-4 | top / board | Which weights for the board and the demo | **v3** (`ml/artifacts/v3`, `weights_ver` 3, `persist_K4` [1,3,1,1], `logit_thr` [−64,0,0,0], `gap_thr` 504). RTL verification can stay on v2 golden sets; v3 sets exist too. | FYI |

## Integration: ARM app (T2.ps1) and the board run (T2.board1)

The ML tools (`replay.py`, `board.py`, `listen.py`) assume the following. Each needs a yes or a correction.

| # | Question | What the ML tools do / assume |
| --- | --- | --- |
| ML-5 | Where do CONFIG_ACK and WEIGHTS_ACK go? | To the **sender's IP and port**. `replay.py` / `board.py` send CONFIG from local port 7003 and WEIGHTS from 7004, and wait for the ACK there. |
| ML-6 | Where do RESULT / STATS (7001) and ALERT (7002) go? | To 192.168.1.50 (the PC on the direct cable), ports 7001 / 7002. `listen.py` binds both there. Is the destination fixed, or "whoever sent the last DATA / HEARTBEAT"? |
| ML-7 | HEARTBEAT from a different process / port than DATA | `listen.py` sends HEARTBEAT (type 9, count 0) to board:7003 from an **ephemeral** port while `replay.py` sends DATA. The ARM should accept heartbeats from any source port. |
| ML-8 | WEIGHTS COMMIT layout (A16) | Data chunk: `offset u32, length u16, flags u16 = 0, bytes`. COMMIT: `offset = blob length, length = 0, flags = 1`, then `u32 total length, u32 CRC32` (zlib / IEEE). The version comes from header `aux` → window word 70 (D11). WEIGHTS_ACK statuses: 0 OK, 1 CRC, 2 length, 3 self-test, 4 swapped. |
| ML-9 | What the ARM checks before swapping | The ML side expects a refusal (WEIGHTS_ACK status 3) on `blob_format ≠ 1`, `n_heads ≠ 4`, `n_features ≠ 31`, `feature_set_id ≠ 1` or a failed self-test vector. |
| ML-10 | WEIGHTS while DATA is streaming | The live-swap demo (`replay.py --swap-at-step`) sends WEIGHTS on 7004 mid-stream; the swap lands at a record boundary (spec). Please confirm the ARM handles 7004 while 7000 is busy. |
| ML-11 | CONFIG re-sent mid-run (a demo restart) | Per spec: a Facility CONFIG write makes that slot's next record a new history, the latches survive, and `result_no` continues. The ML stand-in now does the same (ml commit after `d1ba779`). |
| ML-12 | R7 (hold/reset policy) deadline | A change costs the ML side ~5 min (retrain + golden sets). Can it be decided before T2.top runs on the full week? Otherwise A6 stays for the demo. |
| ML-13 | Python on the demo PC | `replay.py` and `listen.py` need Python 3.10+, `numpy`, `pandas` (`ml/requirements.txt`). Is that available on Lucas's PC, next to the Vitis tools? |

Exact per-bit set rules and per-status RESULT fields are in `ml/README.md` → "RESULT semantics" (ruling #23).
