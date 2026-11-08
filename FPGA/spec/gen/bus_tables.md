### Bus U (eog_unpack -> eog_validate), 418 bits

| Field | LSB | Width | Meaning |
| --- | --- | --- | --- |
| `REC_NO` | 0 | 32 |  |
| `IN_LAST` | 32 | 1 |  |
| `FRAME_ERR` | 33 | 1 | TLAST arrived before beat 6, record incomplete |
| `REC` | 34 | 384 | the 48 B DATA record, byte k at bits [8k+7:8k] |

### Bus V (eog_validate -> eog_features), 373 bits

| Field | LSB | Width | Meaning |
| --- | --- | --- | --- |
| `REC_NO` | 0 | 32 | record number assigned by eog_unpack (monotonic, wraps); becomes RESULT.result_no |
| `IN_LAST` | 32 | 1 | input beat carried TLAST on this record's last beat |
| `FAC_RAW` | 33 | 16 | raw DATA.fac_id field (echoed in RESULT even when unknown) |
| `FAC` | 49 | 5 | facility slot = FAC_RAW[4:0]; meaningful only if status != DROPPED(unknown) |
| `TS` | 54 | 32 | DATA.ts_unix |
| `STATUS` | 86 | 3 | wire codes: 0 VALID, 1 HELD, 3 INVALID, 4 DROPPED (2 unused) |
| `REASON` | 89 | 16 | reason bits, see numerics.md §6 |
| `SINCE_RESET` | 105 | 8 | records since this facility's last history reset, saturating at 255 (0 on the reset record) |
| `HIST_RESET` | 113 | 1 | this record starts a new history for its facility |
| `INFLOW` | 114 | 16 | s16, 0.5 bpd |
| `LEVEL` | 130 | 16 | s16, 0.01 % |
| `PUMP_FLOW` | 146 | 16 | s16, 0.5 bpd |
| `RECV_FLOW` | 162 | 16 | s16, 0.5 bpd |
| `DIS_PSI` | 178 | 16 | s16, 0.1 psi |
| `PIPE_PSI` | 194 | 16 | s16, 0.1 psi |
| `PUMP_ST` | 210 | 2 | 0 off, 1 running, 2 fault |
| `WELL_ACT` | 212 | 8 | bit i = well slot i status==1 (0 for slots >= n_wells) |
| `WELL_WATER` | 220 | 128 | 8 x s16, slot i at [16i+15:16i]; 0 for slots >= n_wells |
| `FLD_OK` | 348 | 7 | per facility field, after hold: bit order = DATA present bits 0..6 |
| `WELLS_OK` | 355 | 1 | all configured well fields valid after hold |
| `PREV_LEVEL` | 356 | 16 | s16 LEVEL of this facility's previous accepted record |
| `PREV_OK` | 372 | 1 | PREV_LEVEL exists (0 on a history-reset record) |

### Bus F (eog_features -> eog_memory), 343 bits

| Field | LSB | Width | Meaning |
| --- | --- | --- | --- |
| `REC_NO` | 0 | 32 | record number assigned by eog_unpack (monotonic, wraps); becomes RESULT.result_no |
| `IN_LAST` | 32 | 1 | input beat carried TLAST on this record's last beat |
| `FAC_RAW` | 33 | 16 | raw DATA.fac_id field (echoed in RESULT even when unknown) |
| `FAC` | 49 | 5 | facility slot = FAC_RAW[4:0]; meaningful only if status != DROPPED(unknown) |
| `TS` | 54 | 32 | DATA.ts_unix |
| `STATUS` | 86 | 3 | wire codes: 0 VALID, 1 HELD, 3 INVALID, 4 DROPPED (2 unused) |
| `REASON` | 89 | 16 | reason bits, see numerics.md §6 |
| `SINCE_RESET` | 105 | 8 | records since this facility's last history reset, saturating at 255 (0 on the reset record) |
| `HIST_RESET` | 113 | 1 | this record starts a new history for its facility |
| `FEAT0_11` | 114 | 192 | 12 x s16 features, channel c at [16c+15:16c] |
| `RULES4` | 306 | 4 | rule bits 0..3 |
| `INFLOW` | 310 | 16 | s16 copy for countdown |
| `LEVEL` | 326 | 16 | s16 copy for countdown |
| `PUMP_RUN` | 342 | 1 | PUMP_ST == 1 |

### Bus M (eog_memory -> eog_countdown), 646 bits

