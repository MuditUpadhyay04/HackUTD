# Numerics (spec v1, FROZEN)

Every number the engine produces is defined here bit-exactly. `model/eog_ref.py` must implement exactly this, and
Mudit's `features_int.py` must agree with it for channels 0–11 and the memory features.

Notation: `sat16(x)` clamps to [-32768, 32767]; `>>>` is arithmetic right shift (floor toward −∞); all divisions
are of non-negative integers and truncate (floor). "raw" means the value as carried in the DATA record.

## 1. Decisions taken at freeze (Sat Nov 7, 22:15 CST)

| # | Decision | Why |
| --- | --- | --- |
| D1 (R1) | The countdown uses a ring of **facility inflow**, not inflow − pump flow. | SPEC defines the countdown as "if nothing changes", and a failed pump moves 0 bpd. The old ring showed "not filling" at 13/13 practice failure onsets. |
| D2 (R2) | Level ≥ shutdown → all three countdown values are 0, checked before "not filling". | A tripped tank must read 0, not 0xFFFF. |
| D3 (R3) | Feature shift **S = 17, fixed** (not runtime). Feature multipliers are signed 20-bit × unsigned 32-bit (2 DSP48E1). | Fits every CONFIG multiplier for 1–8 wells in u32 and keeps 1/Q rounding error below 1 feature LSB. GLOBAL `S` must be written as 17 and reads back 17. |
| D4 | The countdown is a serial pipeline stage, not a parallel branch. | No fork/join; simpler proofs. Latency is irrelevant at 5-minute data. |
| D5 | p50 is computed as `K·Δ·n / (sum·256)` (algebraically the mean), so no separate mean division. | Exact, one division per value. |

## 2. DATA record fields (48 B, little-endian)

Offsets `EOG_D_*`. LSBs: flows 0.5 bpd (s16), level 0.01 % (s16), pressures 0.1 psi (s16). `PUMP_ST` raw u8
(legal 0 off, 1 running, 2 fault). `WELL_ST` 2 bits per slot, slot i at bits [2i+1:2i] (legal 0, 1). `WELL_WATER`
8 × s16 (0.5 bpd). `PRESENT` bit map in `eog_defs.svh`. `RSV0`, `RSV1`, `RSV2` must be 0.

## 3. Validation (eog_validate)

Per record, in this order. `f` = slot, `hold = min(G.HOLD_MAX, 2)`.

1. **Framing:** `FRAME_ERR` or any reserved field ≠ 0 → DROPPED, reason `FRAMING`.
2. **Facility:** `FAC_ID ≥ N_FAC` or the row's `FLAGS[0] = 0` → DROPPED, reason `UNKNOWN_FAC`.
3. **Time** (only if the facility has a previous timestamp `last_ts` and no pending reset):
   `TS == last_ts` → DROPPED `DUPLICATE`; `TS < last_ts` (unsigned) → DROPPED `OUT_OF_ORDER`;
   `TS − last_ts == 300` → normal; `== 600` (1 missing step) or `== 900` (2 missing) → held if that count ≤ `hold`
   (reason `GAP_HELD`), otherwise a new history; any other difference → new history.
   No previous timestamp, or a pending reset (after an INVALID record, a CONFIG write or reset) → new history.
4. **New history:** clear all held values and miss counters; `SINCE_RESET = 0`; `HIST_RESET = 1`; reason
   `HIST_RESET`; `PREV_OK = 0`. Otherwise `SINCE_RESET = min(previous + 1, 255)`.
5. **Fields.** Required: the 7 facility fields, plus well status and well water for slots `i < n_wells`
   (`n_wells = min(CFG.N_WELLS, 8)`). A field is *observed OK* if its `PRESENT` bit is 1 **and** it is legal
   (pump status ∈ {0,1,2}; well status ∈ {0,1}; readings within the row's `LO[j] ≤ v ≤ HI[j]` signed, well water
   within `WELL_LO ≤ v ≤ WELL_HI`). Reasons: missing → `FIELD_ABSENT`; illegal enum → `ILLEGAL_ENUM`; out of range
   → `OUT_OF_RANGE`.
   - observed OK → use it; it becomes the field's last value; its miss counter = 0.
   - not OK, the field has a last value and its miss counter < `hold` → use the last value, counter + 1, reason
     `FIELD_HELD`.
   - otherwise → the field is **lost**: reason `FIELD_LOST`, value 0, its `FLD_OK`/`WELLS_OK` bit 0.
   (A step gap does not advance the per-field miss counters.)
