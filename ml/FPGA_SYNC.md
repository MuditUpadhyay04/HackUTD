# Sync log with branch FPGA

Written by `python -m hutd_ml.fpga_sync --record`.

| When (UTC) | FPGA commit | Spec | New / changed spec questions | xcheck (ours vs eog_ref) |
| --- | --- | --- | --- | --- |
| 2026-11-08T07:26Z | `b27441a` | v4 | 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25 | g0 as-is: ERROR (eog_ref crashed); g0 pre-v4 layout: ERROR (eog_ref crashed); g2 as-is: ERROR (eog_ref crashed); g2 pre-v4 layout: ERROR (eog_ref crashed) |
| 2026-11-08T07:45Z | `f264be2` | v4 | 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44 | g0 as-is: PASS; g0 pre-v4 layout: DIFF; g2 as-is: PASS; g2 pre-v4 layout: DIFF |
| 2026-11-08T07:50Z | `f264be2` | v4 | — | full week vs v4 eog_ref: v2 G1 PASS (130 alerts), v3 G1 PASS (100 alerts), v3 G2 PASS, v0 G2 PASS |
