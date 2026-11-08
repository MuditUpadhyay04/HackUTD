# Spec questions from the ML side, for `FPGA/TASKS.md` "Spec questions"

The ML side doesn't commit to branch `FPGA`. These rows are ready to paste into that table, numbered after 25.
Each one names where `ml/hutd_ml/features_int.py` (the normative reference since spec v4) differs from or adds to
the text.

| # | Module | Question | Proposed answer | Raised by | Answer (lead) |
| --- | --- | --- | --- | --- | --- |
| 26 | validate | `PUMP_INCONS` / `WELL_INCONS` on INVALID records. Q12 computes them "when the inputs are OK" without restricting the status. | `features_int.py` sets bits 6 / 7 **only on VALID / HELD** records, on effective (observed or held) values. On INVALID records they are 0. | Mudit (v4 re-diff, Sun 01:30) | |
| 27 | validate | `HOLD_MAX` > 2 and `CD_LOG2` ≠ 4 | `features_int.py` now mirrors the RTL: `hold = min(HOLD_MAX, 2)` and asserts `CD_LOG2 == 4`. The ingest always writes 2 and 4. FYI, no RTL change. | Mudit | |
| 28 | top / vectors | `HB_TIMEOUT_MS` in the golden GLOBAL | Golden sets G0 / G1 / G2 now carry `HB_TIMEOUT_MS = 0` (numerics v4 §9), so SOURCE bit 2 is always 0. Regenerated at ml commit after 8e67750; RESULT bytes are unchanged, only `global_config.bin` changed. Deployment configs (`replay.py`) still send 5000. | Mudit | |

Exact per-bit set rules and per-status RESULT fields are in `ml/README.md` → "RESULT semantics" (ruling 23).