6. **Status:** DROPPED (steps 1–3) › INVALID (any field lost) › HELD (any field held, or `GAP_HELD`) › VALID.
7. **INVALID** sets the facility's pending-reset flag (its next accepted record starts a new history) and updates
   `last_ts`. VALID/HELD clear it, update `last_ts`, and store the record's level as the next `PREV_LEVEL`.
   `PREV_LEVEL` = the `LEVEL` of the facility's previous VALID/HELD record in the same history; `PREV_OK = 0` on a
   new history.
8. **Consistency flags** (reason only, never change status): `PUMP_INCONS` if `PUMP_ST ≠ 1` and `PUMP_FLOW > 0`;
   `WELL_INCONS` if some configured slot has status 0 and water > 0.
9. Outputs: `WELL_ACT[i] = (i < n_wells) & (status_i == 1)`; `WELL_WATER[i] = (i < n_wells) ? water_i : 0`.
   DROPPED records carry `FAC = FAC_ID[4:0]`, `SINCE_RESET = 0`, `HIST_RESET = 0`, all values 0.

## 4. The 12 channels (eog_features)

`feat(x, M) = sat16((x · M + 2^16) >>> 17)` with `x` signed (≤ 20 bits), `M` unsigned 32-bit (product is signed
53-bit). A channel that saturates sets reason `FEAT_SAT`.

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

Only VALID/HELD records get features; INVALID and DROPPED records get all 0.

**Rule bits 0–3** (computed for VALID, HELD and INVALID; each needs its inputs `FLD_OK`, otherwise 0; DROPPED → 0):

| Bit | Rule | Condition |
| --- | --- | --- |
| 0 | `PUMP_FAULT` | `PUMP_ST == 2` |
| 1 | `SHUT_IN` | `WELLS_OK` and `n_wells ≥ 1` and `WELL_ACT == 0` and every configured slot has `water ≤ G.SHUTIN_WATER_MAX` |
| 2 | `LVL_SHUTDOWN` | `LEVEL ≥ CFG.SHUT_LVL` (signed compare, `SHUT_LVL` zero-extended) |
| 3 | `LVL_WARNING` | `LEVEL ≥ CFG.WARN_LVL` |

## 5. Memory features (eog_memory)

State per facility: `last_run[5]` (s16), `ema_f[5]`, `ema_s[5]`, `net_ema` (s32), `nsr` (u8, steps since run),
`has_run` (1 bit). Gated channels `g = (1, 2, 3, 5, 6)`. Only VALID/HELD records update state; on `HIST_RESET`
the state is cleared to 0 **before** the update.

On every VALID/HELD record, with `x = FEAT[c]` and `run = PUMP_RUN`:

- if `run`: if `!has_run` then `ema_f[i] = ema_s[i] = x_g[i] << 8` and `has_run = 1`; else
  `ema_f[i] += ((x_g[i] << 8) − ema_f[i]) >>> 3` and `ema_s[i] += ((x_g[i] << 8) − ema_s[i]) >>> 6`;
  `last_run[i] = x_g[i]`; `nsr = 0`.
- if `!run`: `nsr = min(nsr + 1, 255)`.
- always: `net_ema += ((FEAT[11] << 8) − net_ema) >>> 3`.

Outputs (after the update; all 0 for INVALID/DROPPED):

| Index | Feature |
| --- | --- |
| 0–11 | the 12 channels, unchanged |
| 12–16 | `last_run[0..4]` |
| 17–21 | `ema_f[0..4] >>> 8` |
| 22–26 | `ema_s[0..4] >>> 8` |
| 27 | `net_ema >>> 8` |
| 28 | `min(nsr, 64) << 8` |
| 29 | `has_run ? 16384 : 0` |
| 30 | `min(SINCE_RESET, 64) << 8` |

