# Single source for bus layouts -> rtl/eog_defs.svh and spec tables.
H = [("REC_NO",32,"record number assigned by eog_unpack (monotonic, wraps); becomes RESULT.result_no"),
     ("IN_LAST",1,"input beat carried TLAST on this record's last beat"),
     ("FAC_RAW",16,"raw DATA.fac_id field (echoed in RESULT even when unknown)"),
     ("FAC",5,"facility slot = FAC_RAW[4:0]; meaningful only if status != DROPPED(unknown)"),
     ("TS",32,"DATA.ts_unix"),
     ("STATUS",3,"wire codes: 0 VALID, 1 HELD, 3 INVALID, 4 DROPPED (2 unused)"),
     ("REASON",16,"reason bits, see numerics.md §6"),
     ("SINCE_RESET",8,"records since this facility's last history reset, saturating at 255 (0 on the reset record)"),
     ("HIST_RESET",1,"this record starts a new history for its facility")]
U = [("REC_NO",32,""),("IN_LAST",1,""),("FRAME_ERR",1,"TLAST arrived before beat 6, record incomplete"),("REC",384,"the 48 B DATA record, byte k at bits [8k+7:8k]")]
V = H + [("INFLOW",16,"s16, 0.5 bpd"),("LEVEL",16,"s16, 0.01 %"),("PUMP_FLOW",16,"s16, 0.5 bpd"),("RECV_FLOW",16,"s16, 0.5 bpd"),
     ("DIS_PSI",16,"s16, 0.1 psi"),("PIPE_PSI",16,"s16, 0.1 psi"),("PUMP_ST",2,"0 off, 1 running, 2 fault"),
     ("WELL_ACT",8,"bit i = well slot i status==1 (0 for slots >= n_wells)"),("WELL_WATER",128,"8 x s16, slot i at [16i+15:16i]; 0 for slots >= n_wells"),
     ("FLD_OK",7,"per facility field, after hold: bit order = DATA present bits 0..6"),("WELLS_OK",1,"all configured well fields valid after hold"),
     ("PREV_LEVEL",16,"s16 LEVEL of this facility's previous accepted record"),("PREV_OK",1,"PREV_LEVEL exists (0 on a history-reset record)")]
F = H + [("FEAT0_11",192,"12 x s16 features, channel c at [16c+15:16c]"),("RULES4",4,"rule bits 0..3"),
     ("INFLOW",16,"s16 copy for countdown"),("LEVEL",16,"s16 copy for countdown"),("PUMP_RUN",1,"PUMP_ST == 1")]
M = H + [("FEAT",496,"31 x s16 features, index i at [16i+15:16i]"),("RULES4",4,""),("INFLOW",16,""),("LEVEL",16,"")]
C = H + [("FEAT",496,""),("RULES",5,"rule bits 0..4"),("CD",48,"p10 [15:0], p50 [31:16], p90 [47:32], minutes")]
L = H + [("CH3",16,"feature 3 (flow gap) for the leak rule"),("RULES",5,""),("CD",48,""),("LOGITS",64,"4 x s16, class k at [16k+15:16k]"),("WVER",8,"weights version used (0 = no model)")]
A = H + [("RULES",5,""),("CD",48,""),("LOGITS",64,""),("WVER",8,""),("CLASSES",4,"class_active bits from eog_alarm (not in RESULT)")]
BUSES = [("U","eog_unpack -> eog_validate",U),("V","eog_validate -> eog_features",V),("F","eog_features -> eog_memory",F),
         ("M","eog_memory -> eog_countdown",M),("C","eog_countdown -> eog_head",C),("L","eog_head -> eog_alarm",L),("A","eog_alarm -> eog_pack",A)]
def layout(fields):
    off=0; out=[]
    for n,w,d in fields:
        out.append((n,w,off,d)); off+=w
    return out, off