| Field | LSB | Width | Meaning |
| --- | --- | --- | --- |
| `REC_NO` | 0 | 32 | record number assigned by eog_unpack (monotonic, wraps); becomes RESULT.result_no |
| `IN_LAST` | 32 | 1 | input beat carried TLAST on this record's last beat |
| `FAC_RAW` | 33 | 16 | raw DATA.fac_id field (echoed in RESULT even when unknown) |
| `FAC` | 49 | 5 | facility slot = FAC_RAW[4:0]; meaningful only if status != DROPPED(unknown) |
| `TS` | 54 | 32 | DATA.ts_unix |
| `STATUS` | 86 | 3 | wire codes: 0 VALID, 1 HELD, 3 INVALID, 4 DROPPED (2 unused) |
| `REASON` | 89 | 16 | reason bits, see numerics.md §6 |
| `SINCE_RESET` | 105 | 8 | records since this facility's last history reset, saturating at 255 (0 on the reset record) |
| `HIST_RESET` | 113 | 1 | this record starts a new history for its facility |
| `FEAT` | 114 | 496 | 31 x s16 features, index i at [16i+15:16i] |
| `RULES4` | 610 | 4 |  |
| `INFLOW` | 614 | 16 |  |
| `LEVEL` | 630 | 16 |  |

### Bus C (eog_countdown -> eog_head), 663 bits

| Field | LSB | Width | Meaning |
| --- | --- | --- | --- |
| `REC_NO` | 0 | 32 | record number assigned by eog_unpack (monotonic, wraps); becomes RESULT.result_no |
| `IN_LAST` | 32 | 1 | input beat carried TLAST on this record's last beat |
| `FAC_RAW` | 33 | 16 | raw DATA.fac_id field (echoed in RESULT even when unknown) |
| `FAC` | 49 | 5 | facility slot = FAC_RAW[4:0]; meaningful only if status != DROPPED(unknown) |
| `TS` | 54 | 32 | DATA.ts_unix |
| `STATUS` | 86 | 3 | wire codes: 0 VALID, 1 HELD, 3 INVALID, 4 DROPPED (2 unused) |
| `REASON` | 89 | 16 | reason bits, see numerics.md §6 |
| `SINCE_RESET` | 105 | 8 | records since this facility's last history reset, saturating at 255 (0 on the reset record) |
| `HIST_RESET` | 113 | 1 | this record starts a new history for its facility |
| `FEAT` | 114 | 496 |  |
| `RULES` | 610 | 5 | rule bits 0..4 |
| `CD` | 615 | 48 | p10 [15:0], p50 [31:16], p90 [47:32], minutes |

### Bus L (eog_head -> eog_alarm), 255 bits

| Field | LSB | Width | Meaning |
| --- | --- | --- | --- |
| `REC_NO` | 0 | 32 | record number assigned by eog_unpack (monotonic, wraps); becomes RESULT.result_no |
| `IN_LAST` | 32 | 1 | input beat carried TLAST on this record's last beat |
| `FAC_RAW` | 33 | 16 | raw DATA.fac_id field (echoed in RESULT even when unknown) |
| `FAC` | 49 | 5 | facility slot = FAC_RAW[4:0]; meaningful only if status != DROPPED(unknown) |
| `TS` | 54 | 32 | DATA.ts_unix |
| `STATUS` | 86 | 3 | wire codes: 0 VALID, 1 HELD, 3 INVALID, 4 DROPPED (2 unused) |
| `REASON` | 89 | 16 | reason bits, see numerics.md §6 |
| `SINCE_RESET` | 105 | 8 | records since this facility's last history reset, saturating at 255 (0 on the reset record) |
| `HIST_RESET` | 113 | 1 | this record starts a new history for its facility |
| `CH3` | 114 | 16 | feature 3 (flow gap) for the leak rule |
| `RULES` | 130 | 5 |  |
| `CD` | 135 | 48 |  |
| `LOGITS` | 183 | 64 | 4 x s16, class k at [16k+15:16k] |
| `WVER` | 247 | 8 | weights version used (0 = no model) |

### Bus A (eog_alarm -> eog_pack), 243 bits

| Field | LSB | Width | Meaning |
| --- | --- | --- | --- |
| `REC_NO` | 0 | 32 | record number assigned by eog_unpack (monotonic, wraps); becomes RESULT.result_no |
| `IN_LAST` | 32 | 1 | input beat carried TLAST on this record's last beat |
| `FAC_RAW` | 33 | 16 | raw DATA.fac_id field (echoed in RESULT even when unknown) |
| `FAC` | 49 | 5 | facility slot = FAC_RAW[4:0]; meaningful only if status != DROPPED(unknown) |
| `TS` | 54 | 32 | DATA.ts_unix |
| `STATUS` | 86 | 3 | wire codes: 0 VALID, 1 HELD, 3 INVALID, 4 DROPPED (2 unused) |
| `REASON` | 89 | 16 | reason bits, see numerics.md §6 |
| `SINCE_RESET` | 105 | 8 | records since this facility's last history reset, saturating at 255 (0 on the reset record) |
| `HIST_RESET` | 113 | 1 | this record starts a new history for its facility |
| `RULES` | 114 | 5 |  |
| `CD` | 119 | 48 |  |
| `LOGITS` | 167 | 64 |  |
| `WVER` | 231 | 8 |  |
| `CLASSES` | 239 | 4 | class_active bits from eog_alarm (not in RESULT) |