Every value fits int16 by construction (an average stays within the min/max of its inputs). Time constants count
*running* records: at practice duty cycles they are about 1 h and 8 h of wall clock (review R6).

## 6. Reason bits (RESULT.reason, low 16 bits; upper 16 are 0)

| Bit | Name | Set by |
| --- | --- | --- |
| 0 | `FIELD_HELD` | validate |
| 1 | `GAP_HELD` | validate |
| 2 | `HIST_RESET` | validate |
| 3 | `OUT_OF_RANGE` | validate |
| 4 | `ILLEGAL_ENUM` | validate |
| 5 | `FEAT_SAT` | features |
| 6 | `PUMP_INCONS` | validate |
| 7 | `WELL_INCONS` | validate |
| 8 | `DUPLICATE` | validate |
| 9 | `OUT_OF_ORDER` | validate |
| 10 | `UNKNOWN_FAC` | validate |
| 11 | `FIELD_ABSENT` | validate (new in v1 freeze; was reserved) |
| 12 | `FRAMING` | validate (new) |
| 13 | `NO_MODEL` | head: VALID/HELD record while the active bank's version is 0 (new) |
| 14 | `FIELD_LOST` | validate (new) |

## 7. Countdown (eog_countdown)

State per facility: ring of the last `n ≤ 16` values `q = max(INFLOW, 0)` (u15), with their `sum` (u19), `max`,
`min` computed over the ring. Only VALID/HELD records update it; `HIST_RESET` clears it before the push.

For a VALID/HELD record, after pushing `q`:

- if `LEVEL ≥ CFG.SHUT_LVL`: `p10 = p50 = p90 = 0`, `NOT_FILLING = 0`.
- else, with `Δ = SHUT_LVL − LEVEL` (u17) and `K = CFG.K_CD`:
  - `p10 = div(K·Δ, max·256)`   (soonest: highest inflow)
  - `p50 = div(K·Δ·n, sum·256)` (mean inflow)
  - `p90 = div(K·Δ, min·256)`   (latest: lowest inflow)
  - where `div(a, b) = b == 0 ? 0xFFFF : min(floor(a / b), 0xFFFF)`, and `NOT_FILLING = (sum == 0)`.
- Units: minutes. `0xFFFF` means not filling or more than 45 days. INVALID/DROPPED → all three `0xFFFF`,
  `NOT_FILLING = 0`.

Derivation: minutes = 1440 · remaining_bbl / inflow_bpd = 1440 · C·(Δ/10000) / (q/2) = 0.288·C·Δ/q, and
`K_CD = round(0.288 · C · 256)`. Widths: numerator ≤ 48 bits, denominator ≤ 32 bits. The countdown is "hours until
shutdown if the pump moves nothing"; the server shows it for facilities with `PUMP_FAULT`.

## 8. Logistic head (eog_head)

Active bank: `W[k][i]` (s16, k = 0..3, i = 0..30), `B[k]` (s32), `S_OUT` (u5), `VER` (u8, 0 = no model).

`acc_k = Σ_i W[k][i] · FEAT[i] + B[k]` (exact, 48-bit signed; never overflows: |acc| < 2^36), then
`LOGIT[k] = sat16((acc_k + (S_OUT > 0 ? 2^(S_OUT−1) : 0)) >>> S_OUT)`.

VALID/HELD records with `VER ≠ 0` get logits; otherwise logits are 0 (and VALID/HELD with `VER = 0` set
`NO_MODEL`). `WVER` = the active bank's `VER` when the record was accepted. A record never mixes two banks.

**Weight image** (69 × 32-bit words; the AXI-Lite window and the WEIGHTS blob body use the same image):

| Words | Contents |
| --- | --- |
| `16k + j` (k = 0..3, j = 0..15) | `[15:0] = W[k][2j]`, `[31:16] = W[k][2j+1]`; `W[k][31]` is padding, written 0, ignored |
| 64–67 | `B[0..3]` |
| 68 | `[4:0] S_OUT`, `[15:8] VER`, other bits 0 |

## 9. Alarms (eog_alarm)

`K = max(G.PERSIST_K, 1)`. Per facility: `cnt[4]`, `leak_cnt` (u8, saturating). Per record:

