# eog_alarm — persistence, Night Shift / E-STOP latches, ALERTs, heartbeat, LEDs and Pmods

Implements numerics.md §9. These outputs are **local alarm signals only** (global_plan hard rule 8); nothing is
wired to equipment.

## Parameters

`N_FAC` (32), `II` (16), `CYC_PER_MS` (100000 at 100 MHz; formal uses 2–4), `DEB_MS` (10).

## Ports

| Port | Dir | Width | Meaning |
| --- | --- | --- | --- |
| `clk`, `rst_n` | in | 1 | |
| `in_valid`, `in_ready`, `in_data` | | `EOG_BL_W` | bus L |
| `out_valid`, `out_ready`, `out_data` | | `EOG_BA_W` | bus A |
| `glb` | in | 256 | `PERSIST_K`, `LOGIT_THR`, `GAP_THR`, `HB_TIMEOUT_MS` |
| `hb_pulse` | in | 1 | a HEARTBEAT arrived (from `CTRL.heartbeat`) |
| `ack_srv` | in | 1 | acknowledge from the server (`CTRL.server_ack`) |
| `btn0` | in | 1 | raw BTN0 (asynchronous; synchronize with 2 flops, debounce `DEB_MS`, act on the press edge) |
| `al_valid` | out | 1 | push one ALERT (single-cycle pulse) |
| `al_data` | out | 128 | ALERT record (`EOG_AL_*`) |
| `al_full` | in | 1 | ALERT FIFO full: the push is dropped |
| `al_drop` | out | 1 | pulse when an ALERT was dropped because `al_full` |
| `autonomous` | out | 1 | numerics.md §9 |
| `ms_since_hb` | out | 16 | |
| `ledovr` | in | 32 | LEDOVR register |
| `ld0`, `ld1` | out | 3 each | RGB, `[2]` red, `[1]` green, `[0]` blue; active high, PWM ≤ 25 % duty |
| `pmod_ja`, `pmod_jb` | out | 8 each | |

## Behavior

Persistence and latches per numerics.md §9. Outputs (unless `ledovr[31]`, which drives the raw override values):

- `ld0`: blinking red (2 Hz) if any INVALID or DROPPED record was seen in the last 1000 ms; else blue if
  `autonomous`; else green.
- `ld1`: red if any `es_latch`; else amber (red + green) if any `ns_latch`; else off.
- `pmod_ja = {4'b0, hb_toggle, autonomous, |ns_latch, |es_latch}` (bit 0 = E_STOP).
- `pmod_jb = {2'b0, any_latch, worst[4:0]}` where `worst` = the lowest slot with `es_latch`, else the lowest with
  `ns_latch`, else 0.
- `hb_toggle` flips on every `hb_pulse`.
- Acknowledge (debounced BTN0 press or `ack_srv`): `latch &= cond` for both vectors in one cycle, then an ACKED
  ALERT per cleared bit, emitted one per cycle (stage holds `in_ready = 0` during this sweep, ≤ 2·N_FAC cycles).

Bus A: header and `RULES`, `CD`, `LOGITS`, `WVER` copied; `CLASSES = class_active`.

## Required properties (verifier)

Stage contract (conventions §3) (except during an acknowledge sweep).

- A1 E-STOP soundness: `es_latch[f]` rises only on a VALID/HELD record of f whose leak counter reaches K (both
  the leak logit and `CH3 ≥ GAP_THR` held on K consecutive VALID/HELD records of f).
- A2 Latch hold: `es_latch[f]`/`ns_latch[f]` fall only in an acknowledge cycle, and only when the matching `cond[f]`
  is 0.
- A3 Persistence: `class_active[k]` for f implies the last K accepted VALID/HELD records of f all had
  `LOGIT[k] ≥ THR[k]` with no INVALID in between (harness counter).
- A4 DROPPED records change no state.
- A5 Every latch rise produces exactly one RAISED ALERT push (or one `al_drop`); every ack-cleared bit produces
  exactly one ACKED push (or drop).
- A6 Heartbeat: `autonomous` equals `HB_TIMEOUT_MS ≠ 0 && ms_since_hb ≥ HB_TIMEOUT_MS`; `ms_since_hb` resets to 0
  on `hb_pulse` and otherwise increments once per `CYC_PER_MS` cycles, saturating at 65535; it is 65535 after
  reset.
- A7 Pmod/LED mapping matches the table above (combinational check from state).
- A8 Debounce: a BTN0 level shorter than `DEB_MS` never acknowledges.

Simulation: `tb/vectors/alarm_*.hex` from `model/` (practice week with default thresholds and a synthetic
weight set that fires each class).

Cover: an E-STOP raise, a CLEARED, an ack sweep clearing 2 slots, autonomous entry and exit.
