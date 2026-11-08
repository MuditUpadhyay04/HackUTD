# eog_alarm — persistence, Night Shift / E-STOP latches, ALERTs, heartbeat, LEDs and Pmods

Implements numerics.md §9 (D8, D10). **Local alarm signals only** (global_plan hard rule 8); nothing is wired to
equipment.

## Parameters

`N_FAC` (32), `II` (16), `CYC_PER_MS` (100000 at 100 MHz; formal uses 2–4), `DEB_MS` (10).

## Ports

| Port | Dir | Width | Meaning |
| --- | --- | --- | --- |
| `clk`, `rst_n` | in | 1 | |
| `in_valid`, `in_ready`, `in_data` | | `EOG_BL_W` | bus L |
| `out_valid`, `out_ready`, `out_data` | | `EOG_BA_W` | bus A |
| `glb` | in | 256 | `PERSIST_K`, `PERSIST_K4`, `LOGIT_THR`, `GAP_THR`, `HB_TIMEOUT_MS` |
| `hb_pulse` | in | 1 | a HEARTBEAT arrived |
| `ack_srv` | in | 1 | acknowledge from the server |
| `btn0` | in | 1 | raw BTN0 (2-flop sync, debounce `DEB_MS`, act on the press edge) |
| `al_valid` | out | 1 | push one ALERT (1-cycle pulse) |
| `al_data` | out | 128 | ALERT record (`EOG_AL_*`) |
| `al_full` | in | 1 | ALERT FIFO full: the push is dropped |
| `al_drop` | out | 1 | pulse when an ALERT was dropped |
| `autonomous` | out | 1 | |
| `ms_since_hb` | out | 16 | |
| `ledovr` | in | 32 | LEDOVR register |
| `ld0`, `ld1` | out | 3 each | RGB `[2]` red `[1]` green `[0]` blue, active high, ≤ 25 % PWM duty |
| `pmod_ja`, `pmod_jb` | out | 8 each | |

## Behavior

numerics.md §9. Outputs (unless `ledovr[31]`, which drives the raw override values):

- `ld0`: blinking red (2 Hz) if any INVALID or DROPPED record in the last 1000 ms; else blue if `autonomous`;
  else green.
- `ld1`: red if any `es_latch`; else amber (red + green) if any `ns_latch`; else off.
- `pmod_ja = {4'b0, hb_toggle, autonomous, |ns_latch, |es_latch}`; `pmod_jb = {2'b0, any_latch, worst[4:0]}`,
  `worst` = lowest slot with `es_latch`, else lowest with `ns_latch`, else 0. `hb_toggle` flips per `hb_pulse`.
- Acknowledge: `latch &= cond` in one cycle, then one ACKED ALERT per cleared bit, one per cycle (`in_ready = 0`
  during this sweep, ≤ 2·N_FAC cycles).
- Bus A: header, `RULES`, `CD`, `LOGITS`, `WVER` copied; `CLASSES = class_active`.

## Required properties (verifier)

Stage contract (conventions §3), except during an acknowledge sweep.

- A1 E-STOP soundness: `es_latch[f]` rises only on a VALID/HELD record of f whose leak counter reaches `K[0]`
  (`CH3 > GAP_THR` and `LOGIT[0] > THR[0]` on `K[0]` consecutive VALID/HELD records with no INVALID or reset between).
- A2 Latches fall only in an acknowledge cycle, only where `cond` is 0; history resets and INVALID never clear them.
- A3 `class_active[k]` for f ⇒ the last `K[k]` VALID/HELD records of f had `LOGIT[k] > THR[k]`, none INVALID or
  reset in between (strict `>`).
- A4 DROPPED changes nothing; INVALID only clears counters and emits nothing.
- A5 One RAISED push (or `al_drop`) per latch rise; one ACKED push (or drop) per ack-cleared bit; one CLEARED per
  `cond` fall while latched.
- A6 Heartbeat: `autonomous == (HB_TIMEOUT_MS ≠ 0 && ms_since_hb ≥ HB_TIMEOUT_MS)`; `ms_since_hb` = 65535 after
  reset, 0 on `hb_pulse`, +1 per `CYC_PER_MS` cycles, saturating.
- A7 LED/Pmod mapping matches the table above.
- A8 Debounce: a BTN0 level shorter than `DEB_MS` never acknowledges.
- A9 `K[k]` = `PERSIST_K4[k]` if nonzero, else `max(PERSIST_K, 1)`.

Simulation: `tb/vectors/alarm_*.hex` from Mudit's golden sets (after his D8 latch change), `HB_TIMEOUT_MS = 0`.

Cover: an E-STOP raise, a CLEARED, an ack sweep clearing 2 slots, autonomous entry and exit.
