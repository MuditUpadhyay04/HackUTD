# Numerics (spec v4, FROZEN)

Every number the engine produces, bit-exactly. **Normative reference: Mudit's `ml/hutd_ml/features_int.py`** (branch
`ml`, commit 0dcf85f; unchanged through 296dd48) **with the v4 changes in §11 applied**. This file is the readable statement of the same
rules; if the two disagree, raise a spec question — do not pick one.

Notation: `sat16(x)` clamps to [-32768, 32767]; `>>>` is an arithmetic right shift (floor; Python `>>`); `//` is
floor division of non-negative integers. "raw" = the value as carried in the DATA record.

## 1. Decisions

| # | Decision | Status |
| --- | --- | --- |
| D1 | Countdown ring holds **facility inflow** (review R1; Mudit's `review_r1r2` variant) | v1, kept in v4 |
| D2 | Level ≥ shutdown → countdown 0 for all three values, checked first (R2) | v1, kept in v4 |
| D3 | Feature shift **S = 17, fixed**; feature multiplies are signed 20-bit × unsigned 32-bit (Lucas, Sun 00:10: keep 17, not Mudit's 11) | v1, kept in v4 |
| D4 | The countdown is a serial pipeline stage | v1, kept in v4 |
| D6 | Countdown ring is **prefilled** with the first value after a reset, depth 16, `mean = sum >>> 4` (Mudit A8); replaces v1's growing ring and D5 | v4 |
| D7 | Validation, hold, INVALID, timing and alarm comparison rules follow `features_int.py` (Mudit A4, A6, A10, A11, A14) | v4 |
| D8 | Night Shift **and** E-STOP are latched until an acknowledge (plan, Sat 20:35/20:40), not edge-based (Mudit A19 changes) | v4 |
| D9 | A nonzero reserved field or a framing error → DROPPED, reason `FRAMING` (Mudit A13 changes) | v4 |
| D10 | Persistence K per class (Mudit's proposal) | v4 |
| D11 | The AXI-Lite weight window is Mudit's weight blob layout (A18), plus a version word | v4 |
| D12 | Debug readback of one facility's 31 features and 4 logits (Mudit's proposal) | v4 |

## 2. DATA record fields (48 B, little-endian)

Offsets `EOG_D_*`. LSBs: flows 0.5 bpd (s16), level 0.01 % (s16), pressures 0.1 psi (s16). `PUMP_ST` raw u8.
`WELL_ST` 2 bits per slot, slot i at bits [2i+1:2i]. `WELL_WATER` 8 × s16. `PRESENT` bits: 0 inflow, 1 level,
2 pump status, 3 pump flow, 4 discharge, 5 receive flow, 6 pipeline; 8+i well status i; 16+i well water i.
`RSV0`, `RSV1`, `RSV2` must be 0. CONFIG `LO[j]`/`HI[j]` use the same index j as these present bits 0–6
(index 2 bounds the pump status value).

## 3. Validation (eog_validate) — `features_int.py` `Engine.process` / `_fields`

Per-facility state: `last_ts` (or none), `last_valid` per required field (value + present flag), `hold_run`,
`since_reset`, and a pending-reset flag for CONFIG writes. `hold = G.HOLD_MAX` (valid range 0–2; RTL clamps to 2).
Required fields: the 7 facility fields, plus well status and water for slots `i < n_wells` (`1 ≤ N_WELLS ≤ 8`).

In order:

1. **Framing:** `FRAME_ERR` or any reserved field ≠ 0 → DROPPED, reason `FRAMING`, `SINCE_RESET = 0`. No state
   changes.
2. **Facility:** `FAC_ID ≥ N_FAC` or the slot is disabled (`FLAGS[0] = 0`) → DROPPED `UNKNOWN_FAC`,
   `SINCE_RESET = 0`.
3. **Time**, if `last_ts` exists, with `d = TS − last_ts` (signed): `d == 0` → DROPPED `DUPLICATE`; `d < 300`
   (negative or a partial step) → DROPPED `OUT_OF_ORDER`. These two carry the facility's current `SINCE_RESET`
   and change no state. Otherwise `missing = d/300 − 1` if `d` is a multiple of 300, else `hold + 1`:
   `1 ≤ missing ≤ hold` → reason `GAP_HELD`; `missing > hold` → **history reset** (below), reason `HIST_RESET`.
   Then `last_ts = TS` (also for records that end up INVALID).
4. **Fields:** each required field is *OK* if its present bit is 1 and it is legal: pump status ∈ {0,1,2} (else
   `ILLEGAL_ENUM`) and `LO[2] ≤ pump status ≤ HI[2]`; other facility fields `LO[j] ≤ v ≤ HI[j]` (else
   `OUT_OF_RANGE`); well status ∈ {0,1} (else `ILLEGAL_ENUM`); well water `WELL_LO ≤ v ≤ WELL_HI` (else
   `OUT_OF_RANGE`). A field that is not OK is **held** if it has a `last_valid` value, otherwise **missing**.
5. `hold_run = (any field held) ? hold_run + 1 : 0`. If `hold_run > hold`: **history reset**, reason `HIST_RESET`,
   and every held field becomes missing.
6. Every OK field updates its `last_valid` (also on records that end up INVALID). Any held field → reason
   `FIELD_HELD`.
7. **Any missing field → INVALID:** logits 0, rules 0, countdown 3 × `0xFFFF`, `SINCE_RESET` = current value (not
   incremented); downstream persistence counters are cleared; no other state update (memory, countdown ring,
   `prev_level` unchanged). No history reset is implied by INVALID itself.
8. Otherwise status = HELD if `FIELD_HELD` or `GAP_HELD`, else VALID. Values = OK value or `last_valid`.
9. Consistency flags (reason only): `PUMP_INCONS` if `PUMP_ST ≠ 1` and `PUMP_FLOW > 0`; `WELL_INCONS` if some
   configured slot has status 0 and water > 0.
10. `SINCE_RESET` on the output = the facility's value before this record (0 on the first record after a reset);
    it increments by 1 (saturating at 255) after each VALID/HELD record.

**History reset** clears: `last_valid`, `hold_run`, `since_reset`, `prev_level`, and — in later stages, triggered by
`HIST_RESET = 1` on the record, whatever its status except DROPPED — the memory features, the countdown ring and
the persistence counters. It does **not** clear the alarm latches (D8). `HIST_RESET`/reason bit 2 is set only on
the record where a reset happens (step 3 or 5) or on a slot's first record after a CONFIG write; a slot's first
record after power-up or soft reset is not flagged (its state is already clear).

`PREV_LEVEL` = the `LEVEL` of the facility's previous VALID/HELD record since the last reset; `PREV_OK = 0` if
there is none. Outputs: `WELL_ACT[i] = (i < n_wells) & (status_i == 1)`; `WELL_WATER[i] = (i < n_wells) ? water_i : 0`.

## 4. The 12 channels (eog_features)

`feat(x, M) = sat16((x · M + 2^16) >>> 17)` with `x` signed (≤ 20 bits), `M` unsigned 32-bit. A saturating channel
sets reason `FEAT_SAT`.

| Ch | Name | Value |
| --- | --- | --- |
| 0 | inflow_norm | `feat(INFLOW, CFG.M_INV_B)` |
| 1 | pump_flow_norm | `feat(PUMP_FLOW, CFG.M_INV_Q)` |
| 2 | receive_flow_norm | `feat(RECV_FLOW, CFG.M_INV_Q)` |
| 3 | flow_gap_norm | `feat(PUMP_FLOW − RECV_FLOW, CFG.M_INV_Q)` |
| 4 | tank_fraction | `feat(LEVEL, K_LEVEL = 214748)` |
| 5 | discharge_offset_norm | `feat(DIS_PSI − CFG.P0, K_DIS = 1431656)` |
| 6 | pipeline_offset_norm | `feat(PIPE_PSI − CFG.P0, K_PIPE = 4294967)` |
| 7 | pump_running | `PUMP_ST == 1 ? 16384 : 0` |
| 8 | pump_fault | `PUMP_ST == 2 ? 16384 : 0` |
| 9 | wells_active_fraction | `feat(popcount(WELL_ACT), CFG.M_INV_W)` |
| 10 | well_water_norm | `feat(Σ WELL_WATER[i], CFG.M_INV_B)` |
| 11 | tank_net_flow_norm | `PREV_OK ? feat(LEVEL − PREV_LEVEL, CFG.M_NET) : 0` |

`K_*` = `round(2^17 · 16384 / {10000, 1500, 500})`. Only VALID/HELD records get features (INVALID/DROPPED → 0).

**Rule bits 0–3**, VALID/HELD only (INVALID and DROPPED → 0): 0 `PUMP_FAULT` (`PUMP_ST == 2`); 1 `SHUT_IN` (every
configured slot has status 0 **and** water 0, exact); 2 `LVL_SHUTDOWN` (`LEVEL ≥ CFG.SHUT_LVL`); 3 `LVL_WARNING`
(`LEVEL ≥ CFG.WARN_LVL`).

## 5. Memory features (eog_memory)

State per facility: `last_run[5]` (s16), `ema_f[5]`, `ema_s[5]`, `net_ema` (s32), `has_net` (1), `nsr` (u8),
`has_run` (1). Gated channels `g = (1, 2, 3, 5, 6)`. A non-DROPPED record with `HIST_RESET = 1` clears the state
first; only VALID/HELD records update it.

- if `PUMP_RUN`: if `!has_run`, `ema_f[i] = ema_s[i] = x_g[i] << 8`, else `ema_f[i] += ((x_g[i] << 8) − ema_f[i]) >>> 3`
  and `ema_s[i] += ((x_g[i] << 8) − ema_s[i]) >>> 6`; `last_run[i] = x_g[i]`; `has_run = 1`; `nsr = 0`.
- else `nsr = min(nsr + 1, 255)` (the reference counts without limit; outputs are identical because only
  `min(nsr, 64)` is used).
- `net_ema = has_net ? net_ema + (((FEAT[11] << 8) − net_ema) >>> 3) : (FEAT[11] << 8)`; `has_net = 1`.

Outputs after the update (all 0 for INVALID/DROPPED): 0–11 the channels; 12–16 `last_run`; 17–21 `ema_f >>> 8`;
22–26 `ema_s >>> 8`; 27 `net_ema >>> 8`; 28 `min(nsr, 64) << 8`; 29 `has_run ? 16384 : 0`;
30 `min(SINCE_RESET, 64) << 8`.

## 6. Reason bits (RESULT.reason, low 16 bits)

| Bit | Name | | Bit | Name |
| --- | --- | --- | --- | --- |
| 0 | `FIELD_HELD` | | 6 | `PUMP_INCONS` |
| 1 | `GAP_HELD` | | 7 | `WELL_INCONS` |
| 2 | `HIST_RESET` | | 8 | `DUPLICATE` |
| 3 | `OUT_OF_RANGE` | | 9 | `OUT_OF_ORDER` |
| 4 | `ILLEGAL_ENUM` | | 10 | `UNKNOWN_FAC` |
| 5 | `FEAT_SAT` | | 12 | `FRAMING` (new in v4) |

Bits 11, 13–31 are 0. Status codes: 0 VALID, 1 HELD, 3 INVALID, 4 DROPPED (2 never produced).

## 7. Countdown (eog_countdown)

State per facility: a ring of 16 signed inflow values (`INFLOW`, s16). On a facility's first VALID/HELD record after
a reset the whole ring is filled with that record's `INFLOW`; afterwards each VALID/HELD record shifts in its
`INFLOW`. `sum` = ring sum (s20), `mean = sum >>> 4`, `max`/`min` over the ring.

For a VALID/HELD record (after the push), with `K = CFG.K_CD`:

- `NOT_FILLING = (mean ≤ 0)` (rule bit 4), in every case below.
- If `LEVEL ≥ CFG.SHUT_LVL`: `p10 = p50 = p90 = 0`.
- Else, with `Δ = SHUT_LVL − LEVEL`: `p10 = m(max)`, `p50 = m(mean)`, `p90 = m(min)`, where
  `m(q) = q ≤ 0 ? 0xFFFF : min((K · Δ) // (q << 8), 0xFFFF)`.
- INVALID/DROPPED: all three `0xFFFF`, `NOT_FILLING = 0`.

Units: minutes. `K_CD = round(0.288 · C · 256)` (< 2^24). The countdown means "if the pump moves nothing"; the
server shows it for facilities with `PUMP_FAULT`. GLOBAL `CD_LOG2` must be 4 (RTL fixed).

## 8. Logistic head (eog_head)

Active bank, read from the weight window (Mudit's blob layout, D11): `S_OUT` = byte 4; `W[k][i]` (s16) at byte
`8 + 2·(31k + i)`; `B[k]` (s32) at byte `256 + 4k`; `VER` (u8) = window word 70 (written by the ARM from the
WEIGHTS header `aux`; 0 = no model). Bytes 0–3, 5–7 and 272–279 are carried but ignored by the RTL (the ARM
checks `blob_format`, `n_heads`, `n_features`, `feature_set_id`, CRC and runs the self-test vectors in software).

`acc_k = Σ_i W[k][i] · FEAT[i] + B[k]` (exact, 48-bit), `LOGIT[k] = sat16((acc_k + (S_OUT > 0 ? 2^(S_OUT−1) : 0)) >>> S_OUT)`.
VALID/HELD with `VER ≠ 0` get logits, everything else 0. Logit units: 1/256 (Mudit's `L_out = 8`). `WVER` = the
active `VER` when the record was accepted. A record never mixes banks.

## 9. Alarms (eog_alarm)

Per class `K[k] = G.PERSIST_K4[k] ≠ 0 ? G.PERSIST_K4[k] : max(G.PERSIST_K, 1)`. Per facility: `cnt[4]`, `leak_cnt`
(u8, saturating), cleared by a non-DROPPED `HIST_RESET` record before its update and by every INVALID record.

- **VALID/HELD:** `hit[k] = LOGIT[k] > G.LOGIT_THR[k]` (strict, signed); `cnt[k] = hit ? cnt + 1 : 0`;
  `leak_hit = (CH3 > G.GAP_THR) & (LOGIT[0] > G.LOGIT_THR[0])`; `leak_cnt` likewise.
  `class_active[k] = cnt[k] ≥ K[k]`; `es_c = leak_cnt ≥ K[0]`; `ns_c = (RULES[3:0] ≠ 0) | (class_active ≠ 0)`.
  Then `ns_cond[f] = ns_c`, `es_cond[f] = es_c`, `ns_latch[f] |= ns_c`, `es_latch[f] |= es_c`.
- **INVALID:** counters cleared; conditions and latches unchanged; no ALERT.
- **DROPPED:** nothing.
- **Acknowledge** (BTN0 press or `CTRL.server_ack`): `latch &= cond` for both vectors in one cycle. History resets
  never clear latches.

ALERTs (16 B), pushed in this order per record, dropped and counted if the FIFO is full.
`SOURCE` = bit 0 `RULES[3:0] ≠ 0`, bit 1 `class_active ≠ 0`, bit 2 `AUTONOMOUS`, bit 3 reserved for the ARM
(replay), bit 4 latch type (0 Night Shift, 1 E-STOP).

| Kind | When |
| --- | --- |
| 1 `NS_RAISED` | `ns_c` and the old `ns_latch[f] = 0` |
| 2 `ES_RAISED` | `es_c` and the old `es_latch[f] = 0` (SOURCE bit 4 = 1) |
| 3 `CLEARED` | the old `cond[f] = 1`, the new `cond = 0`, the latch still set (one per latch type) |
| 4 `ACKED` | an acknowledge cleared `latch[f]` (`TS = 0`, `RESULT_NO = 0`, `RULES = 0`, `CLASSES = 0`, `CD_P10 = 0xFFFF`) |

`RULES` = the record's rule bits, `CLASSES` = `class_active`, `CD_P10` = the record's p10.

**Heartbeat:** `ms_since_hb` (u16, saturating) is 65535 at reset, 0 on every heartbeat, +1 per ms.
`AUTONOMOUS = (G.HB_TIMEOUT_MS ≠ 0) & (ms_since_hb ≥ G.HB_TIMEOUT_MS)`. Golden vectors are generated with
`HB_TIMEOUT_MS = 0` so SOURCE bit 2 is deterministic.

## 10. CONFIG and GLOBAL values (ingest — Mudit's `encode.py`)

Per facility: `B` = Σ wells' `baseline_water_bpd`, `Q` = pump `max_flow_bpd`, `W` = well count, `C` = tank
`capacity_bbl`, `P0` = the system's disposal `pressure_psi`. Encoding rounds with `floor(v·scale + 0.5)` (A15).

| Field | Value | Ingest refuses unless |
| --- | --- | --- |
| `N_WELLS` | W | 1 ≤ W ≤ 8 (and ≤ 32 facilities) |
| `M_INV_B`, `M_INV_Q` | `round(8192 · 2^17 / B)`, `round(8192 · 2^17 / Q)` | < 2^32 |
| `M_INV_W` | `round(16384 · 2^17 / W)` | (always < 2^32) |
| `M_NET` | `round(16384 · 288 · C · 2^17 / (10000 · B))` | < 2^32 |
| `P0` | `round(10 · P0)` | fits s16 |
| `SHUT_LVL`, `WARN_LVL` | `round(100 · pct)` | ≤ 10000 |
| `K_CD` | `round(0.288 · C · 256)` | < 2^24 |
| `LO/HI`, `WELL_LO/HI` | from metadata (A14): flows −5 % Q … 4·max(Q, B); psi 0 … pipeline `max_pressure_psi`; level −5 … 105 %; pump status 0 … 2; wells −5 % … 4 × max baseline | lo ≤ hi |

GLOBAL (32 B): byte 0 `S` = **17**; 1 `HOLD_MAX` (0–2); 2 `CD_LOG2` = 4; 3 `PERSIST_K` (fallback); 4–5
`HB_PERIOD_MS`; 6–7 `HB_TIMEOUT_MS`; 8–15 `LOGIT_THR[4]` (s16, logit units 1/256); 16–17 `GAP_THR` (s16, feature
units); 18 `FLAGS`; 19 reserved; **20–23 `PERSIST_K4[4]`** (u8, 0 = use byte 3; new in v4); 24–31 reserved.

## 11. Changes `features_int.py` needs for spec v4 (asks for Mudit)

1. `S_feat = 17` everywhere (GLOBAL byte 0, `fixed_multipliers`, encoder); keep only the `< 2^32` checks.
2. Countdown variant `review_r1r2` as the only/default variant.
3. Latched Night Shift (D8): raise once per latch, `CLEARED` (kind 3, SOURCE bit 4 = type) when the condition
   falls while latched; E-STOP gets `CLEARED` too; `reset_history` no longer clears `night_shift`/`estop` latches;
   INVALID records do not change conditions or emit alerts; acknowledge not modelled.
4. Reserved field ≠ 0 → DROPPED with reason bit 12 `FRAMING`, checked before the facility lookup, `since_reset` 0.
5. Per-class K from GLOBAL bytes 20–23 (`persist_K4`), byte 3 as fallback.
6. `nsr`/`n_off` may saturate at 255 (no output change).
7. Regenerate his current artifacts (`artifacts/v2`, the augmented default) + golden sets G0/G1/G2 with the above, and re-run the validation report.
