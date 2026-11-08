# FPGA response to `ml/README.md` assumptions A1–A19

From: Lucas (FPGA). Date: Sun Nov 8, 00:45 CST. This is about `origin/ml` at `296dd48`.
The full spec is `FPGA/spec/` on branch `FPGA` (spec v4; the FPGA side had already used v2/v3 for internal port changes). The list of changes is `FPGA/spec/numerics.md` §11.

**Summary:** your `features_int.py` is now the normative integer reference for the RTL. The RTL is built to match it
bit for bit. Five assumptions change (A3, A8, A11, A13, A19). Everything else stands as you wrote it.

## Response per assumption

| # | Verdict | Notes |
| --- | --- | --- |
| A1 | **Agree, S changes** | Same formulas, with `S = 17` (see A3). Multipliers at S = 17 are 214,748, 1,431,656 and 4,294,967. All are < 2^32. |
| A2 | Agree | |
| A3 | **Change: `S_feat = 17`** | The RTL is built around a fixed S = 17: signed 20-bit × unsigned 32-bit multiplies (decision D3). Keep only the `M < 2^32` checks; the `< 2^24` bound for S = 11 goes away. Rounding stays `(raw·M + 2^(S−1)) >>> S`, arithmetic shift. |
| A4 | Agree | Timing rules, channel 11 and post-update memory are adopted as written (D7). |
| A5 | Agree | |
| A6 | Agree for now | Adopted as written (D7). See **R7** below: this rule may change. |
| A7 | Agree | |
| A8 | **Change: `review_r1r2` only** | Keep your prefilled 16-entry ring and `mean = sum >> 4` (D6; this replaces our older growing ring). The ring holds facility inflow, and a tripped tank (level ≥ shutdown) reports 0 for p10/p50/p90 (D1, D2). Please drop `plan_v1` or make it non-default. |
| A9 | Agree | With `review_r1r2`, the denominator is the inflow mean. |
| A10 | Agree | Strict `>`. INVALID clears the counters; DROPPED leaves them alone. |
| A11 | **Agree + CLEARED** | Latched as you have it. E-STOP also emits `CLEARED` (see A19). |
| A12 | Agree | Leaving "not filling" out of Night Shift is right. |
| A13 | **Change: DROPPED, not INVALID** | A non-zero reserved field → **DROPPED** with reason bit 12 `FRAMING` (D9). Check it **before** the facility lookup. `since_reset` = 0 in that RESULT. No state changes. |
| A14 | Agree | |
| A15 | Agree | |
| A16 | Agree | This is ARM software, not RTL. The ARM checks CRC32 and length before it writes the inactive weight bank. |
| A17 | Agree | |
| A18 | Agree | The FPGA weight window (`0x4000`–`0x4118`) is blob bytes 0–279 as 70 words, plus word 70 = version (D11). Bytes 0–279 include the header and the hash. Only the test vectors at bytes 280+ stay on the ARM side. |
| A19 | **Change: latched Night Shift** | Night Shift latches like E-STOP until acknowledged (D8). Details below. |

## A19 / A11 in detail (what `features_int.py` should do)

Per facility, keep `ns_cond`, `es_cond` (this record's condition) and `ns_latch`, `es_latch`:

- **VALID/HELD:** compute `ns_c` and `es_c` exactly as now. Then `cond = c`, `latch |= c`.
- **ALERT kinds:**
  - 1 `NS_RAISED`: `ns_c` and the old `ns_latch = 0`.
  - 2 `ES_RAISED`: `es_c` and the old `es_latch = 0`.
  - 3 `CLEARED`: the old `cond = 1`, the new `cond = 0`, the latch still set. One per latch type, with SOURCE bit 4 = type (0 Night Shift, 1 E-STOP).
- **INVALID:** persistence counters cleared; conditions and latches unchanged; **no ALERT**.
- **DROPPED:** nothing.
- `reset_history` **does not** clear the latches.
- Acknowledge (kind 4 `ACKED`, BTN0 or `CTRL.server_ack`) happens only in hardware. Don't model it. The golden sets
  never acknowledge.
- SOURCE bits: 0 = rules, 1 = class active, 2 = autonomous (generate goldens with `HB_TIMEOUT_MS = 0`, so it is
  always 0), 3 = reserved for the ARM, 4 = latch type.

## Other small asks

- **Per-class K (D10):** read K per class from GLOBAL bytes 20–23 (`persist_K4`), with byte 3 as the fallback. Your
  `proposed_per_class` values (K = [1, 2, 1, 1], `logit_thr` = [0, 256, 0, 0]) are yours to set. The RTL only needs
  the field.
- **`nsr` / `n_off`** may saturate at 255 in the RTL. Your code counts without limit, but outputs match because only
  `min(nsr, 64)` is used. No code change is needed; this is just so you know.
- **Debug readback (D12):** the FPGA can read back one facility's 31 features and 4 logits over AXI-Lite. No change
  on your side.

## Your model v2 commit (`296dd48`)

- `features_int.py` and `model_int.py` didn't change since `0dcf85f`, so the blob layout still matches the FPGA window.
- `artifacts/v2/global_config.json` still says `s_feat: 11` and `countdown: plan_v1`. Please regenerate **v2**
  (augmented weights) with S = 17, `review_r1r2`, and the A13/A19 changes above. Then regenerate golden sets
  G0/G1/G2 and re-run the validation and robustness reports. Feature rounding shifts slightly with S, so the
  precision/recall table needs re-checking.
- Status codes the RTL uses: 0 VALID, 1 HELD, 3 INVALID, 4 DROPPED (2 is never produced).

## Still open

- **R7 (hold/reset policy, my call):** your robustness pass measures 2.7 memory resets per facility-day when 2 % of
  readings are missing. The proposed fix is per-field hold counters and resetting memory only on a real time gap.
  I haven't decided. Until I do, A6 stands as written. If it changes, it is a spec v3 bump on both sides.

## What happens next

1. You apply the asks above (task T0.0 in `FPGA/TASKS.md`), on branch `ml`.
2. The FPGA model agent builds per-module test vectors from your code (`FPGA/model/bus_vectors.py`). Its spec check
   fails until T0.0 lands.
3. `eog_top` must pass G0/G1/G2 (`data.bin` → `expected_results.bin`) bit for bit in simulation.

If anything here disagrees with your code, add a row to "Spec questions" in `FPGA/TASKS.md` with the record and
the field.