- **VALID/HELD:** `hit[k] = LOGIT[k] ≥ G.LOGIT_THR[k]` (signed); `cnt[k] = hit ? sat(cnt+1) : 0`;
  `leak_hit = hit[0] & (CH3 ≥ G.GAP_THR)`; `leak_cnt` likewise. `class_active[k] = cnt[k] ≥ K`;
  `es_c = leak_cnt ≥ K`; `ns_c = (RULES[3:0] ≠ 0) | (class_active ≠ 0)`.
- **INVALID:** counters = 0; `es_c = 0`; `ns_c = RULES[3:0] ≠ 0`.
- **DROPPED:** nothing changes.

Latches (32-bit vectors, one bit per facility): `ns_latch[f] |= ns_c`, `es_latch[f] |= es_c`; condition vectors
`ns_cond[f] = ns_c`, `es_cond[f] = es_c`. An **acknowledge** (BTN0 press or `CTRL.server_ack`) clears
`latch &= cond` for both vectors at once.

ALERTs (16 B, `EOG_AL_*`), pushed in this order, dropped (and counted) if the ALERT FIFO is full:

| Kind | When | SOURCE bits |
| --- | --- | --- |
| 1 `NS_RAISED` | `ns_c` and the old `ns_latch[f] = 0` | 0 rule (`RULES[3:0] ≠ 0`), 1 model (`class_active ≠ 0`), 2 autonomous |
| 2 `ES_RAISED` | `es_c` and the old `es_latch[f] = 0` | 0 rule (gap), 1 model, 2 autonomous, 4 = 1 (E-STOP) |
| 3 `CLEARED` | the old `cond[f] = 1`, the new `cond = 0`, latch still set | 2 autonomous, 4 = latch type (0 NS, 1 ES) |
| 4 `ACKED` | an acknowledge cleared `latch[f]` | 4 = latch type; `TS = 0`, `RESULT_NO = 0`, `CD_P10 = 0xFFFF` |

Bit 3 of SOURCE is reserved for the ARM ("replayed from buffer"). `RULES` = the record's rule bits, `CLASSES` =
`class_active`, `CD_P10` = the record's p10.

**Heartbeat:** a millisecond counter `ms_since_hb` (u16, saturating) is 65535 at reset and 0 on every heartbeat.
`AUTONOMOUS = (G.HB_TIMEOUT_MS ≠ 0) & (ms_since_hb ≥ G.HB_TIMEOUT_MS)`.

## 10. CONFIG values the ingest computes (per facility, from `network.json`)

`B` = sum of the facility's wells' `baseline_water_bpd`; `Q` = pump `max_flow_bpd`; `W` = well count; `C` = tank
`capacity_bbl`; `P0` = the system's disposal `pressure_psi`; limits from `defaults.tank_limits_pct` unless the tank
overrides them.

| Field | Value | Must hold (ingest refuses otherwise) |
| --- | --- | --- |
| `N_WELLS` | `W` | 1 ≤ W ≤ 8 |
| `M_INV_B` | `round(8192 · 2^17 / B)` | < 2^32 |
| `M_INV_Q` | `round(8192 · 2^17 / Q)` | < 2^32 |
| `M_INV_W` | `round(16384 · 2^17 / W)` | < 2^32 (true for W ≥ 1) |
| `M_NET` | `round(16384 · 288 · C · 2^17 / (10000 · B))` | < 2^32 |
| `P0` | `round(10 · P0)` | fits s16 |
| `SHUT_LVL`, `WARN_LVL` | `round(100 · pct)` | ≤ 10000 |
| `K_CD` | `round(0.288 · C · 256)` | < 2^24 |
| `LO/HI` | suggested: flows [0, 32767], level [0, 10000], pressures [0, 32767], well water [0, 32767] | lo ≤ hi |

Suggested GLOBAL defaults until Mudit calibrates (O2): `S = 17`, `HOLD_MAX = 2`, `PERSIST_K = 3`,
`HB_PERIOD_MS = 1000`, `HB_TIMEOUT_MS = 5000`, `LOGIT_THR = 0` (p = 0.5), `GAP_THR = 492` (3 % of Q; healthy
running 99th percentile 1.84 %, leak median 6.34 %), `SHUTIN_WATER_MAX = 0`.
