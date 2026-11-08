# eog_unpack — AXI-Stream beats → 48 B records

## Ports

| Port | Dir | Width | Meaning |
| --- | --- | --- | --- |
| `clk`, `rst_n` | in | 1 | |
| `s_valid`, `s_ready` | in/out | 1 | input beat handshake |
| `s_data` | in | 64 | beat; byte 0 of the beat in `[7:0]` |
| `s_last` | in | 1 | last beat of a DMA transfer / DATA-window push |
| `out_valid`, `out_ready` | out/in | 1 | bus U handshake |
| `out_data` | out | `EOG_BU_W` | bus U |

## Behavior

- Beats fill the record in order: beat j (0..5) → `REC[64j+63:64j]`. After beat 5 the record is emitted with
  `FRAME_ERR = 0` and `IN_LAST = s_last` of beat 5.
- If `s_last` arrives on beat j < 5, the partial record is emitted immediately with `FRAME_ERR = 1`, `IN_LAST = 1`,
  and the bytes not yet received set to 0. The next beat starts a new record.
- `REC_NO` starts at 0 after reset and increments by 1 for every emitted record (wraps at 2^32).
- The module holds at most one record; it may accept the next beat while presenting a record only if it has a
  second buffer (optional). It must accept a beat every cycle while `out_ready = 1` (sustained 6 cycles/record).

## Required properties (verifier)

- P1 AXI-Stream rules on the output (conventions §2); no output without input.
- P2 `REC_NO` of consecutive outputs increases by exactly 1; the first output after reset has `REC_NO = 0`.
- P3 Byte mapping: track one arbitrary beat (anyconst position and value) and prove it lands at the right offset
  of the right record.
- P4 Framing: a record is emitted after exactly 6 beats or at an earlier `s_last`; `FRAME_ERR` is set iff it was
  early; `IN_LAST` matches.
- P5 Liveness: with `out_ready = 1`, a record appears within 2 cycles of its last beat; `s_ready` is not low for
  more than 1 cycle at a time.
- Cover: two full records back to back; one framing error followed by a good record.
