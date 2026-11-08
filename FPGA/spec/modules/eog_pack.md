# eog_pack — bus A → 32 B RESULT records as 64-bit AXI-Stream beats

## Parameters

`BATCH` (45, results per RESULT packet).

## Ports

| Port | Dir | Width | Meaning |
| --- | --- | --- | --- |
| `clk`, `rst_n` | in | 1 | |
| `in_valid`, `in_ready`, `in_data` | | `EOG_BA_W` | bus A |
| `m_valid`, `m_ready` | out/in | 1 | output beat handshake |
| `m_data` | out | 64 | beat j = RESULT bits `[64j+63:64j]` |
| `m_last` | out | 1 | on beat 3 of a result when `IN_LAST` or it is the `BATCH`-th result since the last `m_last` |
| `tap_valid` | out | 1 | 1-cycle pulse when a result's last beat transfers |
| `tap_status` | out | 3 | that result's `STATUS` |
| `tap_reason` | out | 16 | that result's `REASON` |
| `stall` | out | 1 | `m_valid && !m_ready` (for STATS) |

## Behavior

RESULT record (`EOG_RES_*`): `FAC_ID = FAC_RAW`, `STATUS` zero-extended to 8 bits, `SINCE_RESET`, `TS`,
`REASON` zero-extended to 32 bits, `LOGITS`, `RULES` zero-extended to 8 bits, `WVER`, `CD_P10/P50/P90` from `CD`,
`RESULT_NO = REC_NO`. Four beats per record, in order; sustains one beat per cycle.

## Required properties (verifier)

- K1 AXI-Stream rules on `m_*` (conventions §2).
- K2 Exactly 4 beats per accepted input, in order; the reassembled 256 bits equal the RESULT mapping of that
  input (anyconst input, harness reassembly).
- K3 `m_last` only on beat 3, and exactly when `IN_LAST` or the batch count reaches `BATCH`.
- K4 `tap_*` fires once per record with that record's status/reason.
- Cover: a batch of `BATCH` results ending in `m_last` (with `BATCH = 3` in formal).
